// Archetype proof for yf.quote: the keyless snapshot driver backed by the v8 chart
// `meta` block (one request per symbol). SDK-free (own src + fake only). Proves symbol
// normalization, the wire URL, meta→row mapping, derived change vs previous close, and
// that a bad/thin symbol is dropped rather than failing the whole scan.

import { test, expect } from "bun:test";
import { parseSymbols, quoteUrl, parseQuoteMeta, fetchQuote } from "../src/yahoo.js";
import { fakeQuote, quoteMetaEnvelope, FakeYahoo } from "./fake-yahoo.js";

test("parseSymbols splits on commas/spaces, uppercases, dedupes, drops blanks", () => {
  expect(parseSymbols("aapl, msft  goog ,, aapl")).toEqual(["AAPL", "MSFT", "GOOG"]);
  expect(parseSymbols("   ")).toEqual([]);
});

test("quoteUrl is a keyless 1-day chart request (no v7 quote, no crumb)", () => {
  const url = quoteUrl("AAPL");
  expect(url).toContain("/v8/finance/chart/AAPL");
  expect(url).toContain("range=1d");
  expect(url).not.toContain("/v7/");
  expect(url).not.toContain("crumb");
});

test("parseQuoteMeta maps curated fields and derives change vs previous close", () => {
  const row = parseQuoteMeta(quoteMetaEnvelope("AAPL"), "AAPL")!;
  expect(row).toMatchObject({
    symbol: "AAPL",
    shortName: "Apple Inc.",
    exchange: "NasdaqGS", // fullExchangeName
    quoteType: "EQUITY", // instrumentType
    regularMarketPrice: 201.25,
    regularMarketPreviousClose: 200.0,
    regularMarketTime: 1719878400,
  });
  expect(row.regularMarketChange).toBeCloseTo(1.25, 6); // 201.25 − 200.0
  expect(row.regularMarketChangePercent).toBeCloseTo(0.625, 6); // 1.25 / 200 * 100
});

test("parseQuoteMeta tolerates a sparse meta (only price present)", () => {
  const row = parseQuoteMeta(quoteMetaEnvelope("MSFT", true), "MSFT")!;
  expect(row.symbol).toBe("MSFT");
  expect(row.regularMarketPrice).toBe(450.5);
  expect(row.regularMarketDayHigh).toBeNull();
  expect(row.regularMarketChange).toBeNull(); // no previous close → no derived change
});

test("parseQuoteMeta returns null for an error/empty envelope (unknown symbol)", () => {
  expect(parseQuoteMeta({ chart: { result: null, error: { code: "Not Found" } } }, "ZZZZ")).toBeNull();
  expect(parseQuoteMeta({ chart: { result: [{ meta: {} }] } }, "X")).toBeNull();
});

test("fetchQuote short-circuits an empty symbol list with no HTTP call", async () => {
  const fake = fakeQuote();
  expect(await fetchQuote(fake.get, [])).toEqual([]);
  expect(fake.calls.length).toBe(0);
});

test("fetchQuote issues one chart request per symbol and returns one row each", async () => {
  const fake = fakeQuote();
  const rows = await fetchQuote(fake.get, parseSymbols("AAPL,MSFT"));
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(2);
  expect(rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "MSFT"]);
});

test("fetchQuote drops a symbol whose request throws, keeps the rest", async () => {
  const fake = new FakeYahoo((url) => {
    if (url.includes("/BADSYM")) throw new Error("boom");
    return quoteMetaEnvelope("AAPL");
  });
  const rows = await fetchQuote(fake.get, ["AAPL", "BADSYM"]);
  expect(rows.length).toBe(1);
  expect(rows[0]!.symbol).toBe("AAPL");
});
