/**
 * Issue #490 — chart bucket labels must not shift for profiles west of
 * Berlin.
 *
 * `bucketTimeSeries` encodes each week/month bucket as `Date.UTC(...)` of
 * the BERLIN calendar day the bucket starts on; day rows encode noon-UTC
 * of a profile-tz day key. Both are calendar-day encodings, not instants,
 * so labels render through the UTC-pinned `makeBucketLabelFormatters` —
 * byte-identical for a Berlin profile, and immune to the west-of-Berlin
 * month/day slide a profile-tz formatter would introduce. The bucket MATH
 * itself is pinned by `bucket-time-series.test.ts` and stays untouched.
 */
import { describe, expect, it } from "vitest";

import { bucketTimeSeries } from "../bucket-time-series";
import { makeBucketLabelFormatters } from "../bucket-label";
import { makeFormatters } from "@/lib/format-locale";

// Berlin was the module's hard-coded calendar, so these expectations were
// always Berlin's. Naming it here keeps that visible now it is a parameter.
const BERLIN = "Europe/Berlin";
describe("makeBucketLabelFormatters (#490)", () => {
  // Two July instants (Berlin summer) forced into a month bucket.
  const monthBucket = bucketTimeSeries(
    [
      { timestamp: new Date("2026-07-05T10:00:00Z"), values: { WEIGHT: 80 } },
      { timestamp: new Date("2026-07-20T10:00:00Z"), values: { WEIGHT: 82 } },
    ],
    { bucket: "month", timeZone: BERLIN },
  );

  it("labels a Berlin July month bucket as July for every profile", () => {
    const ts = monthBucket.points[0].timestamp;
    // The bucket encodes the Berlin month start as UTC midnight.
    expect(ts).toBe(Date.UTC(2026, 6, 1));
    const label = makeBucketLabelFormatters("en", "AUTO");
    expect(label.monthShort(new Date(ts))).toBe("Jul");
    expect(label.date(new Date(ts))).toBe("07/01/2026");
  });

  it("documents the trap: a profile-tz formatter slides the label west of Berlin", () => {
    const ts = monthBucket.points[0].timestamp;
    // Jul 1 00:00 UTC = Jun 30 20:00 in New York — the exact month-label
    // slide the UTC pin exists to prevent. If this expectation ever
    // changes, the label pin above is what protects users.
    const newYork = makeFormatters("en", "America/New_York", "AUTO", "AUTO");
    expect(newYork.monthShort(new Date(ts))).toBe("Jun");
  });

  it("stays byte-identical to the legacy Berlin rendering", () => {
    const berlin = makeFormatters("en", "Europe/Berlin", "AUTO", "AUTO");
    const label = makeBucketLabelFormatters("en", "AUTO");
    // Month bucket start (UTC midnight of a Berlin day)…
    const bucketTs = new Date(monthBucket.points[0].timestamp);
    expect(label.date(bucketTs)).toBe(berlin.date(bucketTs));
    expect(label.monthShort(bucketTs)).toBe(berlin.monthShort(bucketTs));
    // …and a chart day row (noon-UTC of a day key, `dayKeyToTimestamp`).
    const dayTs = new Date(Date.UTC(2026, 6, 14, 12));
    expect(label.date(dayTs)).toBe(berlin.date(dayTs));
    expect(label.dateShort(dayTs)).toBe(berlin.dateShort(dayTs));
  });

  it("labels an ISO-week bucket with its Monday for every profile", () => {
    const weekBucket = bucketTimeSeries(
      [
        {
          timestamp: new Date("2026-07-15T10:00:00Z"), // Wed, Berlin week of Mon Jul 13
          values: { WEIGHT: 80 },
        },
      ],
      { bucket: "week", timeZone: BERLIN },
    );
    const ts = weekBucket.points[0].timestamp;
    expect(ts).toBe(Date.UTC(2026, 6, 13));
    const label = makeBucketLabelFormatters("en", "AUTO");
    expect(label.dateWithWeekday(new Date(ts))).toContain("Mon");
    // A New-York-tz render would name it "Sun" — the week-label slide.
    const newYork = makeFormatters("en", "America/New_York", "AUTO", "AUTO");
    expect(newYork.dateWithWeekday(new Date(ts))).toContain("Sun");
  });

  it("labels a noon-UTC day key correctly even for a UTC+13 profile", () => {
    // Day rows encode noon UTC; an Auckland (UTC+13 in January) profile
    // formatter would render the NEXT day. The UTC pin renders the key.
    const dayTs = new Date(Date.UTC(2026, 0, 14, 12));
    expect(makeBucketLabelFormatters("en", "AUTO").date(dayTs)).toBe(
      "01/14/2026",
    );
    const auckland = makeFormatters("en", "Pacific/Auckland", "AUTO", "AUTO");
    expect(auckland.date(dayTs)).toBe("01/15/2026");
  });
});
