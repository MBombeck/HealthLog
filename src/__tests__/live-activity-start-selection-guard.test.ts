/**
 * Structural guard: a server-side Live Activity start picks its dose by the
 * one start rule, and only by it.
 *
 * The relay pass used to start the first open dose it read, soonest slot
 * first. That was the oldest open row of the day: a dose an hour and a half
 * past its window, of a medication whose Live Activity opt-in was off, won
 * over the opted-in dose that was due, on the first pass after the consent.
 * The rule now lives in `startCandidates` (`src/lib/push-relay/live-activity.ts`):
 * the opt-in, the lead, pending or due by the resolver, earliest slot, ties
 * on the medication id; the pass tries the candidates in that order. Its matrix is in
 * `src/lib/push-relay/__tests__/live-activity-start-selection.test.ts`.
 *
 * What is frozen here:
 *   - exactly one file builds a relay start item (`eventType: LA_START_EVENT`
 *     beside `event: "start"`), so a second start path cannot pick its dose
 *     some other way;
 *   - that file reads its candidates through `startCandidates` over
 *     `openActivityDoses`, and never takes an element of the open doses by
 *     position;
 *   - the dose a started Activity reports to the app, and the pass's end of
 *     a server-started Activity, both read the one medication filter
 *     `STARTABLE_MEDICATION_WHERE`, which carries the opt-in.
 *
 * Limits: the matchers are textual; a start item spelt without
 * `LA_START_EVENT` would slip them. The behaviour is proven by the unit
 * matrix and by `tests/integration/push-live-activity-consent.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const START_FILE = "src/lib/push-relay/live-activity.ts";
const code = (rel: string, anchors: string | RegExp | (string | RegExp)[]) =>
  stripComments(readSource(rel, anchors));

describe("the relay Live Activity start", () => {
  it("is built in one file only", () => {
    const builders = readSourceFolder("src", {
      floor: 3000,
      include: (rel) =>
        !rel.startsWith("generated/") &&
        !rel.includes("__tests__") &&
        !/\.test\.tsx?$/.test(rel),
    })
      .filter(([, raw]) => {
        const text = stripComments(raw);
        return (
          /eventType\s*:\s*LA_START_EVENT\b/.test(text) &&
          /event\s*:\s*"start"/.test(text)
        );
      })
      .map(([rel]) => rel);
    requireFloor("relay start builders", builders, 1);
    expect(builders).toEqual(["lib/push-relay/live-activity.ts"]);
  });

  it("picks its dose through the one start rule", () => {
    const text = code(START_FILE, [
      "async function startItem",
      "startCandidates",
    ]);
    expect(
      text.match(/startCandidates\(\s*await\s+openActivityDoses\(/g) ?? [],
    ).toHaveLength(1);
    // No candidate by position: `const [dose] = await openActivityDoses(…)`
    // or `(await openActivityDoses(…))[0]` is the defect this guard exists for.
    expect(text).not.toMatch(
      /const\s*\[\s*\w+\s*\]\s*=\s*await\s+openActivityDoses\(/,
    );
    expect(text).not.toMatch(/openActivityDoses\([^)]*\)\s*\)\s*\[\s*0\s*\]/);
  });

  it("reads the opt-in wherever a started Activity is kept or reported", () => {
    const filter = code(
      "src/lib/push-relay/activity-slot.ts",
      "STARTABLE_MEDICATION_WHERE",
    );
    expect(filter).toMatch(
      /STARTABLE_MEDICATION_WHERE\s*=\s*\{[^}]*liveActivityEnabled\s*:\s*true/,
    );
    for (const rel of [
      START_FILE,
      "src/lib/push-relay/live-activity-started.ts",
    ]) {
      expect(
        (
          code(rel, "STARTABLE_MEDICATION_WHERE").match(
            /\.\.\.STARTABLE_MEDICATION_WHERE|medication\s*:\s*STARTABLE_MEDICATION_WHERE/g,
          ) ?? []
        ).length,
        rel,
      ).toBeGreaterThan(0);
    }
  });
});
