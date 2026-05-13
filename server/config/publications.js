import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dataset lives at repo root: ../../global_publications_dataset.json
 * Many entries are padded placeholders ("…Vol.3"). We drop those so they don't pollute lookups.
 */
const DATASET_PATH = path.resolve(__dirname, "..", "..", "global_publications_dataset.json");

function loadRaw() {
  try {
    const raw = fs.readFileSync(DATASET_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `Could not read publications dataset at ${DATASET_PATH}: ${err?.message || err}`,
    );
    return [];
  }
}

/**
 * Normalize a source name for matching against the dataset.
 * Lower-cased, punctuation stripped, common URL-y suffixes removed.
 * Google News RSS sources arrive as plain names like "The Hindu" or "BBC News".
 */
export function normalizePublisherName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/\.(com|in|net|org|co|news)\b.*$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|news|online|daily|times|post|magazine)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const isPaddedEntry = (entry) => /Vol\.\d+$/.test(String(entry?.name || ""));

const rawEntries = loadRaw();
/** Filtered, "real" publications (no padded Vol.N rows). */
export const publications = rawEntries.filter(
  (e) => e && typeof e.name === "string" && !isPaddedEntry(e),
);

/** Map<normalizedName, entry> for O(1) lookup at scrape time. */
const lookup = new Map();
for (const entry of publications) {
  const key = normalizePublisherName(entry.name);
  if (key && !lookup.has(key)) lookup.set(key, entry);
}

/**
 * Find publication metadata by raw source name (e.g. from Google News RSS).
 * Returns null when there is no confident match.
 */
export function findPublication(sourceName) {
  const key = normalizePublisherName(sourceName);
  if (!key) return null;
  if (lookup.has(key)) return lookup.get(key);

  // Token-overlap fallback for noisy source strings (e.g. "The Hindu - Online").
  const tokens = new Set(key.split(" ").filter(Boolean));
  if (tokens.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const [candidateKey, entry] of lookup) {
    const candTokens = candidateKey.split(" ").filter(Boolean);
    if (candTokens.length === 0) continue;
    let overlap = 0;
    for (const t of candTokens) if (tokens.has(t)) overlap += 1;
    const score = overlap / candTokens.length;
    if (score > bestScore && score >= 0.75) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/** Distinct, sorted values for UI dropdowns. */
function distinct(field) {
  const set = new Set();
  for (const p of publications) {
    if (p && typeof p[field] === "string" && p[field].trim()) set.add(p[field]);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export const publicationMeta = {
  countries: distinct("country"),
  languages: distinct("language"),
  categories: distinct("category"),
  count: publications.length,
};
