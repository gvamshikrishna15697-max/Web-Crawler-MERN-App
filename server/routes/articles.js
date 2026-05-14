import express from "express";
import Article from "../models/Article.js";
import { readSnapshotIfExists, writeArticlesSnapshot } from "../scraper/snapshot.js";
import {
  findPublication,
  normalizePublisherName,
} from "../config/publications.js";

const router = express.Router();

/**
 * Escape user input before embedding in a regex (avoids ReDoS / accidental wildcards).
 * Workspace data is ~10k+ articles, so the regex still runs against the index when anchored.
 */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.get("/", async (req, res, next) => {
  try {
    const {
      from,
      to,
      locale,
      source,
      q,
      country,
      language,
      category,
      page = "1",
      limit = "50",
      sort = "pubDateDesc",
    } = req.query;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(5000, Math.max(1, Number(limit) || 50));

    const filter = {};
    if (from || to) {
      filter.pubDate = {};
      if (from) filter.pubDate.$gte = new Date(String(from));
      if (to) filter.pubDate.$lt = new Date(String(to));
    }
    if (locale) filter.locale = { $regex: escapeRegex(String(locale)), $options: "i" };
    if (source) filter.source = { $regex: escapeRegex(String(source)), $options: "i" };
    if (country) filter.country = String(country);
    if (language) filter.language = String(language);
    if (category) filter.category = String(category);
    if (q) filter.title = { $regex: escapeRegex(String(q)), $options: "i" };

    const sortMap = {
      pubDateDesc: { pubDate: -1, createdAt: -1 },
      pubDateAsc: { pubDate: 1, createdAt: 1 },
      createdDesc: { createdAt: -1 },
    };

    const sortObj = sortMap[String(sort)] ?? sortMap.pubDateDesc;

    const [items, total] = await Promise.all([
      Article.find(filter)
        .sort(sortObj)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Article.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * One-shot enrichment for rows scraped before publisher metadata existed.
 * Idempotent: only touches articles missing `category` whose source matches the dataset.
 */
router.post("/backfill-publisher-meta", async (_req, res, next) => {
  try {
    const cursor = Article.find(
      { $or: [{ category: { $exists: false } }, { category: "" }] },
      { source: 1 },
    )
      .lean()
      .cursor();

    const ops = [];
    let scanned = 0;
    let matched = 0;
    for await (const doc of cursor) {
      scanned += 1;
      const match = findPublication(doc.source);
      if (!match) continue;
      matched += 1;
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              publisherKey: normalizePublisherName(doc.source),
              country: match.country || "",
              language: match.language || "",
              category: match.category || "",
            },
          },
        },
      });
      if (ops.length >= 500) {
        await Article.bulkWrite(ops, { ordered: false });
        ops.length = 0;
      }
    }
    if (ops.length) await Article.bulkWrite(ops, { ordered: false });

    res.json({ scanned, matched });
  } catch (err) {
    next(err);
  }
});

router.get("/export.json", async (req, res, next) => {
  try {
    const snapshot = await readSnapshotIfExists();
    if (snapshot) return res.json(snapshot);

    const generated = await writeArticlesSnapshot({
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
    });
    return res.json(generated);
  } catch (err) {
    next(err);
  }
});

export default router;

