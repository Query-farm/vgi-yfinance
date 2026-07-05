// A tiny in-process fake of the Yahoo Finance endpoints — enough to prove the driver:
// it records every requested URL (so a test can assert the wire contract) and returns a
// canned envelope shaped like Yahoo's real v8 chart / v7 quote / v1 search JSON. No
// network. Matches the driver's injected `get(url) => Promise<unknown>` signature.

export class FakeYahoo {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly responder: (url: string) => unknown) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.responder(url);
  };

  /** A fake serving a fixed v8 chart envelope for any /chart/ URL. */
  static chart(env: unknown): FakeYahoo {
    return new FakeYahoo(() => env);
  }
  /** A fake serving a fixed v1 search envelope. */
  static search(env: unknown): FakeYahoo {
    return new FakeYahoo(() => env);
  }
}

/** A well-formed v8 chart envelope with two candles (one with a null cell). */
export function chartEnvelope(symbol = "AAPL"): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol },
          timestamp: [1719792000, 1719878400],
          indicators: {
            quote: [
              {
                open: [100.0, 101.5],
                high: [103.0, 104.0],
                low: [99.5, 100.5],
                close: [102.0, null], // a halted/thin cell → null, not a crash
                volume: [1000000, 2000000],
              },
            ],
            adjclose: [{ adjclose: [101.8, 103.2] }],
          },
        },
      ],
      error: null,
    },
  };
}

/**
 * A v8 chart `meta`-only envelope for one symbol (what the keyless quote path reads).
 * `sparse` drops the optional fields to prove null-tolerance for thinly-covered tickers.
 */
export function quoteMetaEnvelope(symbol = "AAPL", sparse = false): unknown {
  const meta: Record<string, unknown> = sparse
    ? { symbol, regularMarketPrice: 450.5 }
    : {
        symbol,
        shortName: "Apple Inc.",
        longName: "Apple Inc.",
        currency: "USD",
        fullExchangeName: "NasdaqGS",
        instrumentType: "EQUITY",
        regularMarketPrice: 201.25,
        regularMarketVolume: 45000000,
        regularMarketDayHigh: 202.0,
        regularMarketDayLow: 199.5,
        previousClose: 200.0,
        chartPreviousClose: 200.0,
        fiftyTwoWeekHigh: 260.1,
        fiftyTwoWeekLow: 164.08,
        regularMarketTime: 1719878400,
      };
  return { chart: { result: [{ meta }], error: null } };
}

/** A fake that serves a per-symbol chart-meta envelope keyed by the URL's symbol segment. */
export function fakeQuote(sparseSymbols: string[] = []): FakeYahoo {
  return new FakeYahoo((url) => {
    const m = url.match(/\/v8\/finance\/chart\/([^?]+)/);
    const sym = m ? decodeURIComponent(m[1]!) : "AAPL";
    return quoteMetaEnvelope(sym, sparseSymbols.includes(sym));
  });
}

/** A v1 search envelope with two candidate symbols + a news item that must be dropped. */
export function searchEnvelope(): unknown {
  return {
    quotes: [
      {
        symbol: "AAPL",
        shortname: "Apple Inc.",
        longname: "Apple Inc.",
        exchDisp: "NASDAQ",
        quoteType: "EQUITY",
        typeDisp: "Equity",
        score: 1234567.0,
      },
      {
        symbol: "APLE",
        shortname: "Apple Hospitality REIT, Inc.",
        exchDisp: "NYSE",
        quoteType: "EQUITY",
        typeDisp: "Equity",
        score: 20000.0,
      },
    ],
    news: [{ title: "Apple announces something" }],
  };
}
