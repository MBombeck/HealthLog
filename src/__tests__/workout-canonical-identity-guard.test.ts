/**
 * Structural guard on the canonical-workout session identity.
 *
 * `pickCanonicalWorkoutRows()` collapses a HealthKit session that arrived more
 * than once under different external UUIDs. It can only do that when the row it
 * is handed carries the identity fields, and the row shape comes from each
 * caller's own Prisma `select`. Nothing in the type system connects the two:
 * `durationSec` is optional on `WorkoutPickerRow`, so a caller that omits it
 * gets silent passthrough rather than a compile error.
 *
 * That is exactly what happened. When the collapse first shipped, the key was
 * `(sportType, startedAt, endedAt, durationSec)` and only the workout list
 * selected `endedAt`. The list showed one workout while the Coach narrated the
 * duplicate, the per-sport baseline averaged it twice and the deep-link cluster
 * kept both rows. One record, four surfaces, two answers.
 *
 * These are tripwires, not proofs. They cannot show the collapse is correct —
 * that is what the unit tests do. What they can do is refuse to let a new call
 * site join the set without someone editing this file, and refuse to let the
 * identity quietly grow a field that only some callers fetch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The picker module itself — declares the identity, does not consume it. */
const PICKER = "lib/measurements/pick-canonical-workout-rows.ts";

/**
 * The only module that hands rows to the picker: the windowed reader, which
 * picks over rows it read with the duplicate-window margin. Every surface goes
 * through it, and its output types make a read without the margin a compile
 * error. The strain engine's per-cluster impulse sum lives there too and is
 * handed the rows of the engine's own windowed read.
 */
const PICKER_CALLERS = ["lib/workouts/canonical-read.ts"];

/**
 * Every production read that decides which workout is canonical, frozen.
 *
 * Adding a surface that collapses workouts is a deliberate act: it must read
 * through `readWorkoutsAroundRange` and fetch the identity fields, or it
 * silently disagrees with every other surface. Adding the file here is the
 * acknowledgement. The value is the file that owns the read's `select`.
 */
const IDENTITY_OWNER: Record<string, string> = {
  // The workout detail read behind `GET /api/workouts/{id}`.
  "lib/workouts/detail.ts": "lib/workouts/detail.ts",
  "lib/jobs/workout-insight-generate.ts":
    "lib/jobs/workout-insight-generate.ts",
  "lib/workouts/list-read.ts": "lib/workouts/list-read.ts",
  "lib/workouts/sport-context.ts": "lib/workouts/sport-context.ts",
  // The doctor report's per-sport block (v1.44): sums sessions, so a session
  // two sources reported must count once, as it does on the list.
  "lib/doctor-report/workouts.ts": "lib/doctor-report/workouts.ts",
  // The activity calendar counts workouts per day; a session two devices
  // recorded must count once there, as it does in the list.
  "lib/activity/calendar-read.ts": "lib/activity/calendar-read.ts",
  // The Coach block is handed rows it does not read itself; the snapshot
  // builder fetches them through this read in parallel with every other
  // block's data.
  "lib/ai/coach/snapshot-blocks/workouts-read.ts":
    "lib/ai/coach/snapshot-blocks/workouts-read.ts",
  // The write path: the batch route clusters the rows it is about to insert
  // together with the stored rows around them, so a duplicate is dropped by
  // the rule the list later applies.
  "lib/workouts/batch-dedup.ts": "lib/workouts/batch-dedup.ts",
  // The day-total training impulse, the briefing's workout tally and the day
  // view's workout section: each counted a session synced by two services
  // twice while the list showed it once.
  "lib/insights/strain-score.ts": "lib/insights/strain-score.ts",
  "lib/insights/feature-blocks.ts": "lib/insights/feature-blocks.ts",
  "lib/day/records.ts": "lib/day/records.ts",
  // The workout-minutes correlation channel: one session per day per sport,
  // as the list shows it.
  "lib/insights/correlation-channel-series.ts":
    "lib/insights/correlation-channel-series.ts",
};

/**
 * How a call site proves its rows carry the duration. A read selects the
 * column; the batch route also maps it off the row it computed for the insert.
 */
const IDENTITY_PROOF: Record<string, string[]> = {
  // These two select `WORKOUT_PICK_SELECT`, whose duration is checked below.
  "lib/day/records.ts": ["select: WORKOUT_PICK_SELECT"],
  "lib/insights/correlation-channel-series.ts": ["select: WORKOUT_PICK_SELECT"],
  "lib/workouts/batch-dedup.ts": [
    "durationSec: true",
    "durationSec: p.row.durationSec",
  ],
};

const EXPECTED_CALL_SITES = Object.keys(IDENTITY_OWNER).sort();

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * Lines that actually invoke `call`. Comment lines are excluded: a docblock
 * that names the function is documentation rather than a call.
 */
function invokes(source: string, call: string): boolean {
  return source
    .split("\n")
    .some((line) => line.includes(call) && !/^\s*(\*|\/\/|\/\*)/.test(line));
}

describe("the picker's call-site set is frozen", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real source-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(sourceFiles().length).toBeGreaterThan(1500);
  });

  it("hands rows to the picker only from the windowed reader", () => {
    const found = sourceFiles()
      .filter((rel) => rel !== PICKER)
      .filter((rel) => invokes(read(rel), "pickCanonicalWorkoutRows("));

    expect(found).toEqual(PICKER_CALLERS);
  });

  it("has exactly the windowed reads this file acknowledges", () => {
    const found = sourceFiles()
      .filter((rel) => rel !== "lib/workouts/canonical-read.ts")
      .filter((rel) => invokes(read(rel), "readWorkoutsAroundRange("));

    expect(found).toEqual(EXPECTED_CALL_SITES);
  });

  it("scores strain only on the sessions of the windowed range", () => {
    // The strain engine sums impulses over the rows of its windowed read; it
    // must keep the sessions its range owns, not every cluster the margin read.
    expect(read("lib/insights/strain-score.ts")).toContain(
      "(at) => startsInRange(workouts.range, at)",
    );
  });
});

describe("every call site fetches the session identity", () => {
  it.each(EXPECTED_CALL_SITES)("%s gets rows carrying durationSec", (rel) => {
    // File-level rather than per-select: a caller that fetches workout rows
    // without their duration cannot collapse a re-send, whichever select the
    // rows came from. Coarse in the safe direction — it can only fail to catch
    // a second unrelated select in the same file, never pass a caller that
    // fetches no duration at all.
    for (const proof of IDENTITY_PROOF[rel] ?? ["durationSec: true"]) {
      expect(read(IDENTITY_OWNER[rel])).toContain(proof);
    }
  });
});

describe("the shared pick select carries the identity", () => {
  it("selects durationSec", () => {
    const reader = read("lib/workouts/canonical-read.ts");
    const select = reader.slice(
      reader.indexOf("export const WORKOUT_PICK_SELECT"),
      reader.indexOf("} as const;"),
    );
    expect(select).toContain("durationSec: true");
  });
});

describe("the identity cannot quietly grow a field callers do not fetch", () => {
  it("keys the session on sportType, startedAt and durationSec only", () => {
    const picker = read(PICKER);
    const body = picker.slice(
      picker.indexOf("function exactSessionKey"),
      picker.indexOf("function rowRichness"),
    );

    expect(body).toContain("row.sportType");
    expect(body).toContain("row.startedAt");
    expect(body).toContain("row.durationSec");
    // `endedAt` is the specific field that split the callers. On a workout with
    // pauses it disagrees with `durationSec` by design, so it rejected genuine
    // re-sends while forcing every caller to fetch a fourth column.
    expect(body).not.toContain("endedAt");
  });
});
