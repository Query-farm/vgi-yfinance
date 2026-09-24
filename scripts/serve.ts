// Serve the vgi-yfinance worker over HTTP with the standardized VGI landing surface.
//
//   GET  /              → the shared vendored VGI landing.html (or a JSON status
//                         document for health checks and `?format=json`)
//   GET  /vgi-client.js → the browser client build the landing page reads the
//                         catalog with — it introspects over the VGI protocol
//                         itself, so there are no /describe*.json routes
//   GET  /health        → JSON health endpoint
//   POST /              → the VGI RPC transport (what DuckDB attaches to)
//
// Run it:  PORT=8000 bun run scripts/serve.ts   (default port 8787)
// Attach:  ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION 'http://localhost:8000');
//
// Everything below the worker's own identity — protocol assembly, state-token
// signing, CORS, the landing surface, Bun.serve — lives in the SDK's
// serveVgiWorker. Set VGI_SIGNING_KEY (64 hex chars) for any real deployment;
// without it the SDK generates an ephemeral key and warns.
//
// The wiring here mirrors src/worker.ts (the stdio entry): same real Yahoo HTTP
// client injected into the same three table functions, same registry + catalog.
// Adding a function means updating BOTH entries.

import { serveVgiWorker } from "@query-farm/vgi/serve";
import { ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeYahooGet } from "../src/client.js";
import { makeHistoryFunction, makeQuoteFunction, makeSearchFunction } from "../src/functions.js";
import { makeCatalog } from "../src/catalog.js";

const get = makeYahooGet();

const functions = [makeHistoryFunction(get), makeQuoteFunction(get), makeSearchFunction(get)];

const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);

const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

serveVgiWorker({
  name: "yfinance",
  doc: "Yahoo Finance market data: history (OHLCV), quote (snapshot), and symbol search.",
  version: "0.3.1",
  repositoryUrl: "https://github.com/Query-farm/vgi-yfinance",
  serverId: "vgi-yfinance",
  registry,
  catalogInterface,
});
