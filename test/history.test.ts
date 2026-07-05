// Archetype proof for yf.history: the v8 chart driver. Imports ONLY our own src + the
// fake — NO @query-farm/* — so it runs without the SDK installed. Proves URL building
// (range vs start/end), OHLCV mapping, null-cell tolerance, and Yahoo's error surfacing.

import { test, expect } from "bun:test";
import { chartUrl, parseChart, fetchHistory, dateToEpoch, type HistoryArgs } from "../src/yahoo.js";
import { FakeYahoo, chartEnvelope } from "./fake-yahoo.js";

const base: HistoryArgs = { symbol: "AAPL", range: "1mo", interval: "1d", prepost: false, start: "", end: "" };

test("chartUrl uses the named range by default", () => {
  const url = chartUrl(base);
  expect(url).toContain("/v8/finance/chart/AAPL?");
  expect(url).toContain("interval=1d");
  expect(url).toContain("range=1mo");
  expect(url).not.toContain("period1");
});

test("chartUrl switches to period1/period2 when start is given", () => {
  const url = chartUrl({ ...base, start: "2024-01-01", end: "2024-12-31" });
  expect(url).toContain(`period1=${dateToEpoch("2024-01-01")}`);
  expect(url).toContain(`period2=${dateToEpoch("2024-12-31")}`);
  expect(url).not.toContain("range=");
});

test("chartUrl end defaults to now when only start is given", () => {
  const nowMs = Date.parse("2025-06-01T00:00:00Z");
  const url = chartUrl({ ...base, start: "2025-01-01" }, undefined, nowMs);
  expect(url).toContain(`period2=${Math.floor(nowMs / 1000)}`);
});

test("chartUrl includes pre/post market only when requested", () => {
  expect(chartUrl({ ...base, prepost: true })).toContain("includePrePost=true");
  expect(chartUrl(base)).not.toContain("includePrePost");
});

test("parseChart maps candles positionally and tolerates null cells", () => {
  const rows = parseChart(chartEnvelope("AAPL"), "AAPL");
  expect(rows.length).toBe(2);
  expect(rows[0]).toEqual({
    symbol: "AAPL",
    timestamp: 1719792000,
    open: 100.0,
    high: 103.0,
    low: 99.5,
    close: 102.0,
    adjclose: 101.8,
    volume: 1000000,
  });
  // second candle's close is null → close null, and adjclose falls back to the adjclose array
  expect(rows[1]!.close).toBeNull();
  expect(rows[1]!.adjclose).toBe(103.2);
});

test("parseChart returns [] for an empty result (thin/unknown symbol), no throw", () => {
  expect(parseChart({ chart: { result: null, error: null } }, "ZZZZ")).toEqual([]);
  expect(parseChart({ chart: { result: [{ meta: { symbol: "X" } }] } }, "X")).toEqual([]);
});

test("parseChart surfaces Yahoo's own error envelope as a throw", () => {
  const env = { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } };
  expect(() => parseChart(env, "BADSYM")).toThrow(/BADSYM.*Not Found/);
});

test("fetchHistory wires get→parse and hits the chart URL", async () => {
  const fake = FakeYahoo.chart(chartEnvelope("AAPL"));
  const rows = await fetchHistory(fake.get, base);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]!).toContain("/v8/finance/chart/AAPL");
});
