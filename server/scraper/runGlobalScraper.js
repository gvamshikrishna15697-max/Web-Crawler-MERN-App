import axios from "axios";
import { XMLParser } from "fast-xml-parser";

import Article from "../models/Article.js";
import { locales } from "../config/locales.js";
import { blockedPublishers } from "../config/blockedPublishers.js";
import {
  findPublication,
  normalizePublisherName,
} from "../config/publications.js";

const MS_PER_DAY = 86400000;

function startOfTodayLocal() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/** Pick Google News `when:` tier from how far back rangeStart is from now (approximate lookback). */
function computeWhenForLookback(rangeStartDate) {
  const start = rangeStartDate.getTime();
  const lookbackDays = Math.max(
    2,
    Math.ceil((Date.now() - start) / MS_PER_DAY) + 1,
  );
  if (lookbackDays <= 2) return "2d";
  if (lookbackDays <= 7) return "7d";
  if (lookbackDays <= 30) return "30d";
  return "1y";
}

function isBlockedSource(sourceText) {
  const sourceLower = (sourceText || "").toLowerCase();
  return blockedPublishers.some((b) => sourceLower.includes(b));
}

function normalizeItemSource(item) {
  const src = item?.source;
  if (!src) return "";
  if (typeof src === "string") return src;
  if (typeof src === "object" && typeof src["#text"] === "string") return src["#text"];
  return "";
}

function normalizeItems(parsed) {
  const items = parsed?.rss?.channel?.item ?? [];
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRss(url, { timeoutMs, retries }) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await axios.get(url, {
        timeout: timeoutMs,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        },
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      const backoff = 500 * 2 ** attempt;
      await sleep(backoff);
      attempt += 1;
    }
  }
}

function parseDateInput(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export async function runGlobalScraper({
  keywords = '"Sadhguru" OR "Jaggi Vasudev" OR "Isha Foundation"',
  when: whenOverride,
  rangeFrom: rangeFromInput,
  rangeTo: rangeToInput,
  timeoutMs = 15_000,
  retries = 1,
} = {}) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  const today = startOfTodayLocal();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const rf = parseDateInput(rangeFromInput);
  const rt = parseDateInput(rangeToInput);
  const rangeMode = rf != null && rt != null;

  let whenUsed;
  if (rangeMode) {
    whenUsed = whenOverride ?? computeWhenForLookback(rf);
  } else {
    whenUsed = whenOverride ?? "2d";
  }

  const encodedQuery = encodeURIComponent(`${keywords} when:${whenUsed}`);

  const stats = {
    mode: rangeMode ? "range" : "yesterday",
    whenUsed,
    startedAt: new Date().toISOString(),
    today: today.toISOString(),
    yesterday: yesterday.toISOString(),
    localesTotal: locales.length,
    localesSucceeded: 0,
    localesFailed: 0,
    fetchedItems: 0,
    acceptedItems: 0,
    upserted: 0,
    enriched: 0,
    skippedLocales: [],
    unknownPublishers: [],
  };
  const unknownPublishersSet = new Set();

  if (rangeMode) {
    stats.rangeFrom = rf.toISOString();
    stats.rangeTo = rt.toISOString();
  }

  function passesDateFilter(articleDate) {
    if (rangeMode) {
      return articleDate >= rf && articleDate < rt;
    }
    return articleDate >= yesterday && articleDate < today;
  }

  for (const locale of locales) {
    const url = `https://news.google.com/rss/search?q=${encodedQuery}&${locale.param}`;

    try {
      const resp = await fetchRss(url, { timeoutMs, retries });

      const parsed = parser.parse(resp.data);
      const items = normalizeItems(parsed);
      stats.localesSucceeded += 1;
      stats.fetchedItems += items.length;

      const ops = [];

      for (const item of items) {
        const pubDateText = item?.pubDate ? String(item.pubDate) : "";
        const articleDate = pubDateText ? new Date(pubDateText) : null;
        if (!articleDate || Number.isNaN(articleDate.getTime())) continue;

        const sourceText = normalizeItemSource(item);
        if (isBlockedSource(sourceText)) continue;

        if (!passesDateFilter(articleDate)) continue;

        const title = item?.title ? String(item.title) : "";
        const link = item?.link ? String(item.link) : "";
        if (!title || !link) continue;

        const pubMatch = findPublication(sourceText);
        const publisherKey = normalizePublisherName(sourceText);
        if (pubMatch) {
          stats.enriched += 1;
        } else if (sourceText) {
          unknownPublishersSet.add(sourceText);
        }

        stats.acceptedItems += 1;
        ops.push({
          updateOne: {
            filter: { url: link },
            update: {
              $setOnInsert: {
                title,
                source: sourceText || "Unknown",
                locale: locale.name,
                url: link,
                pubDate: articleDate,
                pubDateText,
              },
              $set: {
                publisherKey,
                country: pubMatch?.country || "",
                language: pubMatch?.language || "",
                category: pubMatch?.category || "",
              },
            },
            upsert: true,
          },
        });
      }

      if (ops.length) {
        const result = await Article.bulkWrite(ops, { ordered: false });
        stats.upserted += result.upsertedCount ?? 0;
      }
    } catch (err) {
      stats.localesFailed += 1;
      stats.skippedLocales.push(locale.name);
      // eslint-disable-next-line no-console
      console.log(`Skipped locale: ${locale.name}`, err?.message || err);
    }
  }

  // Limit the sample so this never bloats ScrapeRun.stats stored in Mongo.
  stats.unknownPublishers = [...unknownPublishersSet].sort().slice(0, 100);
  stats.unknownPublishersTotal = unknownPublishersSet.size;
  stats.finishedAt = new Date().toISOString();
  return stats;
}
