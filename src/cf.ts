// Cloudflare Workers entry for vgi-yfinance.
//
//   ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION 'https://vgi-yfinance.<account>.workers.dev');
//
// Same three functions + catalog as the stdio (worker.ts) and Bun HTTP (scripts/serve.ts)
// entries, in the `export default { fetch }` shape workerd expects. `createVgiFetch` comes
// from `@query-farm/vgi/worker-cf`, whose `workerd` export condition selects the flechette
// Arrow backend at bundle time — no arrow-js reaches the edge. Adding a function means
// updating all three entries.
//
// The Worker is stateless across requests: exchange state round-trips in an AEAD-sealed
// token keyed off VGI_SIGNING_KEY (a Wrangler secret). The key must be stable — isolates
// don't share memory, so a bind→scan query that lands on a second isolate would otherwise
// fail to open the first isolate's token.

import { createVgiFetch, FunctionRegistry, ReadOnlyCatalogInterface } from "@query-farm/vgi/worker-cf";
import { makeYahooGet } from "./client.js";
import { makeHistoryFunction, makeQuoteFunction, makeSearchFunction } from "./functions.js";
import { makeCatalog } from "./catalog.js";
import pkg from "../package.json" with { type: "json" };

export interface Env {
  /** Stable secret, SHA-256'd to the 32-byte state-token key (`wrangler secret put`). */
  VGI_SIGNING_KEY?: string;
  /** State-token TTL in seconds (default 3600). */
  VGI_TOKEN_TTL?: string;
  /** Narrows CORS per deployment; unset keeps the SDK's open `*` default. */
  VGI_HTTP_CORS_ORIGINS?: string;
}

type Handler = (req: Request) => Promise<Response>;

// One handler per isolate, rebuilt only if the signing key changes.
let cached: { key: string; handler: Handler } | null = null;

async function getHandler(env: Env): Promise<Handler> {
  const keyMaterial = env.VGI_SIGNING_KEY ?? "";
  if (cached && cached.key === keyMaterial) return cached.handler;

  // Without the secret (e.g. a first `wrangler dev`), fall back to a per-isolate random
  // key: fine for a single isolate, wrong for a real deployment.
  const signingKey =
    keyMaterial.length > 0
      ? new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial)))
      : crypto.getRandomValues(new Uint8Array(32));

  const get = makeYahooGet();
  const functions = [makeHistoryFunction(get), makeQuoteFunction(get), makeSearchFunction(get)];
  const registry = new FunctionRegistry();
  for (const fn of functions) registry.register(fn);
  const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

  const handler = createVgiFetch({
    protocol: { registry, catalogInterface },
    signingKey,
    tokenTtl: env.VGI_TOKEN_TTL ? Number(env.VGI_TOKEN_TTL) : 3600,
    // RPC (and GET /health) at the root, matching scripts/serve.ts.
    prefix: "",
    corsOrigins: env.VGI_HTTP_CORS_ORIGINS,
    serverId: "vgi-yfinance",
    repositoryUrl: "https://github.com/Query-farm/vgi-yfinance",
    // serveVgiWorker derives this for the Bun entry; createVgiFetch needs it passed or the
    // landing page falls back to a bare "this is an RPC endpoint" placeholder.
    landingInfo: {
      name: "yfinance",
      doc: "Yahoo Finance market data: history (OHLCV), quote (snapshot), and symbol search.",
      version: pkg.version,
    },
  });
  cached = { key: keyMaterial, handler };
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await getHandler(env))(request);
  },
};
