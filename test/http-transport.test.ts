// HTTP-transport smoke test.
//
// Every other test drives the worker over the *stdio* transport (DuckDB spawns
// `bin/vgi-yfinance-worker` and talks to it over stdin/stdout; the haybarn suite
// exercises that). This one stands the SAME registry + catalog up behind the
// stateless HTTP handler (`createVgiFetch`, the Cloudflare/Bun HTTP seam), serves
// it with `Bun.serve`, and drives it end-to-end with the high-level `VgiClient`
// over `httpConnect`.
//
// It proves the design claim in CLAUDE.md — that the `{done}` function state is
// serializable enough to round-trip through a stateless HTTP request (state is
// carried in a signed token between requests, not held in memory) — rather than
// merely asserting it.
//
// Coverage:
//   - protocol handshake over HTTP (catalogs / attach)              [network-free]
//   - the three functions are exposed over HTTP                      [network-free]
//   - a full history bind → init → scan round-trips over HTTP        [live: Yahoo]
//
// The final scan hits Yahoo live (like the haybarn live-invariant asserts) — fine
// for an egress connector. Schema columns are deterministic; only row-count is live.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createVgiFetch } from "@query-farm/vgi/worker-cf";
import { FunctionRegistry, ReadOnlyCatalogInterface, VgiClient, Arguments } from "@query-farm/vgi";
import { httpConnect } from "@query-farm/vgi-rpc";
import { makeHistoryFunction, makeQuoteFunction, makeSearchFunction } from "../src/functions.js";
import { makeCatalog } from "../src/catalog.js";

// A fake Yahoo getter would make the scan deterministic, but the point here is the
// TRANSPORT, and the parse/mapping is already covered SDK-free in yahoo.test.ts. Use
// the real network so we exercise the same path the deployed HTTP worker would.
import { makeYahooGet } from "../src/client.js";

const PREFIX = "/vgi";
// Static 32-byte HMAC key — the HTTP handler signs state tokens with it. Any stable
// secret works; it never leaves this process.
const SIGNING_KEY = new Uint8Array(32).fill(7);

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  const get = makeYahooGet();
  const functions = [makeHistoryFunction(get), makeQuoteFunction(get), makeSearchFunction(get)];
  const registry = new FunctionRegistry();
  for (const fn of functions) registry.register(fn);
  const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

  const fetch = createVgiFetch({
    protocol: { registry, catalogInterface },
    signingKey: SIGNING_KEY,
    prefix: PREFIX,
  });

  server = Bun.serve({ port: 0, fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

test("catalog is discoverable over HTTP", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const catalogs = await client.catalogs();
    expect(catalogs).toContain("yfinance");
  } finally {
    rpc.close();
  }
});

test("the three table functions are exposed over HTTP", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const attach = await client.catalogAttach("yfinance");
    const fns = await client.schemaContentsFunctions(
      attach.attach_opaque_data,
      "main",
      "TABLE_FUNCTION",
    );
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(["history", "quote", "search"]);
  } finally {
    rpc.close();
  }
});

test("history bind → init → scan round-trips over HTTP (live)", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const attach = await client.catalogAttach("yfinance");

    const rows: Record<string, any>[] = [];
    for await (const batch of client.tableFunctionRows({
      functionName: "history",
      arguments: new Arguments(["AAPL"], new Map([["range", "5d"]])),
      attachOpaqueData: attach.attach_opaque_data,
    })) {
      rows.push(...batch);
    }

    // Live: that we got at least one candle back.
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0]!;
    // Deterministic: the typed schema round-tripped intact over HTTP.
    expect(Object.keys(first).sort()).toEqual(
      ["adjclose", "close", "high", "low", "open", "symbol", "timestamp", "volume"].sort(),
    );
    expect(first.symbol).toBe("AAPL");
    expect(typeof first.close).toBe("number");
  } finally {
    rpc.close();
  }
});
