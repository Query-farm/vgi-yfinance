// Arrow output schemas + row→batch mapping for the three functions.
//
// Unlike a "decode anything" passthrough, finance data has a STABLE, known shape, so we
// emit real typed columns (not a single JSON string): Float64 prices, Int64 volume,
// Timestamp[s,UTC] instants. Timestamp canonical unit is a raw bigint of the type's unit
// (here epoch SECONDS), so timestamp columns carry `bigint` cells; Int64 likewise.
//
// Types come from vgi's backend-agnostic factories on the `worker-cf` entry, never from
// `@query-farm/apache-arrow`: under workerd (Cloudflare) vgi swaps in the flechette Arrow
// backend, so apache-arrow objects wouldn't match; on Bun the same factories build
// arrow-js types. The package root is avoided too — it re-exports the Node-only stdio
// `Worker`, which breaks the Cloudflare bundle.

import {
  batchFromColumns,
  field,
  float64,
  int64,
  schema,
  timestamp,
  TimeUnit,
  utf8,
  type VgiDataType,
  type VgiSchema,
} from "@query-farm/vgi/worker-cf";
import type { HistoryRow, QuoteRow, SearchRow } from "./yahoo.js";

const f = (name: string, type: VgiDataType) => field(name, type, true);
const tsSec = () => timestamp(TimeUnit.SECOND, "UTC");

/** bigint | null for an Int64/Timestamp cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

// ── history ─────────────────────────────────────────────────────────────────

export function historySchema(): VgiSchema {
  return schema([
    f("symbol", utf8()),
    f("timestamp", tsSec()),
    f("open", float64()),
    f("high", float64()),
    f("low", float64()),
    f("close", float64()),
    f("adjclose", float64()),
    f("volume", int64()),
  ]);
}

export function historyBatch(schema: VgiSchema, rows: HistoryRow[]) {
  return batchFromColumns(
    {
      symbol: rows.map((r) => r.symbol),
      timestamp: rows.map((r) => bigOrNull(r.timestamp)),
      open: rows.map((r) => r.open),
      high: rows.map((r) => r.high),
      low: rows.map((r) => r.low),
      close: rows.map((r) => r.close),
      adjclose: rows.map((r) => r.adjclose),
      volume: rows.map((r) => bigOrNull(r.volume)),
    },
    schema,
  );
}

// ── quote ─────────────────────────────────────────────────────────────────

export function quoteSchema(): VgiSchema {
  return schema([
    f("symbol", utf8()),
    f("short_name", utf8()),
    f("long_name", utf8()),
    f("currency", utf8()),
    f("exchange", utf8()),
    f("quote_type", utf8()),
    f("regular_market_price", float64()),
    f("regular_market_change", float64()),
    f("regular_market_change_percent", float64()),
    f("regular_market_volume", int64()),
    f("regular_market_day_high", float64()),
    f("regular_market_day_low", float64()),
    f("regular_market_previous_close", float64()),
    f("fifty_two_week_high", float64()),
    f("fifty_two_week_low", float64()),
    f("regular_market_time", tsSec()),
  ]);
}

export function quoteBatch(schema: VgiSchema, rows: QuoteRow[]) {
  return batchFromColumns(
    {
      symbol: rows.map((r) => r.symbol),
      short_name: rows.map((r) => r.shortName),
      long_name: rows.map((r) => r.longName),
      currency: rows.map((r) => r.currency),
      exchange: rows.map((r) => r.exchange),
      quote_type: rows.map((r) => r.quoteType),
      regular_market_price: rows.map((r) => r.regularMarketPrice),
      regular_market_change: rows.map((r) => r.regularMarketChange),
      regular_market_change_percent: rows.map((r) => r.regularMarketChangePercent),
      regular_market_volume: rows.map((r) => bigOrNull(r.regularMarketVolume)),
      regular_market_day_high: rows.map((r) => r.regularMarketDayHigh),
      regular_market_day_low: rows.map((r) => r.regularMarketDayLow),
      regular_market_previous_close: rows.map((r) => r.regularMarketPreviousClose),
      fifty_two_week_high: rows.map((r) => r.fiftyTwoWeekHigh),
      fifty_two_week_low: rows.map((r) => r.fiftyTwoWeekLow),
      regular_market_time: rows.map((r) => bigOrNull(r.regularMarketTime)),
    },
    schema,
  );
}

// ── search ─────────────────────────────────────────────────────────────────

export function searchSchema(): VgiSchema {
  return schema([
    f("symbol", utf8()),
    f("short_name", utf8()),
    f("long_name", utf8()),
    f("exchange", utf8()),
    f("quote_type", utf8()),
    f("type_disp", utf8()),
    f("score", float64()),
  ]);
}

export function searchBatch(schema: VgiSchema, rows: SearchRow[]) {
  return batchFromColumns(
    {
      symbol: rows.map((r) => r.symbol),
      short_name: rows.map((r) => r.shortname),
      long_name: rows.map((r) => r.longname),
      exchange: rows.map((r) => r.exchange),
      quote_type: rows.map((r) => r.quoteType),
      type_disp: rows.map((r) => r.typeDisp),
      score: rows.map((r) => r.score),
    },
    schema,
  );
}
