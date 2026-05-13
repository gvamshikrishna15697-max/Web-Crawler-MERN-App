import express from "express";
import {
  publicationMeta,
  publications,
} from "../config/publications.js";

const router = express.Router();

/**
 * Stable metadata for UI dropdowns. Reads from the bundled dataset, so it
 * works even when MongoDB is reconnecting (no requireMongo).
 */
router.get("/meta", (_req, res) => {
  res.json(publicationMeta);
});

/** Full known-publisher list (lightweight — ~70 rows). */
router.get("/", (_req, res) => {
  res.json({ items: publications, total: publications.length });
});

export default router;
