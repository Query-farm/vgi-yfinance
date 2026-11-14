// The Yahoo Finance driver — pure logic, no network and no SDK. Every function takes an
// injected `get(url) => Promise<any>` so the archetype-proof tests drive it against an
// in-process fake and the worker wires the real keyless fetch client (client.ts).
//
// Three read paths, all keyless point-in-time snapshots (no cursor / no watermark — a
// finance quote or a chart pull has no cross-scan resume state):
//   history  → v8 /finance/chart/{symbol}     OHLCV time series (NO crumb needed)
//   quote    → v8 /finance/chart/{symbol}     current snapshot from the chart `meta` (NO crumb)
//   search   → v1 /finance/search?q=...        symbol lookup      (NO crumb needed)
//
// The response shapes below are Yahoo's unofficial (undocumented) JSON envelopes. They
// are defensive on purpose: any missing branch degrades to an empty result / null cell
// rather than throwing, so one thin/halted symbol never crashes a multi-symbol scan.

/** Yahoo's public query host. query2 is an equivalent alias behind the same edge. */
export const YF_HOST = "https://query1.finance.yahoo.com";

// ── history (v8 chart) ──────────────────────────────────────────────────────

export interface HistoryArgs {
  symbol: string;
  /** A named window: 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max. Ignored when start is set. */
  range: string;
  /** Candle width: 1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo. */
  interval: string;
  /** Include pre/post-market candles. */
  prepost: boolean;
  /** ISO date (YYYY-MM-DD) lower bound. When set, [start,end) overrides `range`. */
  start: string;
  /** ISO date (YYYY-MM-DD) upper bound (exclusive-ish). Defaults to now when start is set. */
  end: string;
}

export interface HistoryRow {
  symbol: string;
  /** Candle open time, epoch SECONDS. */
  timestamp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjclose: number | null;
  volume: number | null;
}

/**
 * Convert a YYYY-MM-DD date to epoch seconds (UTC midnight). Returns null for an empty or
 * malformed string, including impossible calendar dates like 2024-02-30.
 */
export function dateToEpoch(d: string): number | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== d) return null;
  return Math.floor(ms / 1000);
}

/**
 * Validate history's start/end arguments. A malformed date, or an end without a start,
 * used to be silently ignored, so the call quietly returned the default `range` window
 * instead of the dates asked for. Throws with a message naming the bad argument.
 */
export function validateHistoryDates(start: string, end: string): void {
  if (start && dateToEpoch(start) === null) {
    throw new Error(`yfinance history: start_date '${start}' is not a valid YYYY-MM-DD date`);
  }
  if (end && dateToEpoch(end) === null) {
    throw new Error(`yfinance history: end_date '${end}' is not a valid YYYY-MM-DD date`);
  }
  if (end && !start) {
    throw new Error("yfinance history: end_date requires start_date (without it the named range is used)");
  }
  if (start && end && dateToEpoch(end)! <= dateToEpoch(start)!) {
    throw new Error(`yfinance history: end_date '${end}' must be after start_date '${start}'`);
  }
}

/** Build the v8 chart URL. `start` present → period1/period2 range; else the named `range`. */
export function chartUrl(a: HistoryArgs, host: string = YF_HOST, nowMs: number = Date.now()): string {
  validateHistoryDates(a.start, a.end);
  const p = new URLSearchParams();
  p.set("interval", a.interval || "1d");
  const startEpoch = dateToEpoch(a.start);
  if (startEpoch !== null) {
    const endEpoch = dateToEpoch(a.end) ?? Math.floor(nowMs / 1000);
    p.set("period1", String(startEpoch));
    p.set("period2", String(endEpoch));
  } else {
    p.set("range", a.range || "1mo");
  }
  if (a.prepost) p.set("includePrePost", "true");
  p.set("events", "div,splits");
  return `${host}/v8/finance/chart/${encodeURIComponent(a.symbol)}?${p.toString()}`;
}

interface ChartQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}
interface ChartResult {
  meta?: { symbol?: string; regularMarketPrice?: number; regularMarketTime?: number };
  timestamp?: number[];
  indicators?: { quote?: ChartQuote[]; adjclose?: { adjclose?: (number | null)[] }[] };
}
interface ChartEnvelope {
  chart?: { result?: ChartResult[] | null; error?: { code?: string; description?: string } | null };
}

/** Map one v8 chart envelope to OHLCV rows. Surfaces Yahoo's own `error` as a throw. */
export function parseChart(json: unknown, symbol: string): HistoryRow[] {
  const env = json as ChartEnvelope;
  const err = env.chart?.error;
  if (err) throw new Error(`yfinance history(${symbol}): ${err.code ?? "error"} — ${err.description ?? "unknown"}`);
  const result = env.chart?.result?.[0];
  if (!result || !result.timestamp) return [];
  const sym = result.meta?.symbol ?? symbol;
  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0] ?? {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const at = (arr: (number | null)[] | undefined, i: number): number | null =>
    arr && arr[i] != null ? (arr[i] as number) : null;

  const rows: HistoryRow[] = [];
  for (let i = 0; i < ts.length; i++) {
    rows.push({
      symbol: sym,
      timestamp: ts[i]!,
      open: at(q.open, i),
      high: at(q.high, i),
      low: at(q.low, i),
      close: at(q.close, i),
      adjclose: at(adj, i) ?? at(q.close, i),
      volume: at(q.volume, i),
    });
  }
  // Yahoo often leaves the newest candle's close (and adjclose) null for a while — even
  // after the session ends — although open/high/low/volume are filled and the chart `meta`
  // already carries the last price. Fill that one cell from meta.regularMarketPrice when the
  // price's timestamp falls inside the candle, so "latest close" queries don't silently skip
  // to the previous day. Only the last candle is touched; older null cells stay null.
  const last = rows[rows.length - 1];
  const livePrice = result.meta?.regularMarketPrice;
  const liveTime = result.meta?.regularMarketTime;
  if (
    last &&
    last.close === null &&
    typeof livePrice === "number" &&
    Number.isFinite(livePrice) &&
    typeof liveTime === "number" &&
    liveTime >= last.timestamp
  ) {
    last.close = livePrice;
    if (last.adjclose === null) last.adjclose = livePrice;
  }
  return rows;
}

export async function fetchHistory(
  get: (url: string) => Promise<unknown>,
  a: HistoryArgs,
  host: string = YF_HOST,
  nowMs: number = Date.now(),
): Promise<HistoryRow[]> {
  return parseChart(await get(chartUrl(a, host, nowMs)), a.symbol);
}

// ── quote (keyless, backed by the v8 chart `meta` block) ────────────────────
//
// The v7 /finance/quote and v10 /finance/quoteSummary planes are now crumb-gated AND
// 401 "Unauthorized" from datacenter IPs even with a valid crumb. The v8 chart `meta`
// block, by contrast, is fully open and carries the snapshot fields we need — so a quote
// is one keyless chart request per symbol (range=1d), and `change`/`change_percent` are
// derived from price − previousClose. marketCap is NOT in `meta` and is left out rather
// than shipped as an always-null column.

export interface QuoteRow {
  symbol: string | null;
  shortName: string | null;
  longName: string | null;
  currency: string | null;
  exchange: string | null;
  quoteType: string | null;
  regularMarketPrice: number | null;
  regularMarketChange: number | null;
  regularMarketChangePercent: number | null;
  regularMarketVolume: number | null;
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketPreviousClose: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  regularMarketTime: number | null;
}

/** Split + trim a comma/space list of tickers into a clean, deduped array. */
export function parseSymbols(symbols: string): string[] {
  const seen = new Set<string>();
  for (const raw of symbols.split(/[,\s]+/)) {
    const s = raw.trim().toUpperCase();
    if (s) seen.add(s);
  }
  return [...seen];
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** Build the keyless quote URL: a 1-day chart request whose `meta` is the snapshot. */
export function quoteUrl(symbol: string, host: string = YF_HOST): string {
  return `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
}

interface ChartMeta {
  symbol?: string;
  shortName?: string;
  longName?: string;
  currency?: string;
  fullExchangeName?: string;
  exchangeName?: string;
  instrumentType?: string;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketTime?: number;
}

/**
 * Map one v8 chart envelope's `meta` block to a curated snapshot row. Returns null when
 * the envelope carries no usable meta (unknown/thin symbol) so the caller can skip it.
 */
export function parseQuoteMeta(json: unknown, symbol: string): QuoteRow | null {
  const env = json as ChartEnvelope;
  if (env.chart?.error) return null;
  const meta = env.chart?.result?.[0]?.meta as ChartMeta | undefined;
  if (!meta || meta.regularMarketPrice == null) return null;

  const price = numOrNull(meta.regularMarketPrice);
  const prev = numOrNull(meta.previousClose ?? meta.chartPreviousClose);
  const change = price != null && prev != null ? price - prev : null;
  const changePct = change != null && prev ? (change / prev) * 100 : null;

  return {
    symbol: strOrNull(meta.symbol ?? symbol),
    shortName: strOrNull(meta.shortName),
    longName: strOrNull(meta.longName),
    currency: strOrNull(meta.currency),
    exchange: strOrNull(meta.fullExchangeName ?? meta.exchangeName),
    quoteType: strOrNull(meta.instrumentType),
    regularMarketPrice: price,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    regularMarketVolume: numOrNull(meta.regularMarketVolume),
    regularMarketDayHigh: numOrNull(meta.regularMarketDayHigh),
    regularMarketDayLow: numOrNull(meta.regularMarketDayLow),
    regularMarketPreviousClose: prev,
    fiftyTwoWeekHigh: numOrNull(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: numOrNull(meta.fiftyTwoWeekLow),
    regularMarketTime: numOrNull(meta.regularMarketTime),
  };
}

/**
 * One keyless chart request per symbol, in parallel. A symbol that errors or returns no
 * meta is dropped (not a null row) so one bad ticker never fails the whole scan.
 */
/** Max Yahoo requests in flight per call. A LATERAL hands a function a whole input chunk
 *  (up to 2048 rows) at once; unbounded fan-out would trip Yahoo's rate limit and the
 *  Cloudflare Worker's per-request subrequest budget. */
export const MAX_CONCURRENCY = 8;

/** `Promise.all(items.map(fn))`, but with at most `limit` calls in flight. Order-preserving. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(runners);
  return out;
}

/** One quote per requested symbol, keyed by that symbol. A symbol whose request throws
 *  (unknown ticker, HTTP error) is absent from the map rather than failing the call. */
export async function fetchQuoteMap(
  get: (url: string) => Promise<unknown>,
  symbols: string[],
  host: string = YF_HOST,
): Promise<Map<string, QuoteRow>> {
  const rows = await mapLimit(symbols, MAX_CONCURRENCY, async (s) => {
    try {
      return parseQuoteMeta(await get(quoteUrl(s, host)), s);
    } catch {
      return null;
    }
  });
  const bySymbol = new Map<string, QuoteRow>();
  symbols.forEach((s, i) => {
    const r = rows[i];
    if (r) bySymbol.set(s, r);
  });
  return bySymbol;
}

export async function fetchQuote(
  get: (url: string) => Promise<unknown>,
  symbols: string[],
  host: string = YF_HOST,
): Promise<QuoteRow[]> {
  const bySymbol = await fetchQuoteMap(get, symbols, host);
  return symbols.flatMap((s) => bySymbol.get(s) ?? []);
}

// ── search (v1 search) ──────────────────────────────────────────────────────

export interface SearchRow {
  symbol: string | null;
  shortname: string | null;
  longname: string | null;
  exchange: string | null;
  quoteType: string | null;
  typeDisp: string | null;
  score: number | null;
}

/** Default number of search candidates per query. */
export const SEARCH_DEFAULT_COUNT = 8;

/**
 * The effective `count` for a search: NULL/undefined/non-numeric -> the default (8); any
 * number is truncated and clamped to [1, 50] (so 0 or a negative asks for 1, not 8).
 */
export function clampSearchCount(count: unknown): number {
  if (count == null) return SEARCH_DEFAULT_COUNT;
  const n = Math.trunc(Number(count));
  if (!Number.isFinite(n)) return SEARCH_DEFAULT_COUNT;
  return Math.max(1, Math.min(n, 50));
}

/** Build the v1 search URL. `count` bounds the returned equity/ETF quotes. */
export function searchUrl(query: string, count: number, host: string = YF_HOST): string {
  const p = new URLSearchParams();
  p.set("q", query);
  p.set("quotesCount", String(clampSearchCount(count)));
  p.set("newsCount", "0");
  p.set("enableFuzzyQuery", "false");
  return `${host}/v1/finance/search?${p.toString()}`;
}

interface SearchEnvelope {
  quotes?: Record<string, unknown>[];
}

/** Map one v1 search envelope to symbol-lookup rows (news is dropped). */
export function parseSearch(json: unknown): SearchRow[] {
  const env = json as SearchEnvelope;
  const quotes = env.quotes;
  if (!Array.isArray(quotes)) return [];
  return quotes.map((q) => ({
    symbol: strOrNull(q.symbol),
    shortname: strOrNull(q.shortname),
    longname: strOrNull(q.longname),
    exchange: strOrNull(q.exchDisp ?? q.exchange),
    quoteType: strOrNull(q.quoteType),
    typeDisp: strOrNull(q.typeDisp),
    score: numOrNull(q.score),
  }));
}

export async function fetchSearch(
  get: (url: string) => Promise<unknown>,
  query: string,
  count: number,
  host: string = YF_HOST,
): Promise<SearchRow[]> {
  if (!query) return [];
  return parseSearch(await get(searchUrl(query, count, host)));
}
