// The `yfinance` catalog descriptor + its metadata tags (the vgi.* discovery/doc
// channels vgi-lint grades). Yahoo Finance's public endpoints are KEYLESS, so — unlike
// the azure workers — there is NO secret type here. The only server-side state the real
// client keeps is an in-process consent-cookie/crumb cache (client.ts), re-derivable and
// never on the wire, so it is not part of the catalog contract.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (yfinance.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";

const REPO = "https://github.com/Query-farm/vgi-yfinance";
const ISSUES = `${REPO}/issues`;

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Yahoo Finance",
  "vgi.doc_llm":
    "Live and historical stock-market data from Yahoo Finance as SQL table functions. " +
    "Reach for it to pull OHLCV price history for a ticker, snapshot the current price and " +
    "day/52-week range for one or more tickers, or resolve a company name to its ticker " +
    "symbol. Keyless — no API key or secret. Symbols use Yahoo's convention (AAPL, BRK-B, " +
    "BTC-USD, ^GSPC). Data is Yahoo's unofficial public feed: best-effort, for informational use.",
  "vgi.doc_md":
    "## Yahoo Finance\n\n" +
    "Market data from Yahoo Finance, exposed as three keyless DuckDB table functions.\n\n" +
    "- **`history`** — OHLCV candles for one ticker over a named range or explicit date range.\n" +
    "- **`quote`** — a current-price snapshot (price, change, day & 52-week range, volume) for a list of tickers.\n" +
    "- **`search`** — resolve a company name or partial symbol to candidate tickers.\n\n" +
    "No secret or API key is required. Prices are delayed and provided for informational use only; " +
    "review Yahoo's terms before redistribution. Intraday candles are only available for recent ranges.",
  "vgi.keywords": JSON.stringify([
    "stocks",
    "equities",
    "ticker",
    "OHLCV",
    "market data",
    "quotes",
    "share price",
    "finance",
    "yahoo finance",
    "ETF",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No
  // expected_result — Yahoo data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "search_symbol",
      description: "Resolve a company name to candidate tickers",
      sql: "SELECT symbol, short_name FROM yfinance.main.search('apple') LIMIT 3",
    },
    {
      name: "recent_history",
      description: "Fetch the last few daily candles for a ticker",
      sql: "SELECT timestamp, close FROM yfinance.main.history('AAPL', range := '5d') ORDER BY timestamp",
    },
  ]),
  // The agent-suitability suite (catalog only). reference_sql is grader-only.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "apple_last_close",
      prompt: "What was Apple's most recent daily closing price?",
      reference_sql:
        "SELECT close FROM yfinance.main.history('AAPL', range := '5d') ORDER BY timestamp DESC LIMIT 1",
    },
    {
      name: "microsoft_ticker",
      prompt: "What stock ticker symbol does Microsoft trade under?",
      reference_sql: "SELECT symbol FROM yfinance.main.search('microsoft') LIMIT 1",
    },
    {
      name: "tesla_price",
      prompt: "What is the current market price of Tesla stock?",
      reference_sql: "SELECT regular_market_price FROM yfinance.main.quote('TSLA')",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Market Data",
  "vgi.doc_llm":
    "The functions that return Yahoo Finance data. `history` yields a time series of OHLCV " +
    "candles for one symbol; `quote` returns a one-row-per-symbol snapshot of current pricing; " +
    "`search` maps free text to ticker symbols. Start with `search` when you only know a company " +
    "name, then feed the resolved symbol into `history` or `quote`.",
  "vgi.doc_md":
    "## Market data functions\n\n" +
    "| Function | Returns | Typical use |\n" +
    "| --- | --- | --- |\n" +
    "| `history` | OHLCV candles (time series) | charting, returns, backtests |\n" +
    "| `quote` | current snapshot per symbol | dashboards, watchlists |\n" +
    "| `search` | candidate tickers | name → symbol resolution |\n\n" +
    "All are keyless and take a ticker (or a comma-separated list) plus optional named arguments. " +
    "Symbols follow Yahoo's convention (e.g. `AAPL`, `BRK-B`, `BTC-USD`, `^GSPC`).",
  "vgi.keywords": JSON.stringify(["price history", "candles", "snapshot quote", "symbol lookup", "OHLCV"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    {
      name: "market-data",
      title: "Market Data",
      description: "Price history and current-quote snapshots for securities.",
    },
    {
      name: "reference",
      title: "Symbol Reference",
      description: "Look up ticker symbols by company name or partial match.",
    },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Last month of daily candles for Apple", sql: "SELECT * FROM yfinance.main.history('AAPL')" },
    {
      description: "Current price for several megacaps at once",
      sql: "SELECT symbol, regular_market_price FROM yfinance.main.quote('AAPL,MSFT,GOOG')",
    },
    {
      description: "Find a ticker by company name",
      sql: "SELECT symbol, long_name FROM yfinance.main.search('vanguard')",
    },
  ]),
};

export function makeCatalog(functions: VgiFunction[]): CatalogDescriptor {
  return {
    name: "yfinance",
    defaultSchema: "main",
    comment:
      "Yahoo Finance market data as DuckDB tables: history (OHLCV), quote (snapshot), " +
      "search (symbol lookup) — vgi-yfinance",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "Yahoo Finance market data: price history, current quotes, and symbol search.",
        tags: SCHEMA_TAGS,
        functions,
      },
    ],
  };
}
