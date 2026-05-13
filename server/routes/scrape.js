import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import ScrapeRun from "../models/ScrapeRun.js";
import { isScrapeInFlight, runScrapeJob } from "../jobs/runScrapeJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Persists across nodemon restarts (snapshot writes under server/data/ must not wipe poll state). */
const JOB_SNAPSHOT_FILE = path.resolve(__dirname, "..", "data", "scrape-job-snapshots.json");

const router = express.Router();

const runLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

/** Scrape job snapshots for HTTP clients (polling); mirrored to disk. */
const jobSnapshots = new Map();

/** Latest manual-trigger job id still running (paired with scrape mutex during HTTP runs only). */
let activeManualJobId = null;

let persistTimer = null;

/** Plain JSON for Mongo-style objects (safe for disk + res.json). */
function serializeForSnapshot(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function schedulePersistJobSnapshots() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistJobSnapshotsToDisk();
  }, 80);
}

async function persistJobSnapshotsToDisk() {
  try {
    const jobs = Object.fromEntries(jobSnapshots);
    await fsPromises.mkdir(path.dirname(JOB_SNAPSHOT_FILE), { recursive: true });
    const tmp = `${JOB_SNAPSHOT_FILE}.tmp`;
    await fsPromises.writeFile(tmp, JSON.stringify({ jobs }, null, 2), "utf8");
    await fsPromises.rename(tmp, JOB_SNAPSHOT_FILE);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to persist scrape job snapshots:", err?.message || err);
  }
}

function loadPersistedJobSnapshots() {
  try {
    const raw = fs.readFileSync(JOB_SNAPSHOT_FILE, "utf8");
    const data = JSON.parse(raw);
    const jobs = data.jobs && typeof data.jobs === "object" ? data.jobs : {};
    for (const [id, snap] of Object.entries(jobs)) {
      if (snap && typeof snap === "object") jobSnapshots.set(id, snap);
    }
  } catch {
    // missing or corrupt file — start empty
  }
}

loadPersistedJobSnapshots();

function pruneJobSnapshots() {
  if (jobSnapshots.size <= 40) return;
  const keys = [...jobSnapshots.keys()].sort(
    (a, b) =>
      (jobSnapshots.get(a).startedAt ?? 0) -
      (jobSnapshots.get(b).startedAt ?? 0),
  );
  for (let i = 0; i < keys.length - 30; i += 1) {
    jobSnapshots.delete(keys[i]);
  }
  schedulePersistJobSnapshots();
}

router.post("/run", runLimiter, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasFrom = Object.prototype.hasOwnProperty.call(body, "from");
    const hasTo = Object.prototype.hasOwnProperty.call(body, "to");

    if (hasFrom !== hasTo) {
      return res.status(400).json({
        error:
          "Provide both `from` and `to` (ISO strings) for a range scrape, or omit both for yesterday-only mode.",
      });
    }

    /** Range scrape or yesterday-only — includes jobId when triggered from POST /run */
    let jobOpts = { trigger: "manual" };

    if (hasFrom && hasTo) {
      const from = new Date(String(body.from));
      const to = new Date(String(body.to));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return res.status(400).json({
          error: "Invalid `from` or `to` date. Use ISO-8601 strings.",
        });
      }
      if (from.getTime() >= to.getTime()) {
        return res.status(400).json({ error: "`from` must be before `to`." });
      }
      jobOpts = {
        trigger: "manual",
        rangeFrom: from.toISOString(),
        rangeTo: to.toISOString(),
      };
    }

    // Another manual scrape already started from this HTTP path — same job id for polling.
    if (isScrapeInFlight() && activeManualJobId) {
      return res.status(202).json({
        pending: true,
        alreadyRunning: true,
        jobId: activeManualJobId,
      });
    }
    // Cron (or unrelated) scrape in flight — do not enqueue a conflicting manual job against same mutex.
    if (isScrapeInFlight()) {
      return res.status(409).json({
        error: "ScraperBusy",
        message:
          "A scrape is already in progress (for example scheduled cron). Try again shortly or check GET /api/scrape/last.",
      });
    }

    const jobId = randomUUID();
    activeManualJobId = jobId;
    pruneJobSnapshots();
    jobSnapshots.set(jobId, {
      phase: "running",
      startedAt: Date.now(),
    });
    schedulePersistJobSnapshots();

    runScrapeJob({ ...jobOpts, jobId })
      .then((run) => {
        jobSnapshots.set(jobId, {
          phase: "success",
          run: serializeForSnapshot(run),
          finishedAt: Date.now(),
        });
      })
      .catch((err) => {
        jobSnapshots.set(jobId, {
          phase: "error",
          error: err?.message ? String(err.message) : String(err),
          finishedAt: Date.now(),
        });
      })
      .finally(() => {
        activeManualJobId = null;
        schedulePersistJobSnapshots();
      });

    return res.status(202).json({ pending: true, jobId });
  } catch (err) {
    next(err);
  }
});

router.get("/last", async (_req, res, next) => {
  try {
    const run = await ScrapeRun.findOne().sort({ createdAt: -1 }).lean();
    res.json({ run });
  } catch (err) {
    next(err);
  }
});

router.get("/job/:jobId", async (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    const snap = jobSnapshots.get(jobId);

    if (snap?.phase === "success") {
      return res.json(
        JSON.parse(JSON.stringify({ jobId, ...snap })),
      );
    }
    if (snap?.phase === "error") {
      return res.json(
        JSON.parse(JSON.stringify({ jobId, ...snap })),
      );
    }
    if (snap?.phase === "running" && isScrapeInFlight()) {
      return res.json(
        JSON.parse(JSON.stringify({ jobId, ...snap })),
      );
    }

    const runDoc = await ScrapeRun.findOne({ jobId }).sort({ createdAt: -1 }).lean();
    if (runDoc) {
      const recovered =
        runDoc.status === "success"
          ? {
              phase: "success",
              run: serializeForSnapshot(runDoc),
              finishedAt: new Date(runDoc.finishedAt || Date.now()).getTime(),
            }
          : {
              phase: "error",
              error: runDoc.error || "Scrape failed",
              finishedAt: new Date(runDoc.finishedAt || Date.now()).getTime(),
            };
      jobSnapshots.set(jobId, recovered);
      schedulePersistJobSnapshots();
      return res.json(JSON.parse(JSON.stringify({ jobId, ...recovered })));
    }

    if (snap?.phase === "running") {
      return res.json(
        JSON.parse(
          JSON.stringify({
            jobId,
            phase: "error",
            error:
              "Scrape interrupted before the run was recorded (e.g. server restarted mid-job). Check GET /api/scrape/last.",
            finishedAt: Date.now(),
          }),
        ),
      );
    }

    return res.status(404).json({ error: "UnknownOrExpiredJob" });
  } catch (err) {
    next(err);
  }
});

export default router;
