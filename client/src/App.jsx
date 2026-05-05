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

function App() {
  const [q, setQ] = useState("");
  const [locale, setLocale] = useState("");
  const [source, setSource] = useState("");
  /** Draft date range (inputs only; no fetch until Apply). */
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  /** Applied date range (sent to API as pubDate filter). */
  const [fromApplied, setFromApplied] = useState("");
  const [toApplied, setToApplied] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
    [q, locale, source, fromApplied, toApplied, page, limit],
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

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="titleRow">
            <h1>Sarpa Crawler</h1>
          </div>
          <p className="subtitle">
            Google News RSS scraper with URL dedupe in MongoDB. Quick run uses “yesterday” only; pick dates below to fetch a range from Google.
          </p>
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

      {error ? <div className="error">{error}</div> : null}

      <section className="tableWrap">
        <div className="tableHeader">
          <div className="muted">
            {loading ? "Loading…" : `${total.toLocaleString()} results`}
          </div>
          <div className="pager">
            <button disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Prev
            </button>
            <div className="pagerText">
              Page <b>{page}</b> / {totalPages}
            </div>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Publisher</th>
              <th>Locale</th>
              <th>Date Published</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a._id || a.url}>
                <td className="titleCell">{a.title}</td>
                <td className="nowrap">{a.source || "Unknown"}</td>
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
              </tr>
            ))}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  No articles found for these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <footer className="footer">
        <div className="muted">Backend: <a href="/health" target="_blank" rel="noreferrer">/health</a></div>
      </footer>
    </div>
  );
}

export default App;
