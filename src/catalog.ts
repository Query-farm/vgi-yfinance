// The `yfinance` catalog descriptor. Yahoo Finance's public endpoints are KEYLESS, so —
// unlike the azure workers — there is NO secret type here. The only server-side state the
// real client keeps is an in-process consent-cookie + crumb cache (client.ts), which is
// re-derivable and never crosses the wire, so it is not part of the catalog contract.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";

export function makeCatalog(functions: VgiFunction[]): CatalogDescriptor {
  return {
    name: "yfinance",
    defaultSchema: "main",
    comment:
      "Yahoo Finance market data as DuckDB tables: history (OHLCV), quote (snapshot), " +
      "search (symbol lookup) — vgi-yfinance",
    sourceUrl: "https://query.farm",
    schemas: [{ name: "main", functions }],
  };
}
