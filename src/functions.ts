// The three VGI table functions: history, quote, search. All keyless. The Yahoo `get`
// client is injected so the entries wire the real fetch and tests could wire a fake.
//
// All three are **blended row-transform** functions
// (`defineRowTransformFunction`): the positional arg is a per-row INPUT COLUMN, not a
// bind-time scalar, so one registration serves every call shape —
//
//   history('AAPL')                                   -- literal -> 1 input row
//   FROM watchlist w, LATERAL history(w.sym)          -- correlated LATERAL
//
// Named args (range, bar, …) stay bind-time scalars on `params.args` and must be
// literals. Two rules the shape imposes: no finalize (DuckDB forbids FinalExecute under
// correlated LATERAL), and since all three fan out 1->N, every emit carries
// `parentRowsMetadata` naming the input row behind each output row — without it the
// extension assumes 1->1 and stamps outer columns from the wrong row. A NULL/empty input
// row yields no output rows (the LATERAL contract) rather than an error. There is no
// per-call state, so nothing has to survive the HTTP transport's state token.

// Imports come from the workerd-safe `worker-cf` entry (see schema.ts) so the same source
// bundles for Cloudflare; the arg types use vgi's backend-agnostic factories.
import {
  bool,
  cacheControlMetadata,
  defineRowTransformFunction,
  int64,
  parentRowsMetadata,
  utf8,
  type VgiBatch,
} from "@query-farm/vgi/worker-cf";
import {
  fetchHistory,
  fetchQuoteMap,
  fetchSearch,
  mapLimit,
  MAX_CONCURRENCY,
  parseSymbols,
  type HistoryRow,
  type QuoteRow,
  type SearchRow,
} from "./yahoo.js";
import {
  historySchema,
  historyBatch,
  quoteSchema,
  quoteBatch,
  searchSchema,
  searchBatch,
} from "./schema.js";

/** The injected HTTP getter: URL in, parsed JSON out. */
export type YahooGet = (url: string) => Promise<unknown>;

/** The trimmed string in column `name` at `row`, or null when NULL/blank. */
function cellString(batch: VgiBatch, name: string, row: number): string | null {
  const v = batch.getChild(name)?.get(row);
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ── history ─────────────────────────────────────────────────────────────────

// `bar` is the candle interval (a.k.a. Yahoo's `interval`). It is deliberately NOT named
// `interval` because INTERVAL is a reserved SQL keyword in DuckDB — a bare `interval :=`
// is a parser error, so users would have to write `"interval" :=`. `bar` needs no quoting.
// Named (bind-time) args only — `symbol` is the per-row input column, read off the batch.
interface HistoryFnArgs {
  range: string;
  bar: string;
  prepost: boolean;
  // `start`/`end` are avoided: END is a reserved SQL keyword in DuckDB (CASE…END). The
  // *_date suffix keeps both un-quoted and self-documenting.
  start_date: string;
  end_date: string;
}

// Illustrative examples for `history`, shared by the native `examples` field (surfaced
// to DuckDB's `duckdb_functions().examples` column, SQL-only) and the `vgi.example_queries`
// tag (which also carries the per-example descriptions VGI515 checks). Keeping one source
// keeps the two carriers' SQL byte-identical so the linter dedupes them to a single entry.
const HISTORY_EXAMPLES = [
  {
    sql: "SELECT timestamp, close, volume FROM yfinance.main.history('AAPL', range := '1mo') ORDER BY timestamp DESC LIMIT 5",
    description: "The five most recent daily closes and volumes for Apple",
  },
  {
    sql: "SELECT timestamp, close, volume FROM yfinance.main.history('MSFT', range := '1y', bar := '1wk')",
    description: "One year of weekly closes for Microsoft",
  },
  {
    sql: "SELECT max(high) AS high_52w, min(low) AS low_52w FROM yfinance.main.history('SPY', range := '1y')",
    description: "The 52-week high and low for SPY, aggregated from daily candles",
  },
  {
    sql: "SELECT w.sym, max(h.close) AS high_close FROM (VALUES ('AAPL'), ('MSFT')) w(sym), LATERAL yfinance.main.history(w.sym, range := '1mo') h GROUP BY w.sym",
    description: "Highest close over the last month for every ticker in a table, via LATERAL",
  },
];

export function makeHistoryFunction(get: YahooGet) {
  const schema = historySchema();
  return defineRowTransformFunction<HistoryFnArgs>({
    name: "history",
    description:
      "Historical OHLCV candles for one symbol from Yahoo Finance (v8 chart API). " +
      "Pick a named window (range := '1y') plus a candle width (bar := '1wk'), or an " +
      "explicit start_date/end_date range. The symbol may be a column, so LATERAL " +
      "history(t.sym) fetches candles for every row. Returns columns symbol, timestamp (UTC), " +
      "open, high, low, close, adjclose, and volume.",
    args: { symbol: utf8() },
    namedArgs: {
      range: utf8(),
      bar: utf8(),
      prepost: bool(),
      start_date: utf8(),
      end_date: utf8(),
    },
    argDefaults: { range: "1mo", bar: "1d", prepost: false, start_date: "", end_date: "" },
    // Yahoo's fixed vocabularies — surfaced via vgi_function_arguments() so agents
    // can discover them, and enforced at bind so a bad value fails fast.
    argConstraints: {
      range: { choices: ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"] },
      bar: {
        choices: ["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"],
      },
    },
    argDocs: {
      symbol:
        "The ticker to fetch, written the way Yahoo lists it — equities, class shares, crypto pairs, and caret-prefixed indices are all accepted. Passed as the first positional argument (not symbol := ...); a literal or a column (LATERAL history(t.sym)). A NULL or empty symbol yields no rows.",
      range:
        "Named lookback window over which to fetch candles. Ignored when start_date is set. Default '1mo'.",
      bar:
        "Candle width — how much time each bar spans. Intraday widths only work on recent ranges. Default '1d'.",
      prepost: "Include pre-market and post-market candles. Default false.",
      start_date:
        "Inclusive start date 'YYYY-MM-DD'. When set, [start_date, end_date) overrides range. Empty = use range.",
      end_date: "Exclusive end date 'YYYY-MM-DD'. Defaults to now when start_date is set.",
    },
    onBind: () => ({ outputSchema: schema }),
    process: async (p, batch, out) => {
      const symbols: (string | null)[] = [];
      for (let row = 0; row < batch.numRows; row++) symbols.push(cellString(batch, "symbol", row));

      // One chart request per DISTINCT symbol in the chunk, bounded in flight. A Yahoo
      // error (unknown ticker → HTTP 404) still fails the scan, as the literal form does.
      const distinct = [...new Set(symbols.filter((s): s is string => s !== null))];
      const fetched = await mapLimit(distinct, MAX_CONCURRENCY, (symbol) =>
        fetchHistory(get, {
          symbol,
          range: p.args.range || "1mo",
          interval: p.args.bar || "1d",
          prepost: Boolean(p.args.prepost),
          start: p.args.start_date || "",
          end: p.args.end_date || "",
        }),
      );
      const bySymbol = new Map(distinct.map((s, i) => [s, fetched[i]!]));

      const rows: HistoryRow[] = [];
      const parentRows: number[] = [];
      symbols.forEach((s, row) => {
        for (const r of (s && bySymbol.get(s)) || []) {
          rows.push(r);
          parentRows.push(row);
        }
      });
      // Today's candle can still change, and older candles can be corrected.
      // Permit a short client-side snapshot, with reuse for each input symbol.
      out.emit(historyBatch(schema, rows), cacheControlMetadata(
        { ttl: 60, perValue: true },
        parentRowsMetadata(parentRows, rows.length),
      ));
    },
    examples: HISTORY_EXAMPLES,
    tags: {
      "vgi.category": "market-data",
      "vgi.example_queries": JSON.stringify(HISTORY_EXAMPLES),
      "vgi.doc_llm":
        "Daily or intraday OHLCV candles for a single ticker over a chosen window. Use it for " +
        "price history, charting, returns, and technical analysis. Pick a named range (range := " +
        "'1y') with a candle width (bar := '1wk'), or an explicit start_date/end_date range. " +
        "Thin or halted candles come back as NULL cells rather than failing the scan.",
      "vgi.doc_md":
        "## history\n\n" +
        "Historical OHLCV candles for one ticker from Yahoo's chart feed. Choose a named `range` " +
        "(e.g. `'6mo'`, `'1y'`, `'max'`) plus a `bar` candle width (`'1d'`, `'1wk'`, `'1mo'`, or an " +
        "intraday width like `'5m'` on recent ranges), or pass an explicit `start_date`/`end_date` " +
        "pair to override `range`. Emits one row per candle, ordered oldest-first; thin or halted " +
        "candles come back with NULL price cells rather than failing the scan. Intraday bars are " +
        "only retained by Yahoo for recent windows, so an intraday `bar` on a long `range` yields " +
        "fewer rows than the range implies. `adjclose` falls back to `close` when Yahoo omits it.",
      "vgi.result_columns_schema": JSON.stringify([
        { name: "symbol", type: "VARCHAR", description: "The ticker, echoed from Yahoo's chart metadata." },
        { name: "timestamp", type: "TIMESTAMP WITH TIME ZONE", description: "Candle open time, in UTC." },
        { name: "open", type: "DOUBLE", description: "Opening price for the candle." },
        { name: "high", type: "DOUBLE", description: "Highest traded price during the candle." },
        { name: "low", type: "DOUBLE", description: "Lowest traded price during the candle." },
        { name: "close", type: "DOUBLE", description: "Closing price for the candle." },
        {
          name: "adjclose",
          type: "DOUBLE",
          description: "Split/dividend-adjusted close; falls back to close when Yahoo omits it.",
        },
        { name: "volume", type: "BIGINT", description: "Shares or contracts traded during the candle." },
      ]),
    },
  });
}

// ── quote ─────────────────────────────────────────────────────────────────

// No named args — `symbols` is the per-row input column.
type QuoteArgs = Record<string, never>;

// Shared by the native `examples` field and the `vgi.example_queries` tag — see HISTORY_EXAMPLES.
const QUOTE_EXAMPLES = [
  {
    sql: "SELECT symbol, regular_market_price, regular_market_change_percent FROM yfinance.main.quote('AAPL')",
    description: "Snapshot quote for Apple",
  },
  {
    sql: "SELECT symbol, regular_market_price FROM yfinance.main.quote('AAPL,MSFT,GOOG')",
    description: "Latest price for several symbols at once",
  },
  {
    sql: "SELECT w.sym, q.regular_market_price FROM (VALUES ('AAPL'), ('MSFT')) w(sym), LATERAL yfinance.main.quote(w.sym) q",
    description: "Latest price for every ticker in a table, via LATERAL",
  },
];

export function makeQuoteFunction(get: YahooGet) {
  const schema = quoteSchema();
  return defineRowTransformFunction<QuoteArgs>({
    name: "quote",
    description:
      "Current market snapshot for one or more symbols (keyless, from the chart meta plane): " +
      "price, change vs previous close, day range, 52-week range, volume. Pass a " +
      "comma-separated symbol list, or a column (LATERAL quote(t.sym)) for one quote per row.",
    args: { symbols: utf8() },
    argDocs: {
      symbols:
        "One ticker or a comma/space-separated list (e.g. 'AAPL' or 'AAPL,MSFT,GOOG'). One request " +
        "is made per distinct symbol; an unresolvable ticker is dropped rather than failing the batch. " +
        "Passed as the first positional argument (not symbols := ...); a literal or a column " +
        "(LATERAL quote(t.sym)). A NULL or empty value yields no rows.",
    },
    onBind: () => ({ outputSchema: schema }),
    process: async (_p, batch, out) => {
      const perRow: string[][] = [];
      for (let row = 0; row < batch.numRows; row++) {
        const cell = cellString(batch, "symbols", row);
        perRow.push(cell ? parseSymbols(cell) : []);
      }
      const bySymbol = await fetchQuoteMap(get, [...new Set(perRow.flat())]);

      const rows: QuoteRow[] = [];
      const parentRows: number[] = [];
      perRow.forEach((symbols, row) => {
        for (const s of symbols) {
          const q = bySymbol.get(s);
          if (!q) continue;
          rows.push(q);
          parentRows.push(row);
        }
      });
      out.emit(quoteBatch(schema, rows), parentRowsMetadata(parentRows, rows.length));
    },
    examples: QUOTE_EXAMPLES,
    tags: {
      "vgi.category": "market-data",
      "vgi.example_queries": JSON.stringify(QUOTE_EXAMPLES),
      "vgi.doc_llm":
        "A current market snapshot for one or more tickers: last price, change vs the previous " +
        "close, day high/low, 52-week high/low, and volume. Keyless — one lightweight request per " +
        "symbol. Use it for watchlists and dashboards; use `history` for a time series.",
      "vgi.doc_md":
        "## quote\n\n" +
        "Current-price snapshot for a comma-separated list of tickers, one row per symbol. Backed " +
        "by Yahoo's keyless chart-metadata plane, so `regular_market_change` and " +
        "`regular_market_change_percent` are derived from the previous close, and market cap is not " +
        "available. An unresolvable ticker is dropped rather than failing the batch, so the result " +
        "may have fewer rows than symbols requested. Each symbol is fetched with its own lightweight " +
        "request, in parallel, so a long watchlist stays responsive.",
      "vgi.result_columns_schema": JSON.stringify([
        { name: "symbol", type: "VARCHAR", description: "The ticker the row describes." },
        { name: "short_name", type: "VARCHAR", description: "Short display name (e.g. 'Apple Inc.')." },
        { name: "long_name", type: "VARCHAR", description: "Full/long display name, when Yahoo provides one." },
        { name: "currency", type: "VARCHAR", description: "ISO currency the price is quoted in (e.g. 'USD')." },
        { name: "exchange", type: "VARCHAR", description: "Listing exchange code (e.g. 'NMS')." },
        { name: "quote_type", type: "VARCHAR", description: "Instrument type: EQUITY, ETF, INDEX, CRYPTOCURRENCY, …" },
        { name: "regular_market_price", type: "DOUBLE", description: "Last regular-session price." },
        {
          name: "regular_market_change",
          type: "DOUBLE",
          description: "Absolute price change versus the previous close.",
        },
        {
          name: "regular_market_change_percent",
          type: "DOUBLE",
          description: "Percentage price change versus the previous close.",
        },
        { name: "regular_market_volume", type: "BIGINT", description: "Regular-session traded volume." },
        { name: "regular_market_day_high", type: "DOUBLE", description: "Highest price in the current session." },
        { name: "regular_market_day_low", type: "DOUBLE", description: "Lowest price in the current session." },
        {
          name: "regular_market_previous_close",
          type: "DOUBLE",
          description: "Prior regular-session closing price.",
        },
        { name: "fifty_two_week_high", type: "DOUBLE", description: "Highest price over the trailing 52 weeks." },
        { name: "fifty_two_week_low", type: "DOUBLE", description: "Lowest price over the trailing 52 weeks." },
        {
          name: "regular_market_time",
          type: "TIMESTAMP WITH TIME ZONE",
          description: "Time of the last regular-session price, in UTC.",
        },
      ]),
    },
  });
}

// ── search ─────────────────────────────────────────────────────────────────

// Named (bind-time) args only — `query` is the per-row input column.
interface SearchArgs {
  count: number;
}

// Shared by the native `examples` field and the `vgi.example_queries` tag — see HISTORY_EXAMPLES.
const SEARCH_EXAMPLES = [
  {
    sql: "SELECT symbol, short_name, exchange FROM yfinance.main.search('apple')",
    description: "Find symbols matching 'apple'",
  },
  {
    sql: "SELECT symbol, long_name, exchange FROM yfinance.main.search('vanguard', count := 20)",
    description: "Up to 20 candidate symbols for a query",
  },
  {
    sql: "SELECT c.name, s.symbol FROM (VALUES ('apple'), ('microsoft')) c(name), LATERAL yfinance.main.search(c.name, count := 1) s",
    description: "Best-matching ticker for every company name in a table, via LATERAL",
  },
];

export function makeSearchFunction(get: YahooGet) {
  const schema = searchSchema();
  return defineRowTransformFunction<SearchArgs>({
    name: "search",
    description:
      "Look up ticker symbols by name or partial symbol (v1 search API). Returns candidate " +
      "symbols with exchange and instrument type, best matches first. The query may be a " +
      "column, so LATERAL search(t.name) resolves every row.",
    args: { query: utf8() },
    namedArgs: { count: int64() },
    argDefaults: { count: 8 },
    argDocs: {
      query:
        "Free-text company name or partial ticker symbol to look up. Passed as the first positional argument (not query := ...); a literal or a column (LATERAL search(t.name)). A NULL or empty query yields no rows.",
      count: "Maximum candidate symbols to return per query, clamped to 1..50. Default 8.",
    },
    onBind: () => ({ outputSchema: schema }),
    process: async (p, batch, out) => {
      const count = Number(p.args.count ?? 8);
      const queries: (string | null)[] = [];
      for (let row = 0; row < batch.numRows; row++) queries.push(cellString(batch, "query", row));

      // One search request per DISTINCT query in the chunk, bounded in flight. An HTTP
      // error fails the scan, as the literal form does; no match is simply zero rows.
      const distinct = [...new Set(queries.filter((q): q is string => q !== null))];
      const fetched = await mapLimit(distinct, MAX_CONCURRENCY, (q) => fetchSearch(get, q, count > 0 ? count : 8));
      const byQuery = new Map(distinct.map((q, i) => [q, fetched[i]!]));

      const rows: SearchRow[] = [];
      const parentRows: number[] = [];
      queries.forEach((q, row) => {
        for (const r of (q && byQuery.get(q)) || []) {
          rows.push(r);
          parentRows.push(row);
        }
      });
      out.emit(searchBatch(schema, rows), parentRowsMetadata(parentRows, rows.length));
    },
    examples: SEARCH_EXAMPLES,
    tags: {
      "vgi.category": "reference",
      "vgi.example_queries": JSON.stringify(SEARCH_EXAMPLES),
      "vgi.doc_llm":
        "Resolve a company name or partial symbol to candidate ticker symbols, best matches first. " +
        "Use it when you only know a name — take the resulting `symbol` and pass it to `history` or " +
        "`quote`. Returns equities, ETFs, indices, and other instruments with their exchange and type.",
      "vgi.doc_md":
        "## search\n\n" +
        "Ticker lookup over Yahoo's search endpoint. Returns up to `count` candidate symbols " +
        "(news results are dropped), ranked by Yahoo's relevance score, best matches first. Take the " +
        "resulting `symbol` and feed it into `history` or `quote`. The `count` argument caps how many " +
        "candidates come back and is clamped to 1..50 (default 8).",
      "vgi.result_columns_schema": JSON.stringify([
        { name: "symbol", type: "VARCHAR", description: "The candidate ticker to use with history/quote." },
        { name: "short_name", type: "VARCHAR", description: "Short instrument name." },
        { name: "long_name", type: "VARCHAR", description: "Full instrument name, when available." },
        { name: "exchange", type: "VARCHAR", description: "Listing exchange display name (e.g. 'NASDAQ')." },
        { name: "quote_type", type: "VARCHAR", description: "Instrument type code: EQUITY, ETF, INDEX, …" },
        { name: "type_disp", type: "VARCHAR", description: "Human-friendly instrument type label." },
        { name: "score", type: "DOUBLE", description: "Yahoo relevance score; higher means a better match." },
      ]),
    },
  });
}
