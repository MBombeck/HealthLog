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

  // v1.4.49.2 — One/Other pluralisation. Pre-fix the helper called
  // bare `insights.relativeMinutesAgo` / `insights.relativeHoursAgo`
  // keys; the translation bundle only carries the pluralised `*One` /
  // `*Other` variants so `t()` echoed the bare key into the UI. These
  // assertions now pin the correct dispatch.
  it("returns minutesAgoOne at exactly the 1-minute mark", () => {
    const iso = new Date(NOW - 1 * MINUTE).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeMinutesAgoOne:count=1",
    );
  });

  it("returns minutesAgoOther within the [2m, 1h) window", () => {
    const iso = new Date(NOW - 30 * MINUTE).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeMinutesAgoOther:count=30",
    );
  });

  it("returns hoursAgoOne at exactly the 1-hour mark", () => {
    const iso = new Date(NOW - 1 * HOUR).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeHoursAgoOne:count=1",
    );
  });

  it("returns hoursAgoOther at the 23h59m edge", () => {
    const iso = new Date(NOW - (23 * HOUR + 59 * MINUTE)).toISOString();
    expect(formatDateOrRelative(iso, fakeT, NOW)).toBe(
      "insights.relativeHoursAgoOther:count=23",
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
    ).toBe("insights.relativeMinutesAgoOther:count=30");
  });

  // v1.4.49.2 — regression guard. The helper's `t()` calls must dispatch
  // to keys that actually exist in `messages/en.json`. Pre-fix the bare
  // `insights.relativeMinutesAgo` and `insights.relativeHoursAgo` keys
  // passed straight through `t()` to the UI because no translation
  // matched. Pin the contract here so a future twin-helper-divergence
  // (same shape, different keys) fails fast instead of leaking raw keys
  // into production.
  it("emits only keys that exist in the translation bundle", async () => {
    const en = await import("../../../messages/en.json");
    const bundleKeysCalled = new Set<string>();
    const collectingT = (key: string, params?: Record<string, string | number>) => {
      bundleKeysCalled.add(key);
      return params ? `${key}:${JSON.stringify(params)}` : key;
    };
    // Drive every relative bucket so we hit `t()` on each branch.
    formatDateOrRelative(new Date(NOW - 30 * SECOND).toISOString(), collectingT, NOW);
    formatDateOrRelative(new Date(NOW - 1 * MINUTE).toISOString(), collectingT, NOW);
    formatDateOrRelative(new Date(NOW - 30 * MINUTE).toISOString(), collectingT, NOW);
    formatDateOrRelative(new Date(NOW - 1 * HOUR).toISOString(), collectingT, NOW);
    formatDateOrRelative(new Date(NOW - 12 * HOUR).toISOString(), collectingT, NOW);
    expect(bundleKeysCalled.size).toBeGreaterThan(0);
    // `insights.*` carries a mix of string and nested-object children
    // (e.g. `personalRecord: { badge, tooltip }`), so the bundle type
    // is `Record<string, unknown>` not `Record<string, string>`. We
    // only need shallow `key in object` membership here — the value
    // shape doesn't matter for this regression guard.
    const root = en as unknown as Record<string, unknown>;
    const top = (root.default as Record<string, unknown> | undefined) ?? root;
    const insightsBundle = top.insights as Record<string, unknown> | undefined;
    expect(insightsBundle).toBeTruthy();
    for (const fullKey of bundleKeysCalled) {
      // Each key is "insights.<short>" — assert the short key exists in
      // the en bundle so future renames or typos surface in CI.
      const short = fullKey.replace(/^insights\./, "");
      expect(insightsBundle?.[short]).toBeDefined();
    }
  });
});
