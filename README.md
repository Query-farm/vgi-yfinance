# vgi-yfinance

A [VGI](https://query.farm) worker that exposes **Yahoo Finance** market data as DuckDB
table functions — historical candles, current quotes, and symbol search — with no API key.

| Function | What it returns | Yahoo endpoint |
| --- | --- | --- |
| `yf.history(symbol, …)` | OHLCV candles for one symbol | `v8/finance/chart` |
| `yf.quote(symbols)` | Current price snapshot for one or more symbols | `v8/finance/chart` (`meta`) |
| `yf.search(query, …)` | Ticker-symbol lookup by name / partial symbol | `v1/finance/search` |

Everything rides Yahoo's **keyless, un-gated** planes — there is no secret to create and
no login. (The worker deliberately avoids the `v7/finance/quote` and `v10/quoteSummary`
planes, which now return `401 Unauthorized` from datacenter IPs even with a crumb.)

> **Status:** released — [`v0.6.0`](https://github.com/Query-farm/vgi-yfinance/releases).
> CI is green (unit tests, own-source typecheck, haybarn SQLLogic E2E against a real DuckDB
> + the community `vgi` extension, and a `vgi-lint` metadata-quality gate at 100/100), and
> every function is verified live against Yahoo.

Current source builds use VGI 0.50.0 / RPC 0.29.7 and speak protocol **3.3** (3.2 extensions cannot attach).
Use Haybarn 2.0 with a current signed VGI extension; refresh it with
`FORCE INSTALL vgi FROM community;`.

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-yfinance/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'yfinance' AS yfinance (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-yfinance@v0.6.0');

-- Resolve a company name to candidate tickers
SELECT symbol, short_name FROM yfinance.main.search('apple') LIMIT 3;

-- Fetch the last few daily candles for a ticker
SELECT timestamp, close FROM yfinance.main.history('AAPL', range := '5d') ORDER BY timestamp;
```

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.6.0` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'yfinance' AS yfinance (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-yfinance:0.6.0');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-yfinance/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable. To check the signature and build provenance as well:

  ```sh
  cosign verify-blob \
    --bundle vgi-yfinance-v0.6.0-osx_arm64.tar.gz.cosign.bundle \
    --certificate-identity-regexp '^https://github\.com/Query-farm/vgi-actions/\.github/workflows/ts-release\.yml@' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    vgi-yfinance-v0.6.0-osx_arm64.tar.gz

  gh attestation verify vgi-yfinance-v0.6.0-osx_arm64.tar.gz \
    --repo Query-farm/vgi-yfinance --signer-repo Query-farm/vgi-actions
  ```

The [Usage](#usage) examples below use the shorter alias `yf` (`yf.history(...)`); attach with `AS yf` instead of `AS yfinance` to paste them as-is.

### Build from source

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION '/path/to/vgi-yfinance/bin/vgi-yfinance-worker');
```

`bin/vgi-yfinance-worker` is a small wrapper that launches `src/worker.ts` under Bun.

Tests, typecheck and the E2E suite are described under [Development](#development).

## Usage

### History — OHLCV candles

```sql
-- Last month of daily candles:
SELECT * FROM yf.history('AAPL');

-- One year of weekly candles:
SELECT * FROM yf.history('MSFT', range := '1y', bar := '1wk');

-- An explicit date range (overrides `range`):
SELECT timestamp, close, volume
FROM yf.history('SPY', start_date := '2024-01-01', end_date := '2024-12-31');

-- Every ticker in a table, via LATERAL (the symbol may be a column):
SELECT w.sym, max(h.close) AS high_close
FROM (VALUES ('AAPL'), ('MSFT')) w(sym), LATERAL yf.history(w.sym, range := '1mo') h
GROUP BY w.sym
ORDER BY w.sym;
```

| Arg | Default | Notes |
| --- | --- | --- |
| `symbol` | *(required)* | A single ticker, e.g. `AAPL`, `BTC-USD`, `^GSPC` — a literal or a column (`LATERAL`). A `NULL` yields no rows. |
| `range` | `'1mo'` | `1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max`. Ignored when `start_date` is set. |
| `bar` | `'1d'` | Candle width (Yahoo's `interval`): `1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo`. Named `bar`, not `interval`, because `INTERVAL` is a reserved SQL keyword. |
| `prepost` | `false` | Include pre/post-market candles. |
| `start_date` / `end_date` | `''` | `YYYY-MM-DD`. When `start_date` is set, `[start_date, end_date)` overrides `range`; `end_date` defaults to now. A malformed date, an `end_date` without `start_date`, or an `end_date` not after `start_date` fails the query. (Named `*_date` because `END` is a reserved SQL keyword.) |

Columns: `symbol`, `timestamp` (`TIMESTAMP WITH TIME ZONE`, UTC), `open`, `high`, `low`,
`close`, `adjclose` (`DOUBLE`), `volume` (`BIGINT`). Thin/halted candles come back as `NULL`
cells, never a crash. Yahoo often leaves the newest candle's `close` empty for a while, even
after the session ends; the worker fills that one cell from the latest market price when
that price falls inside the candle (never for a past `start_date`/`end_date` window).

History results advertise a **60-second client-cache lifetime**, with per-symbol
reuse enabled on the correlated `LATERAL` path. Matching calls can reuse a response
during that minute, including symbols repeated across different `LATERAL` inputs.
Use that form to observe exchange-cache hits; the literal-only scan path does not
currently use this cache. Changing the date range, bar
interval, or other request arguments requires a matching cache entry. Today's
candle may still be developing, and Yahoo can correct older data: this is a
short-lived snapshot, not a promise that historical prices never change.
`quote()` and `search()` do not advertise result caching.

### Quote — current snapshot

```sql
SELECT symbol, regular_market_price, regular_market_change_percent
FROM yf.quote('AAPL,MSFT,GOOG')
ORDER BY symbol;

-- One quote per row of a table, via LATERAL:
SELECT w.sym, q.regular_market_price
FROM (VALUES ('AAPL'), ('MSFT')) w(sym), LATERAL yf.quote(w.sym) q
ORDER BY w.sym;
```

`symbols` is a comma/space-separated list, as a literal or a column (`LATERAL`). One
keyless chart request is made per distinct symbol (at most 8 in flight); a bad ticker is
dropped rather than failing the batch. Columns:
`symbol`, `short_name`, `long_name`, `currency`, `exchange`, `quote_type`,
`regular_market_price`, `regular_market_change`, `regular_market_change_percent`,
`regular_market_volume`, `regular_market_day_high`, `regular_market_day_low`,
`regular_market_previous_close`, `fifty_two_week_high`, `fifty_two_week_low`,
`regular_market_time`.

`currency` is the quote currency as Yahoo reports it; London listings use `GBp` (pence).
`market cap` is not available on the keyless plane and is intentionally not emitted.

### Search — symbol lookup

```sql
SELECT symbol, long_name, exchange, quote_type
FROM yf.search('vanguard', count := 20)
ORDER BY score DESC;

-- The best-matching ticker for every company name in a table, via LATERAL:
SELECT c.name, s.symbol
FROM (VALUES ('apple'), ('microsoft')) c(name), LATERAL yf.search(c.name, count := 1) s
ORDER BY c.name;
```

Columns: `symbol`, `short_name`, `long_name`, `exchange`, `quote_type`, `type_disp`,
`score`. `query` may be a literal or a column (`LATERAL`); `count` (default 8, per query) is
clamped to `[1, 50]`; news results are dropped. Yahoo's top hit is not always a stock:
`search('apple')` ranks Apple's CME stock futures (`SAAPL=F`, …) right after `AAPL`, so filter on
`quote_type = 'EQUITY'` when you want the company's shares.

### Combining functions

The functions compose: any of them can read its input from a column with `LATERAL`, so
one function's output feeds the next, and plain SQL joins the results. These are the
same composed examples the catalog publishes (written with the `yf` alias).

Rank companies by three-month total return starting from their names — `search`
resolves each name to its top-scoring stock, `history` supplies dividend-adjusted closes:

```sql
WITH pick AS (
  SELECT c.name, s.symbol
  FROM (VALUES ('apple'), ('costco'), ('walmart')) c(name),
       LATERAL yf.search(c.name, count := 5) s
  WHERE s.quote_type = 'EQUITY'
  QUALIFY row_number() OVER (PARTITION BY c.name ORDER BY s.score DESC) = 1)
SELECT p.name, p.symbol,
       round(100 * (arg_max(h.adjclose, h.timestamp) / arg_min(h.adjclose, h.timestamp) - 1), 2) AS total_return_3mo_pct
FROM pick p, LATERAL yf.history(p.symbol, range := '3mo') h
GROUP BY p.name, p.symbol
ORDER BY total_return_3mo_pct DESC, p.name;
```

Compare each live `quote` with the average of its daily closes over the past month:

```sql
WITH q AS (SELECT symbol, regular_market_price FROM yf.quote('AAPL,MSFT,GOOG')),
     m AS (SELECT q.symbol, avg(h.close) AS avg_close_1mo
           FROM q, LATERAL yf.history(q.symbol, range := '1mo') h
           GROUP BY q.symbol)
SELECT q.symbol, q.regular_market_price, round(m.avg_close_1mo, 2) AS avg_close_1mo,
       round(100 * (q.regular_market_price / m.avg_close_1mo - 1), 2) AS pct_vs_1mo_avg
FROM q JOIN m USING (symbol)
ORDER BY pct_vs_1mo_avg DESC, q.symbol;
```

Price foreign listings in US dollars — the second `quote` fetches the FX pair named by
each listing's own `currency` (`EUR=X` is euros per dollar):

```sql
SELECT l.symbol, l.currency, l.regular_market_price AS local_price, fx.symbol AS fx_pair,
       round(l.regular_market_price / fx.regular_market_price, 2) AS price_usd
FROM yf.quote('ASML.AS,MC.PA,7203.T,NESN.SW') l,
     LATERAL yf.quote(l.currency || '=X') fx
ORDER BY price_usd DESC, l.symbol;
```

The static `yf.symbol_reference` registry (one valid ticker per Yahoo symbol convention,
no network) is a ready-made input. Place every asset class in its 52-week range:

```sql
SELECT r.asset_type, r.symbol, q.regular_market_price,
       round(100 * (q.regular_market_price - q.fifty_two_week_low)
             / nullif(q.fifty_two_week_high - q.fifty_two_week_low, 0), 1) AS pct_of_52w_range
FROM yf.symbol_reference r, LATERAL yf.quote(r.symbol) q
ORDER BY r.asset_type, pct_of_52w_range DESC, r.symbol;
```

The catalog also ships a name-to-live-price lookup (`search` → `quote`) and a six-month
return correlation of the registry's equities and ETFs with the S&P 500 (`symbol_reference`
→ `history`); see `src/examples.ts`.

## Development

```bash
bun install
bun test            # unit tests (pure driver + Arrow batch builders + HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs uv and network access; it manages the matched Haybarn tools
and current signed VGI extension:

```bash
./run_tests.sh  # uv installs matching Haybarn 2.0.0rc11 tools and refreshes vgi
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check)
(catalog/function docs, tags, per-argument docs, examples, and an agent-suitability suite);
CI runs it as a gate. Locally (reads `vgi-lint.toml`; `--execute` also runs every example
against Yahoo):

```bash
uvx --prerelease allow --from 'vgi-lint-check>=2.5.1' vgi-lint lint --execute --execute-mode run
```

The agent-suitability graders live in `vgi-agent-tests.yaml`. Each task asks the analyst to
save its answer as a temporary view, and the grader compares that view with live ground truth.

The pure request/response logic lives in `src/yahoo.ts` and is fully unit-tested against
an in-process fake (`test/fake-yahoo.ts`) — no network. The single module that touches
the network is `src/client.ts` (it sets the browser-like User-Agent Yahoo requires); it
is verified live rather than in the unit suite.

## Layout

```
src/yahoo.ts      Pure driver: URL builders + response→row mappers (no network, no SDK)
src/client.ts     Real fetch client (User-Agent; keyless — no crumb/cookie needed)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The three defineRowTransformFunction() definitions (LATERAL-capable)
src/examples.ts   Composed example queries (shared by the catalog and the functions)
src/catalog.ts    The `yfinance` catalog descriptor + symbol_reference view (no secret type)
src/worker.ts     Stdio worker entry: wires the real client into the functions
src/cf.ts         Cloudflare Worker entry (same wiring, HTTP transport)
scripts/serve.ts  Bun HTTP entry (same wiring)
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
test/             Unit tests (bun test) + test/sql/ SQLLogic E2E (./run_tests.sh)
```

## Data source & terms

Data comes from Yahoo Finance's undocumented public JSON endpoints. It is provided for
personal, informational use; consult
[Yahoo's terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) before any
redistribution or commercial use. This worker is not affiliated with or endorsed by Yahoo.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
