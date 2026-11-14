// Archetype proof for yf.history: the v8 chart driver. Imports ONLY our own src + the
// fake — NO @query-farm/* — so it runs without the SDK installed. Proves URL building
// (range vs start/end), OHLCV mapping, null-cell tolerance, and Yahoo's error surfacing.

import { test, expect } from "bun:test";
import {
  chartUrl,
  parseChart,
  fetchHistory,
  dateToEpoch,
  validateHistoryDates,
  type HistoryArgs,
} from "../src/yahoo.js";
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

// Regression: a malformed date or a lone end_date used to be ignored silently, so the
// call returned the default 1mo window instead of the requested dates.
test("dateToEpoch rejects malformed and impossible dates", () => {
  expect(dateToEpoch("2024-01-01")).toBe(1704067200);
  expect(dateToEpoch("2024/01/01")).toBeNull();
  expect(dateToEpoch("2024-1-1")).toBeNull();
  expect(dateToEpoch("2024-02-30")).toBeNull();
  expect(dateToEpoch("")).toBeNull();
});

test("validateHistoryDates rejects bad dates, a lone end_date, and an inverted range", () => {
  expect(() => validateHistoryDates("", "")).not.toThrow();
  expect(() => validateHistoryDates("2024-01-01", "")).not.toThrow();
  expect(() => validateHistoryDates("2024-01-01", "2024-03-01")).not.toThrow();
  expect(() => validateHistoryDates("2024/01/01", "")).toThrow(/start_date '2024\/01\/01'/);
  expect(() => validateHistoryDates("2024-01-01", "March")).toThrow(/end_date 'March'/);
  expect(() => validateHistoryDates("", "2024-01-31")).toThrow(/end_date requires start_date/);
  expect(() => validateHistoryDates("2024-03-01", "2024-01-01")).toThrow(/must be after/);
  expect(() => chartUrl({ ...base, start: "01-01-2024" })).toThrow(/not a valid YYYY-MM-DD/);
});

// Regression: Yahoo leaves the newest candle's close null (seen live on NVDA after the
// close, with open/high/low/volume filled) while meta.regularMarketPrice has the price.
test("parseChart fills only the newest candle's null close from the live meta price", () => {
  const env = {
    chart: {
      result: [
        {
          meta: { symbol: "NVDA", regularMarketPrice: 162.85, regularMarketTime: 1794603601 },
          timestamp: [1794407400, 1794493800, 1794580200],
          indicators: {
            quote: [
              {
                open: [172.8, 151.01, 169.89],
                high: [177.54, 167.14, 170],
                low: [170.77, 148.8, 158.39],
                close: [null, 166.19, null],
                volume: [339214800, 747707600, 362490337],
              },
            ],
            adjclose: [{ adjclose: [null, 166.19, null] }],
          },
        },
      ],
      error: null,
    },
  };
  const rows = parseChart(env, "NVDA");
  expect(rows[2]!.close).toBe(162.85);
  expect(rows[2]!.adjclose).toBe(162.85);
  expect(rows[2]!.open).toBe(169.89);
  expect(rows[0]!.close).toBeNull(); // an older null cell is left alone
});

test("parseChart leaves the newest null close alone when the meta price predates it", () => {
  const rows = parseChart(
    {
      chart: {
        result: [
          {
            meta: { symbol: "X", regularMarketPrice: 10, regularMarketTime: 100 },
            timestamp: [50, 200],
            indicators: { quote: [{ close: [9, null] }] },
          },
        ],
      },
    },
    "X",
  );
  expect(rows[1]!.close).toBeNull();
});
