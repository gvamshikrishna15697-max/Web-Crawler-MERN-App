import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/** Network-level failures (API down, wrong port) — DevTools often shows no status code. */
async function apiFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    const msg = e?.message || String(e);
    const isNetwork =
      e?.name === "TypeError" ||
      /Failed to fetch|NetworkError|ECONNREFUSED|Load failed|network/i.test(msg);
    if (isNetwork) {
      throw new Error(
        `Cannot reach the API (${url}). Start the backend on port 5000: from the project root run \`npm run dev\` (starts server + client), or in a second terminal run \`npm run dev\` inside the \`server\` folder. Original error: ${msg}`,
      );
    }
    throw e;
  }
}

async function fetchJson(url, init) {
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await apiFetch(url, init);
    if (res.ok) {
      return res.json();
    }
    const text = await res.text().catch(() => "");
    const isDbBootWindow =
      res.status === 503 &&
      /DatabaseUnavailable|MongoDB is not connected yet/i.test(text || "");
    if (isDbBootWindow && attempt < maxRetries) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  throw new Error("API retry budget exhausted");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST /api/scrape/run returns 202 + jobId; work runs in background (avoids dev-proxy timeouts). */
async function postScrapeJob(body) {
  const res = await apiFetch("/api/scrape/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = [data.error, data.message].filter(Boolean).join(" — ");
    const text = detail || (await res.text().catch(() => ""));
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  if (!data.jobId) {
    throw new Error("Server did not return a job id");
  }
  return data.jobId;
}

const POLL_IDLE_MS = 30 * 60 * 1000;
/** Wide ranges hit every locale’s RSS in sequence — often well over 30 minutes. */
const POLL_RANGE_MS = 6 * 60 * 60 * 1000;

async function pollScrapeJob(jobId, { timeoutMs = POLL_IDLE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await fetchJson(`/api/scrape/job/${jobId}`);
    if (st.phase === "success") return st.run ?? null;
    if (st.phase === "error") {
      throw new Error(st.error || "Scrape failed");
    }
    await sleep(1600);
  }
  const mins = Math.round(timeoutMs / 60_000);
  throw new Error(
    `Timed out after ${mins}m waiting for this scrape. Large ranges (many locales × RSS) can take hours; the job may still be running on the server — try GET /api/scrape/last or refresh later.`,
  );
}

/* ──────────────────────────── Export helpers ──────────────────────────── */

function escCsv(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

function exportFileName(ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `sarpa-articles-${ts}.${ext}`;
}

function articleRows(articles) {
  return articles.map((a) => ({
    title: a.title || "",
    source: a.source || "Unknown",
    locale: a.locale || "",
    pubDate: a.pubDate || a.pubDateText || "",
    url: a.url || "",
  }));
}

function fmtDateForExport(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function exportCsv(articles) {
  const rows = articleRows(articles);
  const header = "Title,Publisher,Locale,Date Published,URL";
  const lines = rows.map((r) =>
    [r.title, r.source, r.locale, fmtDateForExport(r.pubDate), r.url]
      .map(escCsv)
      .join(","),
  );
  const csv = [header, ...lines].join("\r\n");
  downloadBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    exportFileName("csv"),
  );
}

function buildExportTable(articles) {
  const rows = articleRows(articles);
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  let html = `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;width:100%">
<thead><tr style="background:#4f46e5;color:#fff">
  <th style="text-align:left">Title</th>
  <th style="text-align:left">Publisher</th>
  <th style="text-align:left">Locale</th>
  <th style="text-align:left">Date Published</th>
  <th style="text-align:left">URL</th>
</tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
  <td>${esc(r.title)}</td>
  <td>${esc(r.source)}</td>
  <td>${esc(r.locale)}</td>
  <td>${esc(fmtDateForExport(r.pubDate))}</td>
  <td><a href="${esc(r.url)}">${esc(r.url)}</a></td>
</tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function exportXls(articles) {
  const table = buildExportTable(articles);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel"
xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<!--[if gte mso 9]><xml>
<x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Articles</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>
</xml><![endif]-->
<style>
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; }
  th { background: #4f46e5; color: #fff; font-weight: bold; }
</style></head><body>
${table}
</body></html>`;
  downloadBlob(
    new Blob([html], { type: "application/vnd.ms-excel" }),
    exportFileName("xls"),
  );
}

function buildTableExportPrintHtml(articles) {
  const table = buildExportTable(articles);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Sarpa Crawler - Articles Export</title>
<style>
  @page { size: landscape; margin: 12mm; }
  body { margin: 0; font-family: Arial, sans-serif; }
  h2 { margin: 0 0 12px; font-size: 18px; }
  .meta { font-size: 12px; color: #666; margin-bottom: 14px; }
  table { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  td, th { word-break: break-word; }
  td:last-child { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
</style></head><body>
<h2>Sarpa Crawler &mdash; Articles Export</h2>
<p class="meta">${articles.length} articles &bull; Generated ${new Date().toLocaleString()}</p>
${table}
</body></html>`;
}

/** Print HTML without pop-ups (hidden iframe in the same page). */
function printHtmlViaIframe(html) {
  let iframe = document.getElementById("sarpa-print-frame");
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "sarpa-print-frame";
    iframe.setAttribute(
      "style",
      "position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden",
    );
    iframe.setAttribute("title", "Print frame");
    document.body.appendChild(iframe);
  }
  const win = iframe.contentWindow;
  const doc = win.document;
  doc.open();
  doc.write(html);
  doc.close();
  const runPrint = () => {
    try {
      win.focus();
      win.print();
    } catch {
      // ignore — file download still succeeded
    }
  };
  if (doc.readyState === "complete") {
    setTimeout(runPrint, 350);
  } else {
    iframe.onload = () => setTimeout(runPrint, 350);
  }
}

function exportPdf(articles) {
  const html = buildTableExportPrintHtml(articles);
  downloadBlob(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    exportFileName("html"),
  );
  printHtmlViaIframe(html);
}

function articleKey(a) {
  return String(a._id || a.url || "");
}

function buildArticleDetailCards(articles) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return articles
    .map((a, i) => {
      const title = a.title || "Untitled";
      const source = a.source || "Unknown";
      const locale = a.locale || "—";
      const date = fmtDateForExport(a.pubDate || a.pubDateText) || "—";
      const url = a.url || "";
      const meta = [a.category, a.country].filter(Boolean).join(" · ");
      return `<article class="card">
  <div class="card-num">${i + 1}</div>
  <h3 class="card-title">${esc(title)}</h3>
  <dl class="card-meta">
    <div><dt>Publisher</dt><dd>${esc(source)}</dd></div>
    <div><dt>Locale</dt><dd>${esc(locale)}</dd></div>
    <div><dt>Published</dt><dd>${esc(date)}</dd></div>
    ${meta ? `<div><dt>Tags</dt><dd>${esc(meta)}</dd></div>` : ""}
    ${url ? `<div class="full"><dt>Link</dt><dd><a href="${esc(url)}">${esc(url)}</a></dd></div>` : ""}
  </dl>
</article>`;
    })
    .join("\n");
}

function buildSingleArticlePrintHtml(articles) {
  const cards = buildArticleDetailCards(articles);
  const label =
    articles.length === 1 ? "Article" : `${articles.length} articles`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Sarpa Crawler — ${label}</title>
<style>
  @page { margin: 14mm; }
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; color: #111; line-height: 1.45; }
  .header { font-family: Arial, sans-serif; border-bottom: 2px solid #4f46e5; padding-bottom: 10px; margin-bottom: 20px; }
  .header h1 { margin: 0; font-size: 20px; color: #4f46e5; }
  .header p { margin: 6px 0 0; font-size: 12px; color: #555; }
  .card { page-break-inside: avoid; border: 1px solid #ddd; border-radius: 8px; padding: 16px 18px; margin-bottom: 18px; background: #fafafa; }
  .card-num { font-family: Arial, sans-serif; font-size: 11px; font-weight: 700; color: #4f46e5; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .card-title { margin: 0 0 12px; font-size: 17px; line-height: 1.35; }
  .card-meta { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; font-family: Arial, sans-serif; font-size: 12px; }
  .card-meta dt { margin: 0; font-weight: 600; color: #444; }
  .card-meta dd { margin: 2px 0 0; color: #111; }
  .card-meta .full { grid-column: 1 / -1; }
  .card-meta a { color: #4338ca; word-break: break-all; }
</style></head><body>
<div class="header">
  <h1>Sarpa Crawler</h1>
  <p>${label} &bull; Generated ${new Date().toLocaleString()}</p>
</div>
${cards}
</body></html>`;
}

function safeFilenameFromTitle(title, index) {
  const slug =
    String(title || "article")
      .slice(0, 72)
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "article";
  return index != null ? `sarpa-${slug}-${index + 1}` : `sarpa-${slug}`;
}

const PDF_READY_NOTICE =
  "HTML file downloaded. Use the print dialog → Save as PDF, or open the downloaded .html file and print from there.";

/**
 * Download printable HTML and open the system print dialog (no pop-up window).
 * @returns {{ ok: boolean }}
 */
function exportArticlePdf(article, { index } = {}) {
  if (!article) return { ok: false };
  const html = buildSingleArticlePrintHtml([article]);
  const filename = `${safeFilenameFromTitle(article.title, index)}.html`;
  downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), filename);
  printHtmlViaIframe(html);
  return { ok: true };
}

/** Multiple articles: one combined HTML file + one print dialog. */
function exportSelectedArticlesPdfCombined(articles) {
  if (!articles.length) return { ok: false };
  const html = buildSingleArticlePrintHtml(articles);
  const filename =
    articles.length === 1
      ? `${safeFilenameFromTitle(articles[0].title)}.html`
      : `sarpa-${articles.length}-articles.html`;
  downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), filename);
  printHtmlViaIframe(html);
  return { ok: true };
}

function exportDocx(articles) {
  const table = buildExportTable(articles);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; }
  th { background: #4f46e5; color: #fff; }
  td:last-child { max-width: 200px; word-break: break-all; }
</style></head><body>
<h2>Sarpa Crawler &mdash; Articles Export</h2>
<p style="font-size:12px;color:#666">${articles.length} articles &bull; Generated ${new Date().toLocaleString()}</p>
${table}
</body></html>`;
  downloadBlob(
    new Blob([html], { type: "application/msword" }),
    exportFileName("doc"),
  );
}

/* ──────────────────────────────────────────────────────────────────────── */

/** Open native date UI from a user gesture (whole bar, not only the typed segment). */
function tryOpenDatePicker(input) {
  if (!input) return;
  if (typeof input.showPicker === "function") {
    try {
      input.showPicker();
      return;
    } catch {
      // NotAllowedError / NotSupportedError — fall back to focus
    }
  }
  input.focus();
}

function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString();
}

/** e.g. "May 5" — month name + day (locale-aware), for quick scanning. */
function formatDateMonthDay(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const s = dt.toLocaleString(undefined, { month: "long", day: "numeric" });
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** Calendar day from input `type="date"` (YYYY-MM-DD). */
function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function localDayStartIso(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** Exclusive range end: midnight at the start of the day after `ymd` (local). */
function localDayAfterEndIso(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString();
}

function appliedFromToApiIso(value) {
  if (!value) return null;
  if (isYmd(value)) return localDayStartIso(value);
  return new Date(value).toISOString();
}

function appliedToToApiIso(value) {
  if (!value) return null;
  if (isYmd(value)) return localDayAfterEndIso(value);
  return new Date(value).toISOString();
}

function buildPagePills({ page, totalPages }) {
  const clamp = (n) => Math.max(1, Math.min(totalPages, n));
  const uniqSorted = (arr) => [...new Set(arr)].sort((a, b) => a - b);
  if (totalPages <= 1) return [];
  if (totalPages <= 10) return uniqSorted(Array.from({ length: totalPages }, (_, i) => i + 1));

  const first = [1, 2, 3, 4];
  const last = [totalPages - 2, totalPages - 1, totalPages];
  const mid = [clamp(page - 1), clamp(page), clamp(page + 1)].filter(
    (p) => p >= 5 && p <= totalPages - 3,
  );

  const pages = uniqSorted([...first, ...mid, ...last]).filter(
    (p) => p >= 1 && p <= totalPages,
  );

  /** @type {(number | \"…\")[]} */
  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    const cur = pages[i];
    const prev = pages[i - 1];
    if (prev != null && cur - prev > 1) out.push("…");
    out.push(cur);
  }
  return out;
}

function buildPagePillItems({ page, totalPages }) {
  const pills = buildPagePills({ page, totalPages });
  /** @type {{ type: 'page', page: number, key: string } | { type: 'dots', key: string }} */
  const items = [];
  let lastPage = null;
  for (const p of pills) {
    if (p === "…") {
      items.push({ type: "dots", key: `dots-${lastPage ?? "start"}-${page}-${totalPages}` });
      continue;
    }
    items.push({ type: "page", page: p, key: `page-${p}` });
    lastPage = p;
  }
  return items;
}

function todayYmdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yesterdayYmdLocal() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildArticleQuery(params) {
  const {
    q,
    locale,
    source,
    fromApplied,
    toApplied,
    page,
    limit,
  } = params;
  const search = new URLSearchParams();
  if (q) search.set("q", q);
  if (locale) search.set("locale", locale);
  if (source) search.set("source", source);
  if (fromApplied) search.set("from", appliedFromToApiIso(fromApplied));
  if (toApplied) search.set("to", appliedToToApiIso(toApplied));
  search.set("page", String(page));
  search.set("limit", String(limit));
  search.set("sort", "pubDateDesc");
  return search.toString();
}

const THEME_KEY = "wc.theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage errors (private mode etc.)
  }
  return "light";
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const [q, setQ] = useState("");
  const [locale, setLocale] = useState("");
  const [source, setSource] = useState("");
  /** Draft date range (inputs only; no fetch until Apply). */
  const [fromDraft, setFromDraft] = useState(() => yesterdayYmdLocal());
  const [toDraft, setToDraft] = useState(() => todayYmdLocal());
  /** Applied date range (sent to API as pubDate filter). */
  const [fromApplied, setFromApplied] = useState("");
  const [toApplied, setToApplied] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [lastRun, setLastRun] = useState(null);
  const [running, setRunning] = useState(false);
  const fromDateRef = useRef(null);
  const toDateRef = useRef(null);

  const queryString = useMemo(
    () =>
      buildArticleQuery({
        q,
        locale,
        source,
        fromApplied,
        toApplied,
        page,
        limit,
      }),
    [
      q,
      locale,
      source,
      fromApplied,
      toApplied,
      page,
      limit,
    ],
  );

  async function load(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const qs = buildArticleQuery({
        q: overrides.q ?? q,
        locale: overrides.locale ?? locale,
        source: overrides.source ?? source,
        fromApplied:
          overrides.fromApplied !== undefined ? overrides.fromApplied : fromApplied,
        toApplied: overrides.toApplied !== undefined ? overrides.toApplied : toApplied,
        page: overrides.page ?? page,
        limit: overrides.limit ?? limit,
      });
      const data = await fetchJson(`/api/articles?${qs}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadLastRun() {
    try {
      const data = await fetchJson("/api/scrape/last");
      setLastRun(data.run || null);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadLastRun();
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  function resetToFirstPage() {
    setPage(1);
  }

  function applyDateFilter() {
    if (fromDraft && toDraft && toDraft < fromDraft) {
      setError('"To" must be on or after "From".');
      return;
    }
    setError("");
    setFromApplied(fromDraft);
    setToApplied(toDraft);
    setPage(1);
  }

  function clearDateFilter() {
    setError("");
    setFromDraft("");
    setToDraft("");
    setFromApplied("");
    setToApplied("");
    setPage(1);
  }

  async function runScraperYesterday() {
    setRunning(true);
    setError("");
    try {
      const jobId = await postScrapeJob({});
      const run = await pollScrapeJob(jobId);
      setLastRun(run);
      await load();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }

  async function scrapeDateRangeFromGoogle() {
    if (!fromDraft || !toDraft) {
      setError("Set both From and To, then fetch from Google for that range.");
      return;
    }
    if (toDraft < fromDraft) {
      setError('"To" must be on or after "From".');
      return;
    }
    setRunning(true);
    setError("");
    try {
      const fromIso = localDayStartIso(fromDraft);
      const toIso = localDayAfterEndIso(toDraft);
      const jobId = await postScrapeJob({ from: fromIso, to: toIso });
      const run = await pollScrapeJob(jobId, { timeoutMs: POLL_RANGE_MS });
      setLastRun(run);
      setFromApplied(fromDraft);
      setToApplied(toDraft);
      setPage(1);
      await load({ fromApplied: fromDraft, toApplied: toDraft, page: 1 });
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }

  const [exporting, setExporting] = useState(false);
  /** id/url → article; persists across pages for multi-select export */
  const [selectedArticles, setSelectedArticles] = useState({});

  const selectedList = useMemo(
    () => Object.values(selectedArticles),
    [selectedArticles],
  );
  const selectedCount = selectedList.length;

  const pageKeys = useMemo(
    () => items.map((a) => articleKey(a)).filter(Boolean),
    [items],
  );
  const allPageSelected =
    pageKeys.length > 0 && pageKeys.every((k) => selectedArticles[k]);
  const somePageSelected =
    pageKeys.some((k) => selectedArticles[k]) && !allPageSelected;

  function toggleArticleSelection(article) {
    const key = articleKey(article);
    if (!key) return;
    setSelectedArticles((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = article;
      return next;
    });
  }

  function toggleSelectAllOnPage() {
    setSelectedArticles((prev) => {
      const next = { ...prev };
      if (allPageSelected) {
        for (const k of pageKeys) delete next[k];
      } else {
        for (const a of items) {
          const k = articleKey(a);
          if (k) next[k] = a;
        }
      }
      return next;
    });
  }

  function clearArticleSelection() {
    setSelectedArticles({});
  }

  function downloadSelectedArticlesPdf() {
    if (selectedCount === 0) {
      setNotice("");
      setError("Select one or more articles using the checkboxes, then click PDF.");
      return;
    }
    setError("");
    const list = selectedList;
    const result =
      list.length === 1
        ? exportArticlePdf(list[0])
        : exportSelectedArticlesPdfCombined(list);
    if (!result.ok) {
      setNotice("");
      setError("Could not export PDF for the selected articles.");
      return;
    }
    setNotice(
      list.length === 1
        ? PDF_READY_NOTICE
        : `${list.length} articles in one file. ${PDF_READY_NOTICE}`,
    );
  }

  async function handlePdfToolbarClick() {
    setNotice("");
    setError("");
    if (selectedCount > 0) {
      downloadSelectedArticlesPdf();
      return;
    }
    setExporting(true);
    try {
      const all = await fetchAllForExport();
      if (all.length === 0) {
        setError("No articles to export for the current filters.");
        return;
      }
      exportPdf(all);
      setNotice(PDF_READY_NOTICE);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setExporting(false);
    }
  }

  function downloadOneArticlePdf(article) {
    setError("");
    const result = exportArticlePdf(article);
    if (!result.ok) {
      setNotice("");
      setError("Could not export this article as PDF.");
      return;
    }
    setNotice(PDF_READY_NOTICE);
  }

  async function fetchAllForExport() {
    const qs = buildArticleQuery({
      q,
      locale,
      source,
      fromApplied,
      toApplied,
      page: 1,
      limit: 5000,
    });
    const data = await fetchJson(`/api/articles?${qs}`);
    return data.items || [];
  }

  async function handleExport(exportFn) {
    setExporting(true);
    setError("");
    try {
      const all = await fetchAllForExport();
      if (all.length === 0) {
        setError("No articles to export for the current filters.");
        return;
      }
      exportFn(all);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pagePillItems = useMemo(
    () => buildPagePillItems({ page, totalPages }),
    [page, totalPages],
  );
  const pageStart = total > 0 ? (page - 1) * limit + 1 : 0;
  const pageEnd = total > 0 ? Math.min(total, page * limit) : 0;

  function goToPage(p) {
    const next = Math.max(1, Math.min(totalPages, Number(p) || 1));
    setPage(next);
  }

  function renderPaginationBar({ compact = false } = {}) {
    if (totalPages <= 1) return null;
    return (
      <div className={`pagerBar ${compact ? "compact" : ""}`}>
        <button
          className="pagerBtn"
          disabled={page <= 1 || loading}
          onClick={() => goToPage(page - 1)}
        >
          Prev
        </button>

        <div className="pagerPills" aria-label="Pagination">
          {pagePillItems.map((it) =>
            it.type === "dots" ? (
              <span key={it.key} className="pagerDots" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={it.key}
                type="button"
                className={`pagerPill ${it.page === page ? "active" : ""}`}
                disabled={loading || it.page === page}
                onClick={() => goToPage(it.page)}
              >
                {it.page}
              </button>
            ),
          )}
        </div>

        <button
          className="pagerBtn"
          disabled={page >= totalPages || loading}
          onClick={() => goToPage(page + 1)}
        >
          Next
        </button>

        {!compact ? (
          <div className="pagerText">
            Page <b>{page}</b> / {totalPages}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="titleRow">
            <div className="brand">
              <span className="brandLogo" aria-hidden="true">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M7 7.5c0-2 2-3.5 5-3.5 2.8 0 5 .9 5 3 0 1.6-1.4 2.2-2.8 2.7-1.9.7-3.7 1.1-3.7 2.8 0 1.8 2 2.2 3.9 2.8 1.7.5 3.6 1.1 3.6 3 0 2.1-2.4 3.2-5.5 3.2-3.2 0-5.5-1.3-5.5-3.4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M9.2 6.9h.01M10.6 6.9h.01"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M11.6 8.2c-.3.4-.7.7-1.2.7-.5 0-.9-.3-1.2-.7"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <h1 className="brandTitle">Sarpa Crawler</h1>
            </div>
            <button
              type="button"
              className="themeToggle"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span className="themeToggleIcon" aria-hidden="true">
                {theme === "dark" ? "☀" : "☾"}
              </span>
              <span>{theme === "dark" ? "Light" : "Dark"}</span>
            </button>
          </div>
          
        </div>

        <div className="runCard">
          <div className="runMeta">
            <div className="runLabel">Last run</div>
            <div className="runValue">
              {lastRun?.finishedAt
                ? `${formatDateMonthDay(lastRun.finishedAt)} • ${formatDate(lastRun.finishedAt)}`
                : "—"}
            </div>
            <div className={`pill ${lastRun?.status === "success" ? "ok" : "warn"}`}>
              {lastRun?.status || "unknown"}
            </div>
          </div>

          <div className="runActions">
            <button className="primary" disabled={running} onClick={runScraperYesterday}>
              {running ? "Scraping…" : "Run scraper (yesterday only)"}
            </button>
          </div>
        </div>
      </header>

      <section className="filters">
        <div className="filtersTop">
          <div className="field">
            <label>Search title</label>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                resetToFirstPage();
              }}
              placeholder="e.g. Sadhguru"
            />
          </div>

          <div className="field">
            <label>Locale</label>
            <input
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value);
                resetToFirstPage();
              }}
              placeholder="e.g. English (India)"
            />
          </div>

          <div className="field">
            <label>Source</label>
            <input
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                resetToFirstPage();
              }}
              placeholder="e.g. The Hindu"
            />
          </div>
        </div>

        <div className="field">
          <label>Published date range (calendar days)</label>
          <div className="dateRow">
            <div
              className="datePickerShell"
              onClick={() => tryOpenDatePicker(fromDateRef.current)}
              role="presentation"
            >
              <input
                ref={fromDateRef}
                type="date"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
                aria-label="From date"
              />
            </div>
            <span className="dateSep">→</span>
            <div
              className="datePickerShell"
              onClick={() => tryOpenDatePicker(toDateRef.current)}
              role="presentation"
            >
              <input
                ref={toDateRef}
                type="date"
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
                aria-label="To date"
              />
            </div>
          </div>
          <p className="fieldHint">
            <strong>Filter stored articles</strong> — query Mongo only. <strong>Fetch from Google</strong> — background
            job with status polling (large ranges can take many minutes). The <strong>To</strong> day is included; the
            API uses midnight after that day as the exclusive end. RSS lookback is limited (tiers up to{" "}
            <code>when:1y</code>).
          </p>
          <div className="dateActions">
            <button type="button" className="secondary" onClick={applyDateFilter}>
              Filter stored articles
            </button>
            <button
              type="button"
              className="primary narrow"
              disabled={running || !fromDraft || !toDraft}
              onClick={scrapeDateRangeFromGoogle}
            >
              {running ? "Scraping…" : "Fetch from Google for this range"}
            </button>
            <button type="button" className="ghost" onClick={clearDateFilter}>
              Clear dates
            </button>
          </div>
        </div>

        <div className="field fieldRowsLimit">
          <label>Rows</label>
          <select
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              resetToFirstPage();
            }}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
      </section>

      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      {renderPaginationBar()}

      <section className="tableWrap">
        <div className="tableHeader">
          <div className="muted">
            {loading
              ? "Loading…"
              : total > 0
                ? `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()} results`
                : "0 results"}
          </div>
          <div className="exportBar">
            <button
              type="button"
              className="exportBtn"
              disabled={exporting || loading || total === 0}
              onClick={() => handleExport(exportCsv)}
              title="Download as CSV"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              CSV
            </button>
            <button
              type="button"
              className="exportBtn exportBtnSheets"
              disabled={exporting || loading || total === 0}
              onClick={() => handleExport(exportXls)}
              title="Download as Excel spreadsheet (.xls) — opens in Excel, LibreOffice, or upload to Google Sheets"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
              Excel / Sheets
            </button>
            <button
              type="button"
              className={`exportBtn ${selectedCount > 0 ? "exportBtnPdfActive" : ""}`}
              disabled={exporting || loading || total === 0}
              onClick={handlePdfToolbarClick}
              title={
                selectedCount > 0
                  ? `Export ${selectedCount} selected article(s) as PDF (HTML download + print dialog)`
                  : "Export all filtered articles as PDF (HTML download + print dialog)"
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              PDF{selectedCount > 0 ? ` (${selectedCount})` : ""}
            </button>
            <button
              type="button"
              className="exportBtn"
              disabled={exporting || loading || total === 0}
              onClick={() => handleExport(exportDocx)}
              title="Download as Word document (.doc)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              Word
            </button>
            {exporting && <span className="muted">Exporting…</span>}
          </div>
        </div>

        {selectedCount > 0 ? (
          <div className="selectionBar">
            <span className="selectionCount">
              {selectedCount} article{selectedCount === 1 ? "" : "s"} selected
            </span>
            <div className="selectionActions">
              <button
                type="button"
                className="exportBtn selectionPdfBtn"
                onClick={downloadSelectedArticlesPdf}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                Export selected as PDF ({selectedCount})
              </button>
              <button type="button" className="ghost selectionClearBtn" onClick={clearArticleSelection}>
                Clear selection
              </button>
            </div>
          </div>
        ) : null}

        <table className="table">
          <thead>
            <tr>
              <th className="colSelect" scope="col" title="Select articles for PDF download">
                <span className="colSelectLabel">Select</span>
                <input
                  type="checkbox"
                  className="rowCheckbox"
                  checked={allPageSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = somePageSelected;
                  }}
                  onChange={toggleSelectAllOnPage}
                  disabled={loading || items.length === 0}
                  aria-label="Select all articles on this page"
                  title="Select all on this page"
                />
              </th>
              <th scope="col">Title</th>
              <th>Publisher</th>
              <th>Locale</th>
              <th>Date Published</th>
              <th>URL</th>
              <th className="colActions">PDF</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const key = articleKey(a);
              const isSelected = Boolean(key && selectedArticles[key]);
              return (
              <tr key={key || a.url} className={isSelected ? "rowSelected" : ""}>
                <td className="colSelect">
                  <input
                    type="checkbox"
                    className="rowCheckbox"
                    checked={isSelected}
                    onChange={() => toggleArticleSelection(a)}
                    aria-label={`Select article: ${a.title || "Untitled"}`}
                  />
                </td>
                <td className="titleCell">{a.title}</td>
                <td className="publisherCell">
                  <div className="publisherName">{a.source || "Unknown"}</div>
                  {a.category || a.country ? (
                    <div className="publisherMeta">
                      {a.category ? (
                        <span className="metaBadge">{a.category}</span>
                      ) : null}
                      {a.country ? (
                        <span className="metaBadge metaBadgeCountry">{a.country}</span>
                      ) : null}
                    </div>
                  ) : null}
                </td>
                <td className="nowrap">{a.locale}</td>
                <td className="pubDateCell">
                  {formatDate(a.pubDate || a.pubDateText) ? (
                    <>
                      <div className="pubDateFriendly">
                        {formatDateMonthDay(a.pubDate || a.pubDateText)}
                      </div>
                      <div className="pubDateDetail">
                        {formatDate(a.pubDate || a.pubDateText)}
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="urlCell">
                  <a href={a.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
                <td className="colActions">
                  <button
                    type="button"
                    className="rowPdfBtn"
                    onClick={() => downloadOneArticlePdf(a)}
                    title="Export this article as PDF (downloads HTML + opens print dialog)"
                    aria-label="Export PDF"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  </button>
                </td>
              </tr>
            );
            })}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No articles found for these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {renderPaginationBar()}

      <footer className="footer">
        <div className="muted">Backend: <a href="/health" target="_blank" rel="noreferrer">/health</a></div>
      </footer>
    </div>
  );
}

export default App;
