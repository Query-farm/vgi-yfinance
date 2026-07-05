// Archetype proof for yf.search: the v1 search driver. SDK-free (own src + fake only).
// Proves the wire URL + count clamping, that news is dropped, and field mapping.

import { test, expect } from "bun:test";
import { searchUrl, parseSearch, fetchSearch } from "../src/yahoo.js";
import { FakeYahoo, searchEnvelope } from "./fake-yahoo.js";

test("searchUrl carries the query, requests no news, clamps count to [1,50]", () => {
  const url = searchUrl("apple", 8);
  expect(url).toContain("/v1/finance/search?");
  expect(url).toContain("q=apple");
  expect(url).toContain("quotesCount=8");
  expect(url).toContain("newsCount=0");
  expect(searchUrl("x", 999)).toContain("quotesCount=50");
  expect(searchUrl("x", 0)).toContain("quotesCount=1");
});

test("parseSearch maps candidate symbols and drops the news array", () => {
  const rows = parseSearch(searchEnvelope());
  expect(rows.length).toBe(2);
  expect(rows[0]).toEqual({
    symbol: "AAPL",
    shortname: "Apple Inc.",
    longname: "Apple Inc.",
    exchange: "NASDAQ", // exchDisp
    quoteType: "EQUITY",
    typeDisp: "Equity",
    score: 1234567.0,
  });
  expect(rows[1]!.symbol).toBe("APLE");
  expect(rows[1]!.longname).toBeNull(); // absent in the fixture
});

test("parseSearch returns [] when there are no quotes", () => {
  expect(parseSearch({ news: [] })).toEqual([]);
  expect(parseSearch({})).toEqual([]);
});

test("fetchSearch short-circuits an empty query, else hits the search URL", async () => {
  const fake = FakeYahoo.search(searchEnvelope());
  expect(await fetchSearch(fake.get, "", 8)).toEqual([]);
  expect(fake.calls.length).toBe(0);

  const rows = await fetchSearch(fake.get, "apple", 8);
  expect(rows.length).toBe(2);
  expect(fake.calls[0]!).toContain("/v1/finance/search");
});
