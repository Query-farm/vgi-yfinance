# vgi-yfinance — agent notes

A VGI (DuckDB) worker exposing Yahoo Finance market data as three table functions:
`history` (OHLCV), `quote` (snapshot), `search` (symbol lookup). TypeScript, runs on Bun,
built on `@query-farm/vgi` (the TS SDK). Keyless — no secret type, no auth.

## Architecture (keep this separation)

- **`src/yahoo.ts` — the pure driver.** URL builders + response→row mappers, plus thin
  `fetch{History,Quote,Search}` orchestrators that take an injected `get(url) => Promise`.
  NO network, NO SDK import. This is what the unit tests exercise. All Yahoo response
  parsing is defensive: a missing branch degrades to `[]` / `null` cells, never a throw
  (except `history` surfacing Yahoo's own `error` envelope).
- **`src/client.ts` — the only network module.** `makeYahooGet()` returns the real `get`.
  Its one job beyond `fetch` is setting the browser-like User-Agent Yahoo requires. Not
  unit-tested (like the azure workers' MSAL minter); verified live.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Finance data has a stable
  shape, so we emit real typed columns (`Float64`/`Int64`/`Timestamp[s,UTC]`), not JSON.
  Timestamp/Int64 canonical is a **bigint** of the type's unit — see `bigOrNull`.
- **`src/functions.ts`** — three `defineTableFunction`s. State is a `{done}` flag only
  (fully serializable → HTTP transport safe). Each is a single-shot snapshot: no cursor,
  no watermark (a quote/chart read has no cross-scan resume state).
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the
  entry that wires the real client into the functions.

## Yahoo endpoint facts (why the design is what it is)

- `v8/finance/chart/{symbol}` — **keyless.** Backs `history` (timestamp+indicators) AND
  `quote` (the `meta` block: price, day/52wk range, volume, prev close, names). This is
  the one endpoint that works from datacenter IPs without a crumb.
- `v1/finance/search` — **keyless.** Backs `search`.
- `v7/finance/quote` + `v10/finance/quoteSummary` — **avoided.** Now crumb-gated AND
  `401 Unauthorized` from datacenter IPs even with a valid crumb. Do NOT reintroduce them
  for `quote`; the chart `meta` path is the robust substitute. (`market_cap` isn't in
  `meta`, so it's intentionally not a column.)
- A browser-like `User-Agent` is mandatory on every request or Yahoo rejects it.

## Commands

```bash
bun install
bun test            # 27 tests: pure driver (SDK-free) + Arrow batch builders (needs SDK)
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` needs `uv tool install haybarn-unittest` and the vgi extension installed
once via `echo "INSTALL vgi FROM community;" | uvx haybarn-cli`. It sets
`VGI_TEST_WORKER=bin/vgi-yfinance-worker` + `VGI_WORKER_CATALOG_NAME=yfinance` and runs
`test/sql/*.test`. The `.test` backbone is DESCRIBE-based schema asserts (bind-only → no
network → deterministic); a few live-invariant asserts hit Yahoo (fine for an egress
connector). CI runs both this and the reusable `ts-ci.yml` (see `.github/workflows/ci.yml`).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline)
— `bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^6.0.3` (5.x descends into SDK `.ts` source and reports external errors).

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION '/path/to/vgi-yfinance/bin/vgi-yfinance-worker');
SELECT * FROM yf.history('AAPL', range := '6mo');
```

Not yet covered by a haybarn `.test` (no DuckDB-live E2E). If adding one, mirror the
`.test` layout under a built `vgi` extension per the vgi-typescript CLAUDE.md.

## SDK dependency (@query-farm/vgi ^0.8.0)

Depends on `@query-farm/vgi ^0.8.0` from npm, with peers `@query-farm/apache-arrow ^21.1.1`
+ `@query-farm/vgi-rpc ^0.9.0` (single arrow copy → no dual-instance "Unrecognized type
NONE"). 0.8.0 is the first published SDK that emits the `catalog_attach` `attach_catalogs`
field the current community vgi extension requires. HISTORY: this repo briefly vendored
`query-farm-vgi-0.7.0.tgz` (packed from local vgi-typescript HEAD) because published npm
0.7.0 lacked that field and ATTACH failed with *"field count differs: expected 15, actual
14"*; the tarball was dropped once 0.8.0 shipped. If a fresh `bun install` can't find a
newer published version, clear the stale registry cache: `bun pm cache rm`.

## Reserved-keyword arg names (real UX trap, not just a test quirk)

DuckDB's parser rejects a bare `<reserved> := value`. `history` therefore does NOT name its
args `interval` or `end` — both are reserved (`INTERVAL` type, `CASE…END`). They are `bar`
and `end_date` (+ `start_date` for symmetry). Positional args don't help — every arg but the
leading `symbol` is named-only. Before naming a new arg, check it isn't a DuckDB keyword.

## Gotchas

- Emit `bigint` (not `number`) for `Int64`/`Timestamp` columns via `batchFromColumns`.
- `quote` fans out one request per symbol via `Promise.all`; a per-symbol throw is caught
  and that symbol dropped — keep that resilience.
- Don't add a secret type; this worker is keyless by design.
