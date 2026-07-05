// The Yahoo Finance driver — pure logic, no network and no SDK. Every function takes an
// injected `get(url) => Promise<any>` so the archetype-proof tests drive it against an
// in-process fake and the worker wires the real crumb/cookie client (client.ts).
//
// Three read paths, all keyless point-in-time snapshots (no cursor / no watermark — a
// finance quote or a chart pull has no cross-scan resume state):
//   history  → v8 /finance/chart/{symbol}     OHLCV time series (NO crumb needed)
//   quote    → v7 /finance/quote?symbols=...   current snapshot   (crumb-gated)
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

/** Convert a YYYY-MM-DD date to epoch seconds (UTC midnight). NaN-safe: returns null. */
export function dateToEpoch(d: string): number | null {
  if (!d) return null;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Build the v8 chart URL. `start` present → period1/period2 range; else the named `range`. */
export function chartUrl(a: HistoryArgs, host: string = YF_HOST, nowMs: number = Date.now()): string {
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
  meta?: { symbol?: string };
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
export async function fetchQuote(
  get: (url: string) => Promise<unknown>,
  symbols: string[],
  host: string = YF_HOST,
): Promise<QuoteRow[]> {
  if (symbols.length === 0) return [];
  const rows = await Promise.all(
    symbols.map(async (s) => {
      try {
        return parseQuoteMeta(await get(quoteUrl(s, host)), s);
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((r): r is QuoteRow => r !== null);
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

/** Build the v1 search URL. `count` bounds the returned equity/ETF quotes. */
export function searchUrl(query: string, count: number, host: string = YF_HOST): string {
  const p = new URLSearchParams();
  p.set("q", query);
  p.set("quotesCount", String(Math.max(1, Math.min(count, 50))));
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
