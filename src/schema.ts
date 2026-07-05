// Arrow output schemas + row→batch mapping for the three functions.
//
// Unlike a "decode anything" passthrough, finance data has a STABLE, known shape, so we
// emit real typed columns (not a single JSON string): Float64 prices, Int64 volume,
// Timestamp[s,UTC] instants. Timestamp canonical unit is a raw bigint of the type's unit
// (here epoch SECONDS), so timestamp columns carry `bigint` cells; Int64 likewise.

import { Schema, Field, Utf8, Float64, Int64, Timestamp, TimeUnit } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type { HistoryRow, QuoteRow, SearchRow } from "./yahoo.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const tsSec = () => new Timestamp(TimeUnit.SECOND, "UTC");

/** bigint | null for an Int64/Timestamp cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

// ── history ─────────────────────────────────────────────────────────────────

export function historySchema(): Schema {
  return new Schema([
    f("symbol", new Utf8()),
    f("timestamp", tsSec()),
    f("open", new Float64()),
    f("high", new Float64()),
    f("low", new Float64()),
    f("close", new Float64()),
    f("adjclose", new Float64()),
    f("volume", new Int64()),
  ]);
}

export function historyBatch(schema: Schema, rows: HistoryRow[]) {
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

export function quoteSchema(): Schema {
  return new Schema([
    f("symbol", new Utf8()),
    f("short_name", new Utf8()),
    f("long_name", new Utf8()),
    f("currency", new Utf8()),
    f("exchange", new Utf8()),
    f("quote_type", new Utf8()),
    f("regular_market_price", new Float64()),
    f("regular_market_change", new Float64()),
    f("regular_market_change_percent", new Float64()),
    f("regular_market_volume", new Int64()),
    f("regular_market_day_high", new Float64()),
    f("regular_market_day_low", new Float64()),
    f("regular_market_previous_close", new Float64()),
    f("fifty_two_week_high", new Float64()),
    f("fifty_two_week_low", new Float64()),
    f("regular_market_time", tsSec()),
  ]);
}

export function quoteBatch(schema: Schema, rows: QuoteRow[]) {
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

export function searchSchema(): Schema {
  return new Schema([
    f("symbol", new Utf8()),
    f("short_name", new Utf8()),
    f("long_name", new Utf8()),
    f("exchange", new Utf8()),
    f("quote_type", new Utf8()),
    f("type_disp", new Utf8()),
    f("score", new Float64()),
  ]);
}

export function searchBatch(schema: Schema, rows: SearchRow[]) {
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
