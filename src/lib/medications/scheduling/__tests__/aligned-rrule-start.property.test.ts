/**
 * Moving an RRULE's start forward to just before the window must not move a
 * single occurrence inside it. The reference is the rule iterated from its
 * real anchor, exactly as the engine did before the start was aligned.
 */
import fc from "fast-check";
import { RRule } from "rrule";
import { describe, expect, it } from "vitest";

import { alignedRruleStart } from "@/lib/medications/scheduling/aligned-rrule-start";

import {
  assertProperty,
  propertyTimeout,
} from "../../../../../tests/property/fast-check";

const DAY_MS = 24 * 60 * 60 * 1000;
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const dayArb = fc
  .integer({ min: 0, max: 3 * 365 })
  .map((n) => new Date(Date.UTC(2024, 0, 1) + n * DAY_MS));

const ruleArb = fc
  .record({
    freq: fc.constantFrom("DAILY", "WEEKLY", "MONTHLY"),
    interval: fc.integer({ min: 1, max: 4 }),
    byday: fc.option(
      fc.uniqueArray(fc.constantFrom(...BYDAY), { minLength: 1, maxLength: 7 }),
    ),
    byhour: fc.option(
      fc.uniqueArray(fc.integer({ min: 0, max: 23 }), {
        minLength: 1,
        maxLength: 3,
      }),
    ),
    wkst: fc.option(fc.constantFrom("MO", "SU")),
    count: fc.option(fc.integer({ min: 1, max: 40 })),
    bysetpos: fc.option(fc.constantFrom(1, 2, -1)),
  })
  .map(({ freq, interval, byday, byhour, wkst, count, bysetpos }) =>
    [
      `FREQ=${freq}`,
      interval > 1 ? `INTERVAL=${interval}` : null,
      byday ? `BYDAY=${byday.join(",")}` : null,
      byhour ? `BYHOUR=${byhour.join(",")}` : null,
      wkst ? `WKST=${wkst}` : null,
      count ? `COUNT=${count}` : null,
      bysetpos && byday && !byhour ? `BYSETPOS=${bysetpos}` : null,
    ]
      .filter(Boolean)
      .join(";"),
  );

function basic(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function occurrences(rule: string, start: Date, after: Date, before: Date) {
  return RRule.fromString(`DTSTART:${basic(start)}\nRRULE:${rule}`)
    .between(after, before, true)
    .map((d) => d.toISOString());
}

describe("alignedRruleStart", () => {
  it(
    "leaves every occurrence in the window where it was",
    () => {
      assertProperty(
        fc.property(
          ruleArb,
          dayArb,
          fc.integer({ min: -30, max: 2 * 365 }),
          fc.integer({ min: 1, max: 120 }),
          (rule, anchor, offsetDays, spanDays) => {
            const after = new Date(anchor.getTime() + offsetDays * DAY_MS);
            const before = new Date(after.getTime() + spanDays * DAY_MS);
            const aligned = alignedRruleStart(rule, anchor, after);
            expect(aligned.getTime()).toBeGreaterThanOrEqual(anchor.getTime());
            expect(occurrences(rule, aligned, after, before)).toEqual(
              occurrences(rule, anchor, after, before),
            );
          },
        ),
        300,
      );
      // The reference walks from the real anchor, which is the cost this
      // module removes from the engine.
    },
    propertyTimeout(30_000),
  );

  it("moves a daily or weekly start close to the window", () => {
    const anchor = new Date(Date.UTC(2024, 5, 1));
    const after = new Date(Date.UTC(2026, 2, 1));
    for (const rule of ["FREQ=DAILY", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"]) {
      const aligned = alignedRruleStart(rule, anchor, after);
      expect(after.getTime() - aligned.getTime()).toBeLessThanOrEqual(
        15 * DAY_MS,
      );
    }
    expect(alignedRruleStart("FREQ=DAILY;COUNT=5", anchor, after)).toEqual(
      anchor,
    );
    expect(alignedRruleStart("FREQ=MONTHLY", anchor, after)).toEqual(anchor);
  });
});
