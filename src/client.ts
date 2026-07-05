// The real Yahoo Finance HTTP client — the ONE module that touches the network, so (like
// the azure workers' MSAL minter) it is exercised live, not by the unit tests, which
// drive the pure driver in yahoo.ts through an injected fake `get`.
//
// All three functions ride keyless, un-gated planes — v8 /finance/chart (history + the
// quote snapshot) and v1 /finance/search — so there is no crumb/cookie handshake. The
// one non-obvious requirement Yahoo imposes is a browser-like User-Agent; the default
// fetch UA is rejected. (The older v7 /finance/quote and v10 /finance/quoteSummary planes
// are deliberately avoided: they now 401 from datacenter IPs even with a valid crumb.)

import type { YahooGet } from "./functions.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type FetchLike = typeof globalThis.fetch;

/**
 * Build the injectable `get(url) => parsed JSON` the table functions call. `fetchImpl`
 * defaults to the platform fetch; pass one in for Cloudflare or to stub the network.
 */
export function makeYahooGet(fetchImpl: FetchLike = globalThis.fetch): YahooGet {
  return async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`yfinance: Yahoo returned HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return res.json();
  };
}
