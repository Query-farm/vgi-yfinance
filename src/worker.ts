// vgi-yfinance stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'yfinance' AS yf (TYPE vgi, LOCATION '/path/to/vgi-yfinance/src/worker.ts');
//   SELECT * FROM yf.history('AAPL', range := '6mo');
//   SELECT * FROM yf.quote('AAPL,MSFT,GOOG');
//   SELECT * FROM yf.search('vanguard');
//
// Keyless: no CREATE SECRET is needed. The worker wires the real crumb/cookie HTTP client
// (client.ts) into the three table functions; the functions themselves stay network-free
// and take the client as an injected `get`.

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeYahooGet } from "./client.js";
import { makeHistoryFunction, makeQuoteFunction, makeSearchFunction } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const get = makeYahooGet();

const functions = [makeHistoryFunction(get), makeQuoteFunction(get), makeSearchFunction(get)];

const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);

const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

new Worker({ functions, catalogInterface }).run();
