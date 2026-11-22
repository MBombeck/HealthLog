/**
 * Yesterday and tomorrow are calendar days, not instants 24 hours away.
 *
 * A local day lasts 23 to 25 hours. The day of `now − 24 h` is two days back
 * in the first hour after the 23-hour day and still today late in the 25-hour
 * one; the day of `now + 24 h` is the day after tomorrow in the last hour
 * before the 23-hour day. The host's `setDate(getDate() ∓ 1)` steps in the
 * HOST zone, which on a server is UTC and in a browser need not be the
 * profile's. Every one of these read right on the other 363 days, and a run
 * of the suite under shifted clocks found five surfaces built that way: the
 * checkup snooze gate (route and sheet), the Coach message time, the
 * "Updated yesterday" and "Yesterday" labels, and the medication card's last
 * intake.
 *
 * The neighbouring day is the key next to today's:
 * `shiftDateKey(userDayKey(now, tz), ±1)`. A labeller that carries its own
 * zone and exposes no key uses `previousDayLabel(now, labelOf)`
 * (`src/lib/tz/format.ts`). Both live in `src/lib/tz/`, which is out of scope.
 *
 * The matchers, each pinned by a sample below so an empty sweep cannot pass:
 *   1. a day key or a date label of an instant one day away, in one call;
 *   2. a variable named for yesterday, tomorrow or a probe that is an instant
 *      one day away;
 *   3. the host-calendar step of exactly one day.
 *
 * Limit: the matchers are textual. An instant shifted in one statement and
 * labelled in another, under a name these do not know, slips them. A rolling
 * window (`now − 24 h` as a lower bound of a query) is not a day and is not
 * matched, because nothing labels it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const ONE_DAY = String.raw`(?:DAY_MS|MS_PER_DAY|ONE_DAY_MS|DAY_IN_MS|MS_IN_DAY|86_?400_?000|24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|24\s*\*\s*3_?600_?000|24\s*\*\s*HOUR_MS|24\s*\*\s*HOUR)`;

const MATCHERS: Record<string, RegExp> = {
  labelOfShiftedInstant: new RegExp(
    String.raw`\b(?:userDayKey|dayKey|localDayKey|formatInUserTz|dateShort\w*|dateWithWeekday\w*|format)\(\s*new Date\([^()]*(?:\([^()]*\)[^()]*)*[-+]\s*${ONE_DAY}\s*\)`,
    "g",
  ),
  neighbourNamedInstant: new RegExp(
    String.raw`\b(?:yesterday|tomorrow|probe)\w*\s*=\s*new Date\([^;]*[-+]\s*${ONE_DAY}\b`,
    "gi",
  ),
  hostCalendarStep: /\.setDate\(\s*\w+\.getDate\(\)\s*[-+]\s*1\s*\)/g,
};

/** The shapes this guard exists for, as they were written before the fix. */
const SAMPLES: Record<string, string> = {
  labelOfShiftedInstant:
    "if (day === formatters.dateShortSmart(new Date(now - DAY_MS))) {",
  neighbourNamedInstant:
    "const probe = new Date(now.getTime() + 24 * 60 * 60 * 1000);",
  hostCalendarStep: "yesterday.setDate(yesterday.getDate() - 1);",
};

function isProductSource(rel: string): boolean {
  return (
    !rel.startsWith("generated/") &&
    !rel.startsWith("lib/tz/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel)
  );
}

describe("neighbouring days are stepped on the calendar", () => {
  it("every matcher catches the shape it was written for", () => {
    for (const [name, pattern] of Object.entries(MATCHERS)) {
      const sample = SAMPLES[name];
      expect(sample, name).toBeDefined();
      expect([...sample.matchAll(pattern)].length, name).toBeGreaterThan(0);
    }
  });

  it("no product source derives yesterday or tomorrow from an instant 24 hours away", () => {
    const files = walkSourceFiles(SRC, { floor: 3000 }).filter(isProductSource);
    expect(files.length).toBeGreaterThan(3000);

    const found: string[] = [];
    for (const file of files) {
      const source = readSourceText(join(SRC, file));
      for (const [name, pattern] of Object.entries(MATCHERS)) {
        for (const m of source.matchAll(pattern)) {
          const line = source.slice(0, m.index).split("\n").length;
          found.push(`${file}:${line} (${name}) ${m[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
