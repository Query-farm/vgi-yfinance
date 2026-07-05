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
      "explicit start/end date range. Emits symbol, timestamp (UTC), o/h/l/c/adjclose, volume.",
    args: {
      symbol: new Utf8(),
      range: new Utf8(),
      bar: new Utf8(),
      prepost: new Bool(),
      start_date: new Utf8(),
      end_date: new Utf8(),
    },
    argDefaults: { range: "1mo", bar: "1d", prepost: false, start_date: "", end_date: "" },
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
      { sql: "SELECT * FROM yf.history('AAPL')", description: "Last month of daily candles for Apple" },
      {
        sql: "SELECT * FROM yf.history('MSFT', range := '1y', bar := '1wk')",
        description: "One year of weekly candles for Microsoft",
      },
      {
        sql: "SELECT * FROM yf.history('SPY', start_date := '2024-01-01', end_date := '2024-12-31')",
        description: "Daily candles across an explicit date range",
      },
    ],
    categories: ["finance", "market-data", "timeseries"],
    tags: { category: "finance", source: "yahoo-finance" },
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
      { sql: "SELECT * FROM yf.quote('AAPL')", description: "Snapshot quote for Apple" },
      {
        sql: "SELECT symbol, regular_market_price FROM yf.quote('AAPL,MSFT,GOOG')",
        description: "Latest price for several symbols at once",
      },
    ],
    categories: ["finance", "market-data"],
    tags: { category: "finance", source: "yahoo-finance" },
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
      { sql: "SELECT * FROM yf.search('apple')", description: "Find symbols matching 'apple'" },
      {
        sql: "SELECT symbol, long_name, exchange FROM yf.search('vanguard', count := 20)",
        description: "Up to 20 candidate symbols for a query",
      },
    ],
    categories: ["finance", "reference"],
    tags: { category: "finance", source: "yahoo-finance" },
  });
}
