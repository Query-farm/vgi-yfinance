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
  Its one job beyond `fetch` is setting the browser-like User-Agent Yahoo requires. No
  dedicated unit test (like the azure workers' MSAL minter); exercised live by the
  HTTP-transport E2E test (`test/http-transport.test.ts`, which uses the real `get`).
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Finance data has a stable
  shape, so we emit real typed columns (`Float64`/`Int64`/`Timestamp[s,UTC]`), not JSON.
  Timestamp/Int64 canonical is a **bigint** of the type's unit — see `bigOrNull`.
- **`src/functions.ts`** — all three are **blended row-transform** functions
  (`defineRowTransformFunction`) so they work in `LATERAL`: the positional arg (`symbol` /
  `symbols` / `query`) is a per-row INPUT COLUMN read off the batch, and named args
  (`range`, `bar`, `count`, …) are `namedArgs` — bind-time literals on `params.args`. A plain `defineTableFunction`
  fails bind with *"does not support lateral join column parameters"*. Rules: no finalize;
  every emit carries `parentRowsMetadata` (1->N — without it the extension stamps outer
  columns from the wrong row); a NULL/blank input row emits nothing (no bind-time
  "required" error any more). Each chunk fetches DISTINCT symbols via `mapLimit(…,
  MAX_CONCURRENCY=8)` — a chunk is up to 2048 rows. No per-call state at all, so nothing
  rides the HTTP state token.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the
  stdio entry that wires the real client into the functions. Two more entries do the same
  wiring — `scripts/serve.ts` (Bun HTTP) and `src/cf.ts` (Cloudflare Worker) — so adding
  a function means updating all three.
- **Arrow imports go through `@query-farm/vgi/worker-cf`, never `@query-farm/apache-arrow`
  or the package root** (load-bearing for the Cloudflare build). `schema.ts`/`functions.ts`
  build types with vgi's backend-agnostic factories (`utf8()`, `float64()`, `timestamp()`…):
  under workerd vgi swaps in the flechette backend, so apache-arrow objects wouldn't match,
  and the root re-exports the Node-only stdio `Worker`, which breaks the bundle. `worker-cf`
  doesn't export `ArgumentValidationError` (nothing here throws one any more — blank args
  just yield no rows). Type-only root imports (catalog.ts) are fine.

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
bun test            # 30 tests: pure driver (SDK-free) + Arrow batch builders + HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` needs `uv tool install haybarn-unittest` and the vgi extension installed
once via `echo "INSTALL vgi FROM community;" | uvx haybarn-cli`. It sets
`VGI_TEST_WORKER=bin/vgi-yfinance-worker` (override it with a URL to run the same suite
over HTTP, e.g. `VGI_TEST_WORKER=http://localhost:8787 ./run_tests.sh` against `wrangler
dev`) + `VGI_WORKER_CATALOG_NAME=yfinance` and runs `test/sql/*.test`. Each `.test` does an
explicit `LOAD httpfs` (the HTTP transport needs it; `run_tests.sh` installs it): NOT
`require httpfs`, which the haybarn runner only satisfies for statically linked extensions,
so every file silently skips. A failed HTTP ATTACH also reports as a *skip* ("skip on
error_message matching 'HTTP'"), not a failure — an all-skipped run means it didn't connect. The `.test` backbone is DESCRIBE-based schema asserts (bind-only → no
network → deterministic); a few live-invariant asserts hit Yahoo (fine for an egress
connector). CI runs both this and the reusable `ts-ci.yml` (see `.github/workflows/ci.yml`).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline)
— `bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^7.0.2` (5.x descends into SDK `.ts` source and reports external errors).

## Cloudflare Workers

`src/cf.ts` + `wrangler.toml`: `bun run cf:dev` (local workerd on :8787), `bun run
cf:deploy`. The `workerd` export condition selects flechette automatically — the bundle
contains no apache-arrow (~706 KiB gzip at vgi 0.36.2; check with `bunx wrangler deploy
--dry-run --outdir <dir>`). Before the first real deploy set the state-token key once:
`bun run cf:secret` (random 32-byte hex → `wrangler secret put VGI_SIGNING_KEY`). A stable
key is REQUIRED — isolates don't share memory, so bind→scan landing on two isolates fails
without it. `createVgiFetch` needs `landingInfo` passed explicitly (serveVgiWorker derives it
for the Bun entry).

Live at `https://vgi-yfinance.rusty-bb6.workers.dev` (first deployed 2026-09-24). Test it
with `VGI_TEST_WORKER=https://vgi-yfinance.rusty-bb6.workers.dev ./run_tests.sh`. Yahoo's
keyless chart/search planes answer Cloudflare's datacenter egress fine (a 5×15-symbol
`quote` burst saw no 429s) — unlike the crumb-gated v7/v10 planes, which stay avoided. A
brand-new `workers.dev` route flaps 404/200 for ~a minute after the first deploy; the vgi
extension then fails ATTACH with *"capability discovery failed (HTTP 404)"* — wait, retry.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION '/path/to/vgi-yfinance/bin/vgi-yfinance-worker');
SELECT * FROM yf.history('AAPL', range := '6mo');
```

Not yet covered by a haybarn `.test` (no DuckDB-live E2E). If adding one, mirror the
`.test` layout under a built `vgi` extension per the vgi-typescript CLAUDE.md.

## SDK dependency (@query-farm/vgi ^0.36.2)

Depends on `@query-farm/vgi ^0.36.2` from npm, with peers `@query-farm/apache-arrow ^21.1.1`
+ `@query-farm/vgi-rpc ^0.25.4` (single arrow copy → no dual-instance "Unrecognized type
NONE"). The vgi/vgi-rpc pair is version-locked — vgi 0.36.x declares a peer range of
`>=0.25.4 <0.26.0` on vgi-rpc — so bump BOTH together or `bun install` reports a peer
conflict. 0.29 also made `createVgiFetch`'s `landingInfo` REQUIRED (worker name/doc/version
for the `GET {prefix}/` landing surface); `test/http-transport.test.ts` passes it. If a
fresh `bun install` can't find a newer published version, clear the stale registry cache:
`bun pm cache rm`.

HISTORY (pre-0.8, resolved): the repo briefly vendored `query-farm-vgi-0.7.0.tgz` because
published npm 0.7.0 lacked the `catalog_attach` `attach_catalogs` field and ATTACH failed
with *"field count differs: expected 15, actual 14"*. 0.8.0 shipped the field; the tarball
was dropped.

## Reserved-keyword arg names (real UX trap, not just a test quirk)

DuckDB's parser rejects a bare `<reserved> := value`. `history` therefore does NOT name its
args `interval` or `end` — both are reserved (`INTERVAL` type, `CASE…END`). They are `bar`
and `end_date` (+ `start_date` for symmetry). Positional args don't help — every arg but the
leading `symbol` is named-only. Before naming a new arg, check it isn't a DuckDB keyword.

## Gotchas

- Emit `bigint` (not `number`) for `Int64`/`Timestamp` columns via `batchFromColumns`.
- `quote` fans out one request per distinct symbol (`fetchQuoteMap`, bounded by
  `mapLimit`); a per-symbol throw is caught and that symbol dropped — keep that resilience.
  `history`/`search` do NOT drop: a Yahoo HTTP error fails the scan, LATERAL included.
- Driving a row-transform function from `VgiClient` (test/http-transport.test.ts): use
  `tableInOutFunctionRows` with an input batch AND `hasFinalize: false` (vgi ≥ 0.36.2).
  The client's default sends a FINALIZE phase, which a row-transform function rejects;
  DuckDB never sends one.
- Don't add a secret type; this worker is keyless by design.
