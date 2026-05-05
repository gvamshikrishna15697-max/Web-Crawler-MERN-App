import dotenv from "dotenv";
dotenv.config();

if (process.env.TIMEZONE) {
  process.env.TZ = process.env.TIMEZONE;
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";

import articlesRouter from "./routes/articles.js";
import scrapeRouter from "./routes/scrape.js";
import { startScheduler } from "./jobs/scheduler.js";

const app = express();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `tlsInsecure` in the URI conflicts with driver option `tlsAllowInvalidCertificates`.
 * Strip TLS-relax flags from the URI and return whether the user asked for insecure TLS.
 */
function normalizeMongoUri(rawUri) {
  let insecureFromUri = false;
  try {
    const u = new URL(rawUri);
    for (const key of ["tlsInsecure", "tlsAllowInvalidCertificates"]) {
      if (!u.searchParams.has(key)) continue;
      const v = (u.searchParams.get(key) || "").toLowerCase();
      if (v === "true" || v === "1") {
        insecureFromUri = true;
      }
      u.searchParams.delete(key);
    }
    return { uri: u.toString(), insecureFromUri };
  } catch {
    return { uri: rawUri, insecureFromUri: false };
  }
}

function mongoTlsOptions({ insecureFromUri = false } = {}) {
  const insecureEnv =
    process.env.MONGO_TLS_INSECURE === "true" ||
    process.env.MONGO_TLS_INSECURE === "1";
  const insecure = insecureFromUri || insecureEnv;
  if (insecure) {
    // eslint-disable-next-line no-console
    console.warn(
      "WARNING: Relaxed Mongo TLS (dev/troubleshooting only). Remove MONGO_TLS_INSECURE and fix the real cert/URI issue before production.",
    );
  }
  return {
    tls: true,
    tlsAllowInvalidCertificates: insecure,
    // Some Atlas / local-proxy setups raise TLS alert internal error until hostname verification is relaxed.
    ...(insecure ? { tlsAllowInvalidHostnames: true } : {}),
  };
}

/** Prefer IPv4 for SRV → Atlas; flaky IPv6 routes often surface as TLS alert internal error. Set MONGO_DNS_FAMILY=dual to use OS default. */
function mongoFamilyOption() {
  const v = (process.env.MONGO_DNS_FAMILY || "4").toLowerCase();
  if (v === "0" || v === "dual" || v === "any") return {};
  if (v === "6") return { family: 6 };
  return { family: 4 };
}

async function connectWithRetry(rawMongoUri, { attempts = 12 } = {}) {
  const { uri: mongoUri, insecureFromUri } = normalizeMongoUri(rawMongoUri);
  let lastErr;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await mongoose.connect(mongoUri, {
        ...mongoTlsOptions({ insecureFromUri }),
        ...mongoFamilyOption(),
        serverSelectionTimeoutMS: 45_000,
        connectTimeoutMS: 45_000,
        socketTimeoutMS: 120_000,
        maxPoolSize: 10,
      });
      return;
    } catch (err) {
      lastErr = err;
      try {
        if (mongoose.connection.readyState !== 0) {
          await mongoose.disconnect();
        }
      } catch {
        // ignore
      }
      const backoffMs = Math.min(60_000, 1000 * 2 ** i);
      // eslint-disable-next-line no-console
      console.error(
        `Mongo connect failed (attempt ${i + 1}/${attempts}). Retrying in ${backoffMs}ms...`,
        err?.message || err,
      );
      await sleep(backoffMs);
    }
  }

  // eslint-disable-next-line no-console
  console.error(
    "MongoDB could not connect. If you see ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: use MONGO_TLS_INSECURE=true (dev only), ensure Atlas Network Access allows your IP, and try IPv4 (default) or MONGO_DNS_FAMILY=dual. Keep tlsInsecure out of the URI — TLS options are applied in code.",
  );
  throw lastErr;
}

/** API routes need DB; avoid Vite ECONNREFUSED while Mongo is still connecting (or retrying after TLS errors). */
function requireMongo(_req, res, next) {
  if (mongoose.connection.readyState === 1) {
    next();
    return;
  }
  res.status(503).json({
    error: "DatabaseUnavailable",
    message:
      "MongoDB is not connected yet. Check the server terminal (TLS / MONGO_URI / Atlas IP allowlist). For local dev TLS issues, set MONGO_TLS_INSECURE=true in server/.env. If you see TLS alert internal errors, try IPv4 only (default) or set MONGO_DNS_FAMILY=dual.",
  });
}

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    mongo:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  }),
);
app.use("/api/articles", requireMongo, articlesRouter);
app.use("/api/scrape", requireMongo, scrapeRouter);

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "InternalServerError" });
});

const port = Number(process.env.PORT || 5000);

async function maintainMongoConnection() {
  const uri = process.env.MONGO_URI;
  if (!uri) return;
  for (;;) {
    try {
      await connectWithRetry(uri);
      // eslint-disable-next-line no-console
      console.log("MongoDB connected");
      startScheduler();
      // Stay on the cluster until the driver reports disconnect, then reconnect (was: return after first connect → permanent 503 after pool/TLS drops).
      await new Promise((resolve) => {
        mongoose.connection.once("disconnected", resolve);
      });
      // eslint-disable-next-line no-console
      console.warn("MongoDB disconnected — reconnecting…");
      await sleep(2000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err?.message || err);
      // eslint-disable-next-line no-console
      console.error("Mongo reconnect cycle in 30s...");
      await sleep(30_000);
    }
  }
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI in environment");
  }

  const twentyMin = 20 * 60 * 1000;
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Server listening on http://localhost:${port} (MongoDB connecting in background…)`,
    );
  });
  // Long range scrapes (many locales × RSS) — relax timeouts vs defaults that can cut connections early.
  server.timeout = twentyMin;
  server.headersTimeout = twentyMin + 60_000;
  if (typeof server.requestTimeout === "number") {
    server.requestTimeout = twentyMin;
  }

  void maintainMongoConnection();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

