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

> **Status:** released — [`v0.1.0`](https://github.com/Query-farm/vgi-yfinance/releases).
> CI is green (unit tests, own-source typecheck, haybarn SQLLogic E2E against a real DuckDB
> + the community `vgi` extension, and a `vgi-lint` metadata-quality gate at 100/100), and
> every function is verified live against Yahoo.

## Install / attach

### Option A — prebuilt binary (recommended)

Each [release](https://github.com/Query-farm/vgi-yfinance/releases) ships a self-contained
executable per platform, so the host needs **neither Bun nor `node_modules`**. Archives are
named `vgi-yfinance-<tag>-<platform>.tar.gz` for `linux_amd64`, `linux_arm64`, `osx_amd64`,
`osx_arm64`, and `windows_amd64`, each with a SHA256, a keyless **cosign** signature, and a
**SLSA** build-provenance attestation.

```bash
# download the archive for your platform from the releases page, then:
tar xzf vgi-yfinance-v0.1.0-osx_arm64.tar.gz     # → vgi-yfinance-worker
```

```sql
LOAD vgi;
ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION '/path/to/vgi-yfinance-worker');
```

Optionally verify the download before trusting it:

```sh
cosign verify-blob \
  --bundle vgi-yfinance-v0.1.0-osx_arm64.tar.gz.cosign.bundle \
  --certificate-identity-regexp '^https://github\.com/Query-farm/vgi-actions/\.github/workflows/ts-release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  vgi-yfinance-v0.1.0-osx_arm64.tar.gz

gh attestation verify vgi-yfinance-v0.1.0-osx_arm64.tar.gz \
  --repo Query-farm/vgi-yfinance --signer-repo Query-farm/vgi-actions
```

### Option B — from source (Bun)

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION '/path/to/vgi-yfinance/bin/vgi-yfinance-worker');
```

`bin/vgi-yfinance-worker` is a small wrapper that launches `src/worker.ts` under Bun.

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
```

| Arg | Default | Notes |
| --- | --- | --- |
| `symbol` | *(required)* | A single ticker, e.g. `AAPL`, `BTC-USD`, `^GSPC`. |
| `range` | `'1mo'` | `1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max`. Ignored when `start_date` is set. |
| `bar` | `'1d'` | Candle width (Yahoo's `interval`): `1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo`. Named `bar`, not `interval`, because `INTERVAL` is a reserved SQL keyword. |
| `prepost` | `false` | Include pre/post-market candles. |
| `start_date` / `end_date` | `''` | `YYYY-MM-DD`. When `start_date` is set, `[start_date, end_date)` overrides `range`; `end_date` defaults to now. (Named `*_date` because `END` is a reserved SQL keyword.) |

Columns: `symbol`, `timestamp` (`TIMESTAMP` UTC), `open`, `high`, `low`, `close`,
`adjclose` (`DOUBLE`), `volume` (`BIGINT`). Thin/halted candles come back as `NULL`
cells, never a crash.

### Quote — current snapshot

```sql
SELECT symbol, regular_market_price, regular_market_change_percent
FROM yf.quote('AAPL,MSFT,GOOG');
```

`symbols` is a comma/space-separated list. One keyless chart request is made per symbol
(in parallel); a bad ticker is dropped rather than failing the batch. Columns:
`symbol`, `short_name`, `long_name`, `currency`, `exchange`, `quote_type`,
`regular_market_price`, `regular_market_change`, `regular_market_change_percent`,
`regular_market_volume`, `regular_market_day_high`, `regular_market_day_low`,
`regular_market_previous_close`, `fifty_two_week_high`, `fifty_two_week_low`,
`regular_market_time`.

`market cap` is not available on the keyless plane and is intentionally not emitted.

### Search — symbol lookup

```sql
SELECT symbol, long_name, exchange, quote_type
FROM yf.search('vanguard', count := 20);
```

Columns: `symbol`, `short_name`, `long_name`, `exchange`, `quote_type`, `type_disp`,
`score`. `count` (default 8) is clamped to `[1, 50]`; news results are dropped.

## Development

```bash
bun install
bun test            # unit tests (pure driver + Arrow batch builders)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install haybarn-unittest
echo "INSTALL vgi FROM community;" | uvx haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check)
(catalog/function docs, tags, per-argument docs, examples, and an agent-suitability suite);
CI runs it as a gate. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-yfinance-worker --fail-on info
```

The pure request/response logic lives in `src/yahoo.ts` and is fully unit-tested against
an in-process fake (`test/fake-yahoo.ts`) — no network. The single module that touches
the network is `src/client.ts` (it sets the browser-like User-Agent Yahoo requires); it
is verified live rather than in the unit suite.

## Layout

```
src/yahoo.ts      Pure driver: URL builders + response→row mappers (no network, no SDK)
src/client.ts     Real fetch client (User-Agent; keyless — no crumb/cookie needed)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The three defineTableFunction() definitions
src/catalog.ts    The `yfinance` catalog descriptor (no secret type — keyless)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from Yahoo Finance's undocumented public JSON endpoints. It is provided for
personal, informational use; consult
[Yahoo's terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) before any
redistribution or commercial use. This worker is not affiliated with or endorsed by Yahoo.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
