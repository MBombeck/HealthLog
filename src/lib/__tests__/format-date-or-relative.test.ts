/**
 * v1.4.43 QoL (L8) — `formatDateOrRelative()` boundary cases.
 *
 * The helper switches between relative ("vor 12 min") and absolute
 * ("21.05.2026, 14:32") rendering based on a 24h cutoff, so two
 * adjacent timestamps in the same view never mix formats. Pin every
 * boundary so future tweaks (e.g. extending the relative window)
 * don't silently shift the cutover.
 */
import { describe, it, expect } from "vitest";

import { formatDateOrRelative } from "../format";

function fakeT(key: string, params?: Record<string, string | number>): string {
  // Deterministic stand-in — just echo the key + params so the
  // assertions can pin which branch we hit without binding to actual
  // translation copy.
  if (!params) return key;
  return `${key}:${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}`;
}

const NOW = new Date("2026-05-21T12:00:00Z").getTime();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDateOrRelative", () => {
  it("returns just-now for < 60 seconds (lower boundary)", () => {
    const iso = new Date(NOW - 15 * SECOND).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeJustNow",
    );
  });

  it("returns just-now at the 59-second edge", () => {
    const iso = new Date(NOW - 59 * SECOND).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeJustNow",
    );
  });

  it("returns minutesAgo at exactly the 1-minute mark", () => {
    const iso = new Date(NOW - 1 * MINUTE).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeMinutesAgo:count=1",
    );
  });

  it("returns minutesAgo within the [1m, 1h) window", () => {
    const iso = new Date(NOW - 30 * MINUTE).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeMinutesAgo:count=30",
    );
  });

  it("returns hoursAgo at exactly the 1-hour mark", () => {
    const iso = new Date(NOW - 1 * HOUR).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeHoursAgo:count=1",
    );
  });

  it("returns hoursAgo at the 23h59m edge", () => {
    const iso = new Date(NOW - (23 * HOUR + 59 * MINUTE)).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeHoursAgo:count=23",
    );
  });

  it("falls back to absolute formatting at exactly 24h", () => {
    const iso = new Date(NOW - 24 * HOUR).toISOString();
    const result = formatDateOrRelative(iso, fakeT, NOW);
    // The absolute branch does NOT route through the translator, so
    // it never produces an `insights.relative*` string.
    expect(result).not.toContain("insights.relative");
    // It returns a date+time formatted via the legacy formatter, which
    // contains digits separated by punctuation.
    expect(result).toMatch(/\d/);
  });

  it("falls back to absolute for a 7-day-old timestamp", () => {
    const iso = new Date(NOW - 7 * DAY).toISOString();
    const result = formatDateOrRelative(iso, fakeT, NOW);
    expect(result).not.toContain("insights.relative");
    expect(result).toMatch(/\d/);
  });

  it("falls back to absolute for future timestamps (never paints 'in 3 min')", () => {
    const iso = new Date(NOW + 5 * MINUTE).toISOString();
    const result = formatDateOrRelative(iso, fakeT, NOW);
    // No relative copy — the absolute formatter handles it.
    expect(result).not.toContain("insights.relative");
    expect(result).toMatch(/\d/);
  });

  it("returns empty string for unparseable input", () => {
    expect(formatDateOrRelative("not a date", fakeT, NOW)).toBe("");
  });

  it("accepts a Date instance as well as ISO string", () => {
    expect(
      formatDateOrRelative(new Date(NOW - 30 * MINUTE), fakeT, NOW),
    ).toBe("insights.relativeMinutesAgo:count=30");
  });
});
