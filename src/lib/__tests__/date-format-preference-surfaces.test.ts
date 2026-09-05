/**
 * Issue #922 — the per-user date order has to reach every surface, not just
 * the entry form.
 *
 * A reporter switched the profile away from MM/DD/YYYY. The `<DateField>` in
 * the entry form followed; the dashboard chart axes and the measurements list
 * did not. Both of those render through a formatter that was constructed
 * without the preference, and the parameter carried a `= "AUTO"` default, so
 * nothing anywhere said the setting had been dropped.
 *
 * The assertions check FIELD ORDER, not exact strings: DMY renders through
 * de-DE (dots), MDY through en-US (slashes) and YMD through en-CA (dashes),
 * and pinning the punctuation would make these break on an ICU update that
 * has nothing to do with the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";

/** A day whose three fields are mutually distinguishable. */
const SAMPLE = Date.UTC(2026, 3, 18, 12); // 2026-04-18, noon UTC

/** The numeric fields of a rendered date, in the order they appear. */
function fieldOrder(rendered: string): number[] {
  return (rendered.match(/\d+/g) ?? []).map(Number);
}

/** Day / month / year of SAMPLE, as the renderers emit them. */
const DAY = 18;
const MONTH = 4;
const YEAR = 2026;

describe("issue #922 — chart axis labels honour the date-order preference", () => {
  it("renders day first under DMY", () => {
    const fmt = makeBucketLabelFormatters("en", "DMY");
    expect(fieldOrder(fmt.date(SAMPLE))).toEqual([DAY, MONTH, YEAR]);
    expect(fieldOrder(fmt.dateShortSmart(SAMPLE)).slice(0, 2)).toEqual([
      DAY,
      MONTH,
    ]);
  });

  it("renders month first under MDY", () => {
    const fmt = makeBucketLabelFormatters("en", "MDY");
    expect(fieldOrder(fmt.date(SAMPLE))).toEqual([MONTH, DAY, YEAR]);
    expect(fieldOrder(fmt.dateShortSmart(SAMPLE)).slice(0, 2)).toEqual([
      MONTH,
      DAY,
    ]);
  });

  it("renders year first under YMD", () => {
    const fmt = makeBucketLabelFormatters("en", "YMD");
    expect(fieldOrder(fmt.date(SAMPLE))).toEqual([YEAR, MONTH, DAY]);
  });

  it("keeps following the locale under AUTO", () => {
    expect(
      fieldOrder(makeBucketLabelFormatters("en", "AUTO").date(SAMPLE)),
    ).toEqual([MONTH, DAY, YEAR]);
    expect(
      fieldOrder(makeBucketLabelFormatters("de", "AUTO").date(SAMPLE)),
    ).toEqual([DAY, MONTH, YEAR]);
  });

  it("still pins the label calendar to UTC (issue #490)", async () => {
    const { makeFormatters } = await import("@/lib/format-locale");
    // A noon-UTC day key must not slide a day for a profile at UTC+13.
    const auckland = makeFormatters("en", "Pacific/Auckland", "AUTO", "DMY");
    const label = makeBucketLabelFormatters("en", "DMY");
    expect(fieldOrder(label.date(SAMPLE))).toEqual([DAY, MONTH, YEAR]);
    expect(auckland.date(SAMPLE)).not.toBe(label.date(SAMPLE));
  });
});

interface Globals {
  document?: { cookie: string };
  window?: { localStorage?: { getItem: (key: string) => string | null } };
}

describe("issue #922 — the measurements list honours the date-order preference", () => {
  const globalAny = globalThis as unknown as Globals;
  const mirror = new Map<string, string>();

  beforeEach(() => {
    vi.resetModules();
    mirror.clear();
    globalAny.document = { cookie: "healthlog-locale=en; path=/" };
    globalAny.window = {
      localStorage: { getItem: (key) => mirror.get(key) ?? null },
    };
  });

  afterEach(() => {
    delete globalAny.document;
    delete globalAny.window;
  });

  /**
   * `measurement-list.tsx` renders its rows through the legacy
   * `@/lib/format` helpers, which mirror the timezone and the hour cycle out
   * of localStorage but never read the date-order mirror `<DateField>` uses.
   */
  async function legacy(pref: string) {
    mirror.set("healthlog-date-format", pref);
    mirror.set("healthlog-timezone", "UTC");
    return import("../format");
  }

  it("renders day first under DMY", async () => {
    const { formatDate, formatDateTime } = await legacy("DMY");
    expect(fieldOrder(formatDate(new Date(SAMPLE)))).toEqual([
      DAY,
      MONTH,
      YEAR,
    ]);
    expect(fieldOrder(formatDateTime(new Date(SAMPLE))).slice(0, 3)).toEqual([
      DAY,
      MONTH,
      YEAR,
    ]);
  });

  it("renders month first under MDY", async () => {
    const { formatDate } = await legacy("MDY");
    expect(fieldOrder(formatDate(new Date(SAMPLE)))).toEqual([
      MONTH,
      DAY,
      YEAR,
    ]);
  });

  it("renders year first under YMD", async () => {
    const { formatDate, formatDateShort } = await legacy("YMD");
    expect(fieldOrder(formatDate(new Date(SAMPLE)))).toEqual([
      YEAR,
      MONTH,
      DAY,
    ]);
    expect(fieldOrder(formatDateShort(new Date(SAMPLE)))).toEqual([MONTH, DAY]);
  });

  it("keeps following the locale under AUTO", async () => {
    const { formatDate } = await legacy("AUTO");
    expect(fieldOrder(formatDate(new Date(SAMPLE)))).toEqual([
      MONTH,
      DAY,
      YEAR,
    ]);
  });
});
