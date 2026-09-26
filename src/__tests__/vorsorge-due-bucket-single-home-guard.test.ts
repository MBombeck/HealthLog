/**
 * Structural guard on the checkup due-day bucket.
 *
 * Turning a reminder's `nextDueAt` into "today" / "tomorrow" / "in N days" /
 * "overdue by N days" is calendar arithmetic, and it is easy to get wrong in a
 * way that reads fine most of the time: subtract the two instants, divide by
 * twenty-four hours, round. That answer disagrees with the wall calendar
 * whenever the two times of day are more than twelve hours apart, which is
 * most evenings.
 *
 * It was written that way once, fixed on the checkups page, and left unfixed
 * in the hand-copied second body on the dashboard card. For a year the two
 * screens gave different answers about the same appointment. This file exists
 * so a third body cannot appear.
 *
 * These are tripwires, not proofs. Whether the bucketing is CORRECT is settled
 * by `src/lib/measurement-reminders/__tests__/due-day.test.ts`. What this file
 * settles is that there is only one of it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The one home. Everything else imports from here. */
const HOME = "lib/measurement-reminders/due-day.ts";

/** How a consumer must reach it. */
const HOME_IMPORT = 'from "@/lib/measurement-reminders/due-day"';

/**
 * The two screens that render the due line. Named here so this guard can never
 * pass by having nothing left to check: if the surfaces stop importing the
 * shared body, that is the regression, not a reason to relax the test.
 */
const RENDERING_SURFACES = [
  "components/measurement-reminders/vorsorge-section.tsx",
  "components/measurement-reminders/vorsorge-dashboard-card.tsx",
];

/**
 * The keys only the bucket itself mints. A surface may COMPARE against the
 * today / overdue keys to colour its badge, and both do — so those two are
 * deliberately not listed. Nothing but the bucket ever needs to name
 * "tomorrow", "in N days" or "none", so a file outside the home that contains
 * one is a second bucket wearing a different function name.
 */
const MINTED_ONLY_BY_THE_BUCKET = [
  "measurementReminders.nextDue.tomorrow",
  "measurementReminders.nextDue.inDays",
  "measurementReminders.nextDue.none",
  "measurementReminders.overdueSinceYesterday",
];

/** The hook that yields the zone the surrounding dates are printed in. */
const DISPLAY_ZONE_HOOK = "useDisplayTimezone";

const FIX_IT = [
  `The due-day bucket lives in src/${HOME} and nowhere else.`,
  `Import { relativeDueKey } ${HOME_IMPORT} instead of writing a second one.`,
  "If the behaviour needs to change, change it there — both the checkups page",
  "and the dashboard card read that body, and they must agree.",
].join(" ");

const FIX_THE_ZONE = [
  "The due phrase has to be worked out in the same zone as the date printed",
  `beside it. Read ${DISPLAY_ZONE_HOOK}() and pass it as the third argument to`,
  "relativeDueKey. Do not reach for the device clock and do not give the",
  "parameter a default: a caller that stays silent is exactly how the phrase",
  "and the date drifted a day apart in the first place.",
].join(" ");

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__/"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** A line that declares `relativeDueKey`, ignoring comment prose. */
function declaresTheBucket(source: string): boolean {
  return source
    .split("\n")
    .some(
      (line) =>
        /\b(function|const|let|var)\s+relativeDueKey\b/.test(line) &&
        !/^\s*(\*|\/\/|\/\*)/.test(line),
    );
}

describe("the checkup due-day bucket has one home", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real source-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(sourceFiles().length).toBeGreaterThan(1500);
  });

  it("is declared in exactly one file", () => {
    const declaring = sourceFiles().filter((rel) =>
      declaresTheBucket(read(rel)),
    );

    expect(declaring, FIX_IT).toEqual([HOME]);
  });

  it("is reached by import everywhere it is used", () => {
    const localUsers = sourceFiles()
      .filter((rel) => rel !== HOME)
      .filter((rel) => read(rel).includes("relativeDueKey"))
      .filter((rel) => !read(rel).includes(HOME_IMPORT));

    expect(localUsers, FIX_IT).toEqual([]);
  });

  it("is the only place the tomorrow, in-N-days and none keys are minted", () => {
    // Catches a duplicate that was renamed on the way in: whatever it is
    // called, a second bucket has to name the same keys to say the same words.
    const minters = sourceFiles()
      .filter((rel) => rel !== HOME)
      .filter((rel) => {
        const source = read(rel);
        return MINTED_ONLY_BY_THE_BUCKET.some((key) => source.includes(key));
      });

    expect(minters, FIX_IT).toEqual([]);
  });

  it("is what both checkup screens read their due line from", () => {
    for (const rel of RENDERING_SURFACES) {
      expect(read(rel), `${rel} no longer reads the shared due line`).toContain(
        HOME_IMPORT,
      );
    }
  });
});

describe("the due-day bucket asks the same clock as the date beside it", () => {
  it("never floors a day against the device clock", () => {
    // `startOfLocalDayInTz(instant, undefined)` means "whatever zone this
    // machine is set to". That is the reading the phrase used to take while
    // the date next to it took the profile zone.
    //
    // The check is the bare word rather than a shape like
    // `startOfLocalDayInTz(…, undefined)`, because the first draft of it
    // matched only the inline form and sailed straight past a mutation that
    // put the same `undefined` in a variable one line up. There is no honest
    // use for the word in a file whose whole job is to name a zone; if one
    // ever appears, that is worth coming here and arguing for.
    const home = read(HOME);

    expect(home, FIX_THE_ZONE).not.toContain("undefined");
  });

  it("takes the zone as an argument with no default to fall back on", () => {
    const home = read(HOME);
    const signature = home.slice(
      home.indexOf("export function relativeDueKey"),
      home.indexOf("): RelativeDue"),
    );

    expect(signature, FIX_THE_ZONE).toContain("timeZone: string");
    // `timeZone: string = …` or `timeZone = …` would let a caller stay silent.
    expect(signature, FIX_THE_ZONE).not.toMatch(/timeZone[^,)]*=/);
  });

  it("is called by surfaces that read the printed date's zone", () => {
    const silent = sourceFiles()
      .filter((rel) => rel !== HOME)
      .filter((rel) => read(rel).includes("relativeDueKey("))
      .filter((rel) => !read(rel).includes(DISPLAY_ZONE_HOOK));

    expect(silent, FIX_THE_ZONE).toEqual([]);
  });
});
