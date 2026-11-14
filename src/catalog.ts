// The `yfinance` catalog descriptor + its metadata tags (the vgi.* discovery/doc
// channels vgi-lint grades). Yahoo Finance's public endpoints are KEYLESS, so — unlike
// the azure workers — there is NO secret type here. The only server-side state the real
// client keeps is an in-process consent-cookie/crumb cache (client.ts), re-derivable and
// never on the wire, so it is not part of the catalog contract.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (yfinance.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction, ViewDescriptor } from "@query-farm/vgi";

const REPO = "https://github.com/Query-farm/vgi-yfinance";
const ISSUES = `${REPO}/issues`;

// Composed example: symbol_reference (static registry) LATERAL-joined to quote (live
// snapshot). Shown at schema level AND guaranteed-runnable at catalog level, so one constant
// keeps the two SQL strings byte-identical.
const REFERENCE_52W_POSITION_SQL =
  "SELECT r.asset_type, r.symbol, q.regular_market_price, " +
  "round(100 * (q.regular_market_price - q.fifty_two_week_low) / (q.fifty_two_week_high - q.fifty_two_week_low), 1) AS pct_of_52w_range " +
  "FROM yfinance.main.symbol_reference r, LATERAL yfinance.main.quote(r.symbol) q " +
  "ORDER BY r.asset_type, pct_of_52w_range DESC, r.symbol";

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Yahoo Finance",
  "vgi.subtitle": "Keyless stock price history, live quotes and ticker lookup from Yahoo Finance.",
  "vgi.doc_llm":
    "Live and historical stock-market data from Yahoo Finance as SQL table functions. " +
    "Reach for it to pull OHLCV price history for a ticker, snapshot the current price and " +
    "day/52-week range for one or more tickers, or resolve a company name to its ticker " +
    "symbol. Keyless — no API key or secret. Symbols use Yahoo's convention (AAPL, BRK-B, " +
    "BTC-USD, ^GSPC). Data is Yahoo's unofficial public feed: best-effort, for informational use.",
  "vgi.doc_md":
    "## Yahoo Finance\n\n" +
    "Market data from Yahoo Finance's public, keyless endpoints as DuckDB table functions: " +
    "OHLCV price history over a named or explicit date range, current-price snapshots " +
    "(price, change, day & 52-week range, volume) for a list of tickers, and name-to-ticker " +
    "resolution.\n\n" +
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
    {
      name: "reference_52w_position",
      description:
        "Quote every instrument in the symbol_reference registry and place it in its 52-week range — " +
        "the registry supplies valid tickers of every asset type, quote supplies the live prices",
      sql: REFERENCE_52W_POSITION_SQL,
    },
  ]),
  // The agent-suitability suite (catalog only). The published tag carries ONLY `name` +
  // `prompt` — the grader fields (check_sql, success_criteria) live in the private sidecar
  // vgi-agent-tests.yaml, keyed by name, so the analyst agent never sees them (VGI416).
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "microsoft_ticker",
      prompt: "What stock ticker symbol does Microsoft Corporation trade under?",
    },
    {
      name: "apple_currency",
      prompt: "In what currency is Apple (AAPL) stock priced?",
    },
    {
      name: "apple_recent_close",
      prompt: "What was Apple's (AAPL) closing price on the most recent trading day?",
    },
    {
      name: "nvidia_vs_month_average",
      prompt:
        "Find NVIDIA's ticker by its company name, then tell me whether its latest daily close is above or below its average close over the past month, and by how much.",
    },
    {
      name: "etf_nearest_52w_high",
      prompt:
        "Of the ETFs listed in this catalog's symbol reference, which one is currently trading closest to its 52-week high?",
    },
    {
      name: "class_share_symbol_format",
      prompt:
        "Yahoo Finance writes class shares (like Berkshire Hathaway's Class B) with a special symbol format. Which ticker in this catalog's symbol reference illustrates that convention?",
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
    "## Market data\n\n" +
    "Time series of OHLCV candles, one-row-per-symbol pricing snapshots, and ticker lookup. " +
    "Use the time series for charting, returns and backtests; the snapshots for dashboards and " +
    "watchlists; and the lookup when you only know a company name.\n\n" +
    "Everything is keyless and takes a ticker (or a comma-separated list) plus optional named arguments. " +
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
    // Composed examples — each combines two or more of this schema's objects.
    {
      description:
        "Watchlist momentum check: compare each ticker's live quote with its own one-month average close " +
        "from history, to see which names are trading above or below their recent trend",
      sql:
        "WITH q AS (SELECT symbol, regular_market_price FROM yfinance.main.quote('AAPL,MSFT,GOOG')), " +
        "m AS (SELECT q.symbol, avg(h.close) AS avg_close_1mo FROM q, LATERAL yfinance.main.history(q.symbol, range := '1mo') h GROUP BY q.symbol) " +
        "SELECT q.symbol, q.regular_market_price, round(m.avg_close_1mo, 2) AS avg_close_1mo, " +
        "round(100 * (q.regular_market_price / m.avg_close_1mo - 1), 2) AS pct_vs_1mo_avg " +
        "FROM q JOIN m USING (symbol) ORDER BY pct_vs_1mo_avg DESC",
    },
    {
      description:
        "From company names straight to performance: search resolves each name to its best-matching ticker, " +
        "then history supplies three months of closes to rank the companies by return — no ticker knowledge needed",
      sql:
        "SELECT c.name, s.symbol, round(100 * (arg_max(h.close, h.timestamp) / arg_min(h.close, h.timestamp) - 1), 2) AS return_3mo_pct " +
        "FROM (VALUES ('apple'), ('nvidia'), ('costco')) c(name), " +
        "LATERAL yfinance.main.search(c.name, count := 1) s, " +
        "LATERAL yfinance.main.history(s.symbol, range := '3mo') h " +
        "GROUP BY c.name, s.symbol ORDER BY return_3mo_pct DESC, c.name",
    },
    {
      description:
        "Where does every asset class sit in its 52-week range? The symbol_reference registry supplies one valid " +
        "ticker per Yahoo convention (equity, ETF, index, crypto, FX) and quote prices them all in one pass",
      sql: REFERENCE_52W_POSITION_SQL,
    },
    {
      description:
        "How closely does each registry equity and ETF track the S&P 500? Pull six months of daily history for every " +
        "symbol_reference ticker, turn closes into daily returns, and correlate each against the ^GSPC index's returns",
      sql:
        "WITH px AS (SELECT r.symbol, h.timestamp, h.close / lag(h.close) OVER (PARTITION BY r.symbol ORDER BY h.timestamp) - 1 AS ret " +
        "FROM yfinance.main.symbol_reference r, LATERAL yfinance.main.history(r.symbol, range := '6mo') h " +
        "WHERE r.asset_type IN ('EQUITY', 'ETF', 'INDEX')) " +
        "SELECT a.symbol, round(corr(a.ret, b.ret), 3) AS corr_with_sp500 " +
        "FROM px a JOIN px b ON a.timestamp = b.timestamp AND b.symbol = '^GSPC' " +
        "WHERE a.symbol <> '^GSPC' GROUP BY a.symbol ORDER BY corr_with_sp500 DESC, a.symbol",
    },
  ]),
};

// A browsable, credential-free entry point (VGI146): the three table functions all take a
// symbol argument, so an agent has nothing to look at until it already knows a valid ticker.
// This curated registry demonstrates every Yahoo symbol convention the functions accept
// (plain equity, hyphenated class share, ETF, caret-prefixed index, crypto/FX pair). Its
// definition is a self-contained VALUES relation evaluated entirely by DuckDB — no worker
// call, no network, no secret — so `SELECT ... FROM yfinance.main.symbol_reference` always
// answers instantly.
const SYMBOL_REFERENCE_VIEW: ViewDescriptor = {
  name: "symbol_reference",
  definition:
    "SELECT symbol, name, asset_type, exchange, notes FROM (VALUES " +
    "('AAPL', 'Apple Inc.', 'EQUITY', 'NasdaqGS', 'Plain US common-stock ticker'), " +
    "('MSFT', 'Microsoft Corporation', 'EQUITY', 'NasdaqGS', 'Plain US common-stock ticker'), " +
    "('BRK-B', 'Berkshire Hathaway Inc. Class B', 'EQUITY', 'NYSE', 'Class share — the class suffix is written with a hyphen'), " +
    "('SPY', 'SPDR S&P 500 ETF Trust', 'ETF', 'NYSEArca', 'Exchange-traded fund'), " +
    "('VOO', 'Vanguard S&P 500 ETF', 'ETF', 'NYSEArca', 'Exchange-traded fund'), " +
    "('^GSPC', 'S&P 500 Index', 'INDEX', 'SNP', 'Market index — written with a caret prefix'), " +
    "('BTC-USD', 'Bitcoin USD', 'CRYPTOCURRENCY', 'CCC', 'Crypto pair — base and quote joined with a hyphen'), " +
    "('EURUSD=X', 'EUR/USD', 'CURRENCY', 'CCY', 'FX pair — written with an =X suffix')" +
    ") AS t(symbol, name, asset_type, exchange, notes)",
  comment:
    "A curated, credential-free registry of well-known tickers that demonstrates each Yahoo symbol " +
    "convention accepted by history, quote, and search. Browsable without any network call.",
  columnComments: {
    symbol: "The ticker exactly as Yahoo lists it — feed this into history, quote, or search.",
    name: "The human-readable instrument name.",
    asset_type: "The instrument class: EQUITY, ETF, INDEX, CRYPTOCURRENCY, or CURRENCY.",
    exchange: "The listing exchange (or pricing source) code.",
    notes: "Which symbol-format convention this row illustrates.",
  },
  tags: {
    "vgi.title": "Ticker Symbol Registry",
    "vgi.category": "reference",
    domain: "finance",
    "vgi.doc_llm":
      "A static, credential-free registry of well-known tickers, one row per symbol, giving its name, " +
      "asset type (EQUITY, ETF, INDEX, CRYPTOCURRENCY, CURRENCY), listing exchange, and the Yahoo " +
      "symbol-format convention it illustrates (plain equity, hyphenated class share like BRK-B, " +
      "caret-prefixed index like ^GSPC, crypto pair like BTC-USD, FX pair like EURUSD=X). Browse it to " +
      "learn valid symbol formats, then pass a symbol into history, quote, or search. It answers with no " +
      "network call, so it is the safe first thing to query.",
    "vgi.doc_md":
      "## symbol_reference\n\n" +
      "A browsable, credential-free registry of well-known tickers. One row per symbol, naming the " +
      "instrument, its asset type, its listing exchange, and the Yahoo symbol-format convention it " +
      "illustrates. It resolves entirely inside DuckDB — no network, no key — so it is the safe first " +
      "thing to look at. Once you have a `symbol`, pass it into `history`, `quote`, or `search`.",
    "vgi.keywords": JSON.stringify([
      "symbols",
      "tickers",
      "reference",
      "registry",
      "symbol format",
      "conventions",
      "equity",
      "ETF",
      "index",
      "crypto",
    ]),
    "vgi.example_queries": JSON.stringify([
      {
        description: "List the reference tickers for a given asset type",
        sql: "SELECT symbol, name, exchange FROM yfinance.main.symbol_reference WHERE asset_type = 'ETF' ORDER BY symbol",
      },
      {
        description: "Count the reference symbols grouped by asset type",
        sql: "SELECT asset_type, count(*) AS n FROM yfinance.main.symbol_reference GROUP BY asset_type ORDER BY n DESC",
      },
    ]),
  },
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
        views: [SYMBOL_REFERENCE_VIEW],
        functions,
      },
    ],
  };
}
