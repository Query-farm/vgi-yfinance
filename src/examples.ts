// Composed examples: queries that combine two or more of this catalog's objects
// (history, quote, search, symbol_reference) the way analysts actually use them.
//
// Each one is defined ONCE here and referenced from two places:
//   - the per-object example list of the object that drives the query (functions.ts /
//     catalog.ts's symbol_reference view), within its first five entries, because the
//     vgi-lint agent simulator only shows describe_table/describe_function examples; and
//   - the schema-level vgi.example_queries list (catalog.ts).
// Sharing the constant keeps the SQL byte-identical, so the linter dedupes the copies.
//
// All of them read live Yahoo data, so none carries an expected_result.

export interface ExampleQuery {
  description: string;
  sql: string;
}

// The best EQUITY match per company name, by Yahoo's relevance score. Filtering on
// quote_type matters: search('apple') ranks Apple's CME stock futures (SAAPL=F, …) right
// after AAPL, and count := 1 alone would trust whatever Yahoo ranks first.
const BEST_EQUITY_PICK =
  "LATERAL yfinance.main.search(c.name, count := 5) s WHERE s.quote_type = 'EQUITY' " +
  "QUALIFY row_number() OVER (PARTITION BY c.name ORDER BY s.score DESC) = 1";

/** search -> history: rank companies (by name, no tickers) by 3-month total return. */
export const NAMES_TO_TOTAL_RETURN: ExampleQuery = {
  description:
    "Rank companies by three-month total return starting from their names: search resolves each name to its " +
    "top-scoring EQUITY ticker, then history supplies dividend-adjusted closes (adjclose) to compute the return",
  sql:
    "WITH pick AS (SELECT c.name, s.symbol FROM (VALUES ('apple'), ('costco'), ('walmart')) c(name), " +
    BEST_EQUITY_PICK +
    ") SELECT p.name, p.symbol, " +
    "round(100 * (arg_max(h.adjclose, h.timestamp) / arg_min(h.adjclose, h.timestamp) - 1), 2) AS total_return_3mo_pct " +
    "FROM pick p, LATERAL yfinance.main.history(p.symbol, range := '3mo') h " +
    "GROUP BY p.name, p.symbol ORDER BY total_return_3mo_pct DESC, p.name",
};

/** search -> quote: company name to live price, currency and listing. */
export const NAMES_TO_LIVE_QUOTE: ExampleQuery = {
  description:
    "Look up the live price of companies you only know by name: search resolves each name to its top-scoring " +
    "EQUITY ticker, then quote returns that listing's exchange, currency, price and change versus the previous close",
  sql:
    "WITH pick AS (SELECT c.name, s.symbol FROM (VALUES ('netflix'), ('tesla'), ('toyota')) c(name), " +
    BEST_EQUITY_PICK +
    ") SELECT p.name, q.symbol, q.long_name, q.exchange, q.currency, q.regular_market_price, " +
    "round(q.regular_market_change_percent, 2) AS change_pct " +
    "FROM pick p, LATERAL yfinance.main.quote(p.symbol) q ORDER BY p.name",
};

/** quote -> history: live price against the ticker's own one-month average close. */
export const QUOTE_VS_MONTH_AVERAGE: ExampleQuery = {
  description:
    "Watchlist momentum check: compare each ticker's live quote price with the average of its daily closes over " +
    "the past month from history, to see which names trade above or below their recent level",
  sql:
    "WITH q AS (SELECT symbol, regular_market_price FROM yfinance.main.quote('AAPL,MSFT,GOOG')), " +
    "m AS (SELECT q.symbol, avg(h.close) AS avg_close_1mo FROM q, LATERAL yfinance.main.history(q.symbol, range := '1mo') h GROUP BY q.symbol) " +
    "SELECT q.symbol, q.regular_market_price, round(m.avg_close_1mo, 2) AS avg_close_1mo, " +
    "round(100 * (q.regular_market_price / m.avg_close_1mo - 1), 2) AS pct_vs_1mo_avg " +
    "FROM q JOIN m USING (symbol) ORDER BY pct_vs_1mo_avg DESC, q.symbol",
};

/** quote -> quote: foreign listings converted to US dollars through their FX pair. */
export const FOREIGN_LISTINGS_IN_USD: ExampleQuery = {
  description:
    "Price foreign listings in US dollars: quote each listing, then quote the FX pair named by its own currency " +
    "column (EUR=X is euros per dollar, JPY=X yen per dollar) and divide. London listings quote in pence " +
    "(currency GBp) and would also need dividing by 100, so none is included",
  sql:
    "SELECT l.symbol, l.currency, l.regular_market_price AS local_price, fx.symbol AS fx_pair, " +
    "fx.regular_market_price AS units_per_usd, round(l.regular_market_price / fx.regular_market_price, 2) AS price_usd " +
    "FROM yfinance.main.quote('ASML.AS,MC.PA,7203.T,NESN.SW') l, LATERAL yfinance.main.quote(l.currency || '=X') fx " +
    "ORDER BY price_usd DESC, l.symbol",
};

/** symbol_reference -> quote: every asset class placed in its 52-week range. */
export const REFERENCE_52W_POSITION: ExampleQuery = {
  description:
    "Where does each asset class sit in its 52-week range? Quote every symbol_reference ticker (equity, ETF, " +
    "index, crypto, FX) and show its position in the range (0 = at the low, 100 = at the high) and its percent " +
    "distance from the 52-week high",
  sql:
    "SELECT r.asset_type, r.symbol, q.regular_market_price, " +
    "round(100 * (q.regular_market_price - q.fifty_two_week_low) / nullif(q.fifty_two_week_high - q.fifty_two_week_low, 0), 1) AS pct_of_52w_range, " +
    "round(100 * (q.regular_market_price / q.fifty_two_week_high - 1), 1) AS pct_from_52w_high " +
    "FROM yfinance.main.symbol_reference r, LATERAL yfinance.main.quote(r.symbol) q " +
    "ORDER BY r.asset_type, pct_of_52w_range DESC, r.symbol",
};

/** symbol_reference -> history (self-joined): correlation of daily returns with ^GSPC. */
export const REFERENCE_CORRELATION_SP500: ExampleQuery = {
  description:
    "How closely does each registry equity and ETF track the S&P 500? Pull six months of daily history for the " +
    "symbol_reference equities, ETFs and the ^GSPC index, turn dividend-adjusted closes into daily returns, and " +
    "correlate each ticker's returns with the index's on matching trading days",
  sql:
    "WITH px AS (SELECT r.symbol, h.timestamp, h.adjclose / lag(h.adjclose) OVER (PARTITION BY r.symbol ORDER BY h.timestamp) - 1 AS ret " +
    "FROM yfinance.main.symbol_reference r, LATERAL yfinance.main.history(r.symbol, range := '6mo') h " +
    "WHERE r.asset_type IN ('EQUITY', 'ETF', 'INDEX')) " +
    "SELECT a.symbol, round(corr(a.ret, b.ret), 3) AS corr_with_sp500 " +
    "FROM px a JOIN px b ON a.timestamp = b.timestamp AND b.symbol = '^GSPC' " +
    "WHERE a.symbol <> '^GSPC' GROUP BY a.symbol ORDER BY corr_with_sp500 DESC, a.symbol",
};

/** Every composed example, in the order the schema-level list shows them. */
export const COMPOSED_EXAMPLES: ExampleQuery[] = [
  NAMES_TO_TOTAL_RETURN,
  NAMES_TO_LIVE_QUOTE,
  QUOTE_VS_MONTH_AVERAGE,
  FOREIGN_LISTINGS_IN_USD,
  REFERENCE_52W_POSITION,
  REFERENCE_CORRELATION_SP500,
];
