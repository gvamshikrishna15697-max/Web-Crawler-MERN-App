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
      "WARNING: Insecure Mongo TLS (tlsInsecure removed from URI and applied as tlsAllowInvalidCertificates). Dev/troubleshooting only — do not use in production.",
    );
  }
  return {
    tls: true,
    tlsAllowInvalidCertificates: insecure,
  };
}

async function connectWithRetry(rawMongoUri, { attempts = 12 } = {}) {
  const { uri: mongoUri, insecureFromUri } = normalizeMongoUri(rawMongoUri);
  let lastErr;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await mongoose.connect(mongoUri, {
        ...mongoTlsOptions({ insecureFromUri }),
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
    "MongoDB could not connect. If TLS errors persist, keep tlsInsecure out of the URI (this app strips it) and use MONGO_TLS_INSECURE=true in server/.env for local dev only.",
  );
  throw lastErr;
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

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/articles", articlesRouter);
app.use("/api/scrape", scrapeRouter);

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "InternalServerError" });
});

const port = Number(process.env.PORT || 5000);

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI in environment");
  }

  await connectWithRetry(process.env.MONGO_URI);
  // eslint-disable-next-line no-console
  console.log("MongoDB connected");

  startScheduler();

  const twentyMin = 20 * 60 * 1000;
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${port}`);
  });
  // Long range scrapes (many locales × RSS) — relax timeouts vs defaults that can cut connections early.
  server.timeout = twentyMin;
  server.headersTimeout = twentyMin + 60_000;
  if (typeof server.requestTimeout === "number") {
    server.requestTimeout = twentyMin;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

