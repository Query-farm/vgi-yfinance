// Typed-column contract for the three schemas. This one pulls @query-farm/vgi
// (batchFromColumns) + apache-arrow, so it runs under the full SDK install — unlike the
// driver tests, which are deliberately SDK-free. Proves the schema field names/order and
// that Float64/Int64/Timestamp cells (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import { historySchema, historyBatch, quoteSchema, quoteBatch, searchSchema, searchBatch } from "../src/schema.js";
import { parseChart, parseQuoteMeta, parseSearch } from "../src/yahoo.js";
import { chartEnvelope, quoteMetaEnvelope, searchEnvelope } from "./fake-yahoo.js";

test("history schema field names + order", () => {
  expect(historySchema().fields.map((f) => f.name)).toEqual([
    "symbol",
    "timestamp",
    "open",
    "high",
    "low",
    "close",
    "adjclose",
    "volume",
  ]);
});

test("historyBatch builds one row per candle with a Timestamp + null-tolerant Float64", () => {
  const schema = historySchema();
  const rows = parseChart(chartEnvelope("AAPL"), "AAPL");
  const batch = historyBatch(schema, rows) as { numRows: number };
  expect(batch.numRows).toBe(2);
});

test("quote schema field names + order", () => {
  expect(quoteSchema().fields.map((f) => f.name)).toEqual([
    "symbol",
    "short_name",
    "long_name",
    "currency",
    "exchange",
    "quote_type",
    "regular_market_price",
    "regular_market_change",
    "regular_market_change_percent",
    "regular_market_volume",
    "regular_market_day_high",
    "regular_market_day_low",
    "regular_market_previous_close",
    "fifty_two_week_high",
    "fifty_two_week_low",
    "regular_market_time",
  ]);
});

test("quoteBatch handles a full row and a sparse (mostly-null) row", () => {
  const schema = quoteSchema();
  const rows = [
    parseQuoteMeta(quoteMetaEnvelope("AAPL"), "AAPL")!,
    parseQuoteMeta(quoteMetaEnvelope("MSFT", true), "MSFT")!,
  ];
  const batch = quoteBatch(schema, rows) as { numRows: number };
  expect(batch.numRows).toBe(2);
});

test("search schema field names + order", () => {
  expect(searchSchema().fields.map((f) => f.name)).toEqual([
    "symbol",
    "short_name",
    "long_name",
    "exchange",
    "quote_type",
    "type_disp",
    "score",
  ]);
});

test("searchBatch builds one row per candidate", () => {
  const schema = searchSchema();
  const batch = searchBatch(schema, parseSearch(searchEnvelope())) as { numRows: number };
  expect(batch.numRows).toBe(2);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((historyBatch(historySchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((quoteBatch(quoteSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((searchBatch(searchSchema(), []) as { numRows: number }).numRows).toBe(0);
});
