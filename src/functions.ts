// The three VGI table functions: history, quote, search. All keyless, all single-shot
// snapshots — state is just a `done` flag (fully serializable; no socket / batch / Date),
// so the HTTP transport can round-trip it. The Yahoo `get` client is injected so worker.ts
// wires the real crumb/cookie fetch and tests could wire a fake.

import { defineTableFunction, ArgumentValidationError, type OutputCollector } from "@query-farm/vgi";
import { Utf8, Int64, Bool } from "@query-farm/apache-arrow";
import { fetchHistory, fetchQuote, fetchSearch, parseSymbols } from "./yahoo.js";
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

interface DoneState {
  done: boolean;
}

// ── history ─────────────────────────────────────────────────────────────────

// `bar` is the candle interval (a.k.a. Yahoo's `interval`). It is deliberately NOT named
// `interval` because INTERVAL is a reserved SQL keyword in DuckDB — a bare `interval :=`
// is a parser error, so users would have to write `"interval" :=`. `bar` needs no quoting.
interface HistoryFnArgs {
  symbol: string;
  range: string;
  bar: string;
  prepost: boolean;
  // `start`/`end` are avoided: END is a reserved SQL keyword in DuckDB (CASE…END). The
  // *_date suffix keeps both un-quoted and self-documenting.
  start_date: string;
  end_date: string;
}

export function makeHistoryFunction(get: YahooGet) {
  const schema = historySchema();
  return defineTableFunction<HistoryFnArgs, DoneState>({
    name: "history",
    description:
      "Historical OHLCV candles for one symbol from Yahoo Finance (v8 chart API). " +
      "Pick a named window (range := '1y') plus a candle width (bar := '1wk'), or an " +
      "explicit start_date/end_date range. Returns columns symbol, timestamp (UTC), open, " +
      "high, low, close, adjclose, and volume.",
    args: {
      symbol: new Utf8(),
      range: new Utf8(),
      bar: new Utf8(),
      prepost: new Bool(),
      start_date: new Utf8(),
      end_date: new Utf8(),
    },
    argDefaults: { range: "1mo", bar: "1d", prepost: false, start_date: "", end_date: "" },
    argDocs: {
      symbol:
        "The ticker to fetch, written the way Yahoo lists it — equities, class shares, crypto pairs, and caret-prefixed indices are all accepted. Required, and passed as the first positional argument (not symbol := ...).",
      range:
        "Named lookback window: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, or max. Ignored when start_date is set. Default '1mo'.",
      bar:
        "Candle width — how much time each bar spans: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo. Intraday widths only work on recent ranges. Default '1d'.",
      prepost: "Include pre-market and post-market candles. Default false.",
      start_date:
        "Inclusive start date 'YYYY-MM-DD'. When set, [start_date, end_date) overrides range. Empty = use range.",
      end_date: "Exclusive end date 'YYYY-MM-DD'. Defaults to now when start_date is set.",
    },
    onBind: (p) => {
      if (p.args.symbol == null || String(p.args.symbol).trim() === "") {
        throw new ArgumentValidationError("history: symbol is required");
      }
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchHistory(get, {
        symbol: String(p.args.symbol),
        range: p.args.range || "1mo",
        interval: p.args.bar || "1d",
        prepost: Boolean(p.args.prepost),
        start: p.args.start_date || "",
        end: p.args.end_date || "",
      });
      out.emit(historyBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT * FROM yfinance.main.history('AAPL')", description: "Last month of daily candles for Apple" },
      {
        sql: "SELECT timestamp, close, volume FROM yfinance.main.history('MSFT', range := '1y', bar := '1wk')",
        description: "One year of weekly closes for Microsoft",
      },
      {
        sql: "SELECT timestamp, close FROM yfinance.main.history('SPY', start_date := '2024-01-01', end_date := '2024-12-31')",
        description: "Daily closes across an explicit date range",
      },
    ],
    tags: {
      "vgi.category": "market-data",
      "vgi.doc_llm":
        "Daily or intraday OHLCV candles for a single ticker over a chosen window. Use it for " +
        "price history, charting, returns, and technical analysis. Pick a named range (range := " +
        "'1y') with a candle width (bar := '1wk'), or an explicit start_date/end_date range. " +
        "Thin or halted candles come back as NULL cells rather than failing the scan.",
      "vgi.doc_md":
        "## history\n\n" +
        "Historical OHLCV candles for one ticker from Yahoo's chart feed. Choose a named `range` " +
        "plus a `bar` (candle width), or pass an explicit `start_date`/`end_date`. Emits one row " +
        "per candle, ordered oldest-first.\n\n" +
        "```sql\nSELECT timestamp, close FROM yfinance.main.history('AAPL', range := '6mo');\n```",
      "vgi.result_columns_md":
        "| Column | Type | Meaning |\n" +
        "| --- | --- | --- |\n" +
        "| `symbol` | VARCHAR | The ticker (echoed from Yahoo's metadata). |\n" +
        "| `timestamp` | TIMESTAMP (UTC) | Candle open time. |\n" +
        "| `open` | DOUBLE | Opening price. |\n" +
        "| `high` | DOUBLE | Session high. |\n" +
        "| `low` | DOUBLE | Session low. |\n" +
        "| `close` | DOUBLE | Closing price. |\n" +
        "| `adjclose` | DOUBLE | Split/dividend-adjusted close (falls back to close). |\n" +
        "| `volume` | BIGINT | Shares/contracts traded. |",
    },
  });
}

// ── quote ─────────────────────────────────────────────────────────────────

interface QuoteArgs {
  symbols: string;
}

export function makeQuoteFunction(get: YahooGet) {
  const schema = quoteSchema();
  return defineTableFunction<QuoteArgs, DoneState>({
    name: "quote",
    description:
      "Current market snapshot for one or more symbols (keyless, from the chart meta plane): " +
      "price, change vs previous close, day range, 52-week range, volume. Pass a " +
      "comma-separated symbol list.",
    args: { symbols: new Utf8() },
    argDocs: {
      symbols:
        "One ticker or a comma/space-separated list (e.g. 'AAPL' or 'AAPL,MSFT,GOOG'). One request " +
        "is made per symbol; an unresolvable ticker is dropped rather than failing the batch. " +
        "Required, and passed as the first positional argument (not symbols := ...).",
    },
    onBind: (p) => {
      if (p.args.symbols == null || String(p.args.symbols).trim() === "") {
        throw new ArgumentValidationError("quote: symbols is required (comma-separated list)");
      }
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchQuote(get, parseSymbols(String(p.args.symbols)));
      out.emit(quoteBatch(schema, rows));
      state.done = true;
    },
    examples: [
      {
        sql: "SELECT symbol, regular_market_price, regular_market_change_percent FROM yfinance.main.quote('AAPL')",
        description: "Snapshot quote for Apple",
      },
      {
        sql: "SELECT symbol, regular_market_price FROM yfinance.main.quote('AAPL,MSFT,GOOG')",
        description: "Latest price for several symbols at once",
      },
    ],
    tags: {
      "vgi.category": "market-data",
      "vgi.doc_llm":
        "A current market snapshot for one or more tickers: last price, change vs the previous " +
        "close, day high/low, 52-week high/low, and volume. Keyless — one lightweight request per " +
        "symbol. Use it for watchlists and dashboards; use `history` for a time series.",
      "vgi.doc_md":
        "## quote\n\n" +
        "Current-price snapshot for a comma-separated list of tickers, one row per symbol. Backed " +
        "by Yahoo's keyless chart-metadata plane, so `change`/`change_percent` are derived from the " +
        "previous close and market cap is not available.\n\n" +
        "```sql\nSELECT symbol, regular_market_price FROM yfinance.main.quote('AAPL,MSFT');\n```",
      "vgi.result_columns_md":
        "| Column | Type | Meaning |\n" +
        "| --- | --- | --- |\n" +
        "| `symbol` | VARCHAR | The ticker. |\n" +
        "| `short_name` / `long_name` | VARCHAR | Display names. |\n" +
        "| `currency` | VARCHAR | Quote currency. |\n" +
        "| `exchange` | VARCHAR | Listing exchange. |\n" +
        "| `quote_type` | VARCHAR | Instrument type (EQUITY, ETF, …). |\n" +
        "| `regular_market_price` | DOUBLE | Last regular-session price. |\n" +
        "| `regular_market_change` / `_percent` | DOUBLE | Change vs previous close (absolute / %). |\n" +
        "| `regular_market_volume` | BIGINT | Session volume. |\n" +
        "| `regular_market_day_high` / `_low` | DOUBLE | Session high / low. |\n" +
        "| `regular_market_previous_close` | DOUBLE | Prior session close. |\n" +
        "| `fifty_two_week_high` / `_low` | DOUBLE | 52-week high / low. |\n" +
        "| `regular_market_time` | TIMESTAMP (UTC) | Time of the last price. |",
    },
  });
}

// ── search ─────────────────────────────────────────────────────────────────

interface SearchArgs {
  query: string;
  count: number;
}

export function makeSearchFunction(get: YahooGet) {
  const schema = searchSchema();
  return defineTableFunction<SearchArgs, DoneState>({
    name: "search",
    description:
      "Look up ticker symbols by name or partial symbol (v1 search API). Returns candidate " +
      "symbols with exchange and instrument type, best matches first.",
    args: { query: new Utf8(), count: new Int64() },
    argDefaults: { count: 8 },
    argDocs: {
      query:
        "Free-text company name or partial ticker symbol to look up. Required, and passed as the first positional argument (not query := ...).",
      count: "Maximum candidate symbols to return, clamped to 1..50. Default 8.",
    },
    onBind: (p) => {
      if (p.args.query == null || String(p.args.query).trim() === "") {
        throw new ArgumentValidationError("search: query is required");
      }
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const count = Number(p.args.count ?? 8);
      const rows = await fetchSearch(get, String(p.args.query), count > 0 ? count : 8);
      out.emit(searchBatch(schema, rows));
      state.done = true;
    },
    examples: [
      {
        sql: "SELECT symbol, short_name, exchange FROM yfinance.main.search('apple')",
        description: "Find symbols matching 'apple'",
      },
      {
        sql: "SELECT symbol, long_name, exchange FROM yfinance.main.search('vanguard', count := 20)",
        description: "Up to 20 candidate symbols for a query",
      },
    ],
    tags: {
      "vgi.category": "reference",
      "vgi.doc_llm":
        "Resolve a company name or partial symbol to candidate ticker symbols, best matches first. " +
        "Use it when you only know a name — take the resulting `symbol` and pass it to `history` or " +
        "`quote`. Returns equities, ETFs, indices, and other instruments with their exchange and type.",
      "vgi.doc_md":
        "## search\n\n" +
        "Ticker lookup over Yahoo's search endpoint. Returns up to `count` candidate symbols " +
        "(news results are dropped), ranked by Yahoo's relevance score.\n\n" +
        "```sql\nSELECT symbol, long_name FROM yfinance.main.search('microsoft');\n```",
      "vgi.result_columns_md":
        "| Column | Type | Meaning |\n" +
        "| --- | --- | --- |\n" +
        "| `symbol` | VARCHAR | The ticker to use with `history`/`quote`. |\n" +
        "| `short_name` / `long_name` | VARCHAR | Instrument names. |\n" +
        "| `exchange` | VARCHAR | Listing exchange (display name). |\n" +
        "| `quote_type` | VARCHAR | Instrument type code (EQUITY, ETF, INDEX, …). |\n" +
        "| `type_disp` | VARCHAR | Human-friendly instrument type. |\n" +
        "| `score` | DOUBLE | Yahoo relevance score (higher = better match). |",
    },
  });
}
