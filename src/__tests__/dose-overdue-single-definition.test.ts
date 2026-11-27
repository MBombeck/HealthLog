/**
 * Structural guard: one meaning of "overdue" for a dose.
 *
 * The medication read's `nextDueOverdue` used to turn true the moment a
 * slot's anchor passed, while `currentDose.state`, the today rows and the
 * Live Activity still called the same dose `due` until its on-time window
 * closed. Two computations, two meanings on one wire. Now the dose resolver
 * owns the ladder (`openDoseStateAt`) and the one overdue predicate
 * (`isDoseOverdue`, both in `lib/medications/dose-state/resolve.ts`), and
 * every overdue flag a dose surface publishes is that predicate, a resolved
 * state compared with `"overdue"`, or a passthrough of another such flag.
 *
 * Three tripwires, comments stripped first; the planted cases prove each
 * fires:
 *   1. the literal state `"overdue"` is returned only by the ladder;
 *   2. a clock compared with a band's on-time end (`overdueSince` /
 *      `onTimeEnd`) appears only in the resolver and in the two places that
 *      grade a recorded take on time or late (not an open dose);
 *   3. an `overdue` / `nextDueOverdue` / `isOverdue` property in a dose
 *      surface is never computed from the clock or an instant comparison
 *      in place: it is the predicate, a resolved state compared with
 *      `"overdue"`, or a passthrough of another such flag.
 * A computation under another name slips them; review is the rest.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const HOME = "lib/medications/dose-state/resolve.ts";

/** Files that grade a recorded take against the on-time end, not a dose. */
const TAKE_GRADERS = new Set([
  "lib/medications/scheduling/dose-history.ts",
  "lib/analytics/compliance/parsing.ts",
]);

/** Where a dose's overdue flag is computed or published. */
const DOSE_SURFACES = [
  "lib/medications/",
  "lib/dashboard/",
  "lib/daily/",
  "lib/mcp/tools/get-medication-schedule.ts",
  "lib/push-relay/",
  "lib/notifications/",
  "lib/analytics/compliance/",
  "app/api/medications/",
  "app/api/dashboard/",
  "app/medications/",
  "components/medications/",
  "components/dashboard/",
];

const RETURNS_OVERDUE = /return\s+["']overdue["']/;
const CLOCK_VS_ON_TIME_END =
  /\b(?:overdueSince|onTimeEnd)\b(?:\.getTime\(\))?\s*[<>]=?|[<>]=?\s*[\w?.]*\b(?:overdueSince|onTimeEnd)\b/;
const OVERDUE_PROPERTY =
  /\b(?:overdue|nextDueOverdue|isOverdue)\??\s*:\s*([^,;\n}]+)/g;
/** A value computed from the clock or an instant comparison. */
const COMPUTED = /(?<!=)[<>]|getTime\(|Date\.now\(/;
const FROM_RESOLVER = /isDoseOverdue\(|===\s*["']overdue["']/;

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 }).filter(
    (p) =>
      !p.startsWith("generated/") &&
      !p.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(p),
  );
}

function offendingProperties(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(OVERDUE_PROPERTY)) {
    const source = match[1].trim();
    if (COMPUTED.test(source) && !FROM_RESOLVER.test(source)) {
      found.push(match[0].trim());
    }
  }
  return found;
}

describe("one meaning of overdue for a dose", () => {
  it("the matchers fire on a second computation", () => {
    expect(RETURNS_OVERDUE.test('  return "overdue";')).toBe(true);
    expect(
      CLOCK_VS_ON_TIME_END.test(
        "if (now.getTime() > band.onTimeEnd.getTime())",
      ),
    ).toBe(true);
    expect(CLOCK_VS_ON_TIME_END.test("t <= dose.overdueSince.getTime()")).toBe(
      true,
    );
    expect(
      offendingProperties("{ overdue: anchor < now.getTime(), at }"),
    ).toHaveLength(1);
    expect(
      offendingProperties("{ nextDueOverdue: slot.getTime() <= Date.now() }"),
    ).toHaveLength(1);
    expect(
      offendingProperties(
        '{ overdue: dose.state === "overdue", isOverdue: isDoseOverdue(i, now), nextDueOverdue: next?.overdue ?? false }',
      ),
    ).toEqual([]);
  });

  it("the resolver holds the ladder and the predicate", () => {
    const home = stripComments(
      readSource(`src/${HOME}`, "export function openDoseStateAt"),
    );
    expect(home).toMatch(/export function openDoseStateAt\s*\(/);
    expect(home).toMatch(/export function isDoseOverdue\s*\(/);
    expect(RETURNS_OVERDUE.test(home)).toBe(true);
  });

  it("the medication read's display slot asks the predicate", () => {
    const nextDue = stripComments(
      readSource(
        "src/lib/medications/scheduling/next-due.ts",
        "export function computeDisplayDue",
      ),
    );
    expect(nextDue).toMatch(/isDoseOverdue\(/);
  });

  it("no other file returns the overdue state or compares a clock with the on-time end", () => {
    const files = sourceFiles();
    const comparers = files.filter((file) =>
      CLOCK_VS_ON_TIME_END.test(stripComments(readSourceText(join(SRC, file)))),
    );
    // The resolver and the take graders match, so a blind matcher fails here.
    expect(comparers).toEqual(expect.arrayContaining([HOME, ...TAKE_GRADERS]));
    expect(
      comparers.filter((file) => file !== HOME && !TAKE_GRADERS.has(file)),
    ).toEqual([]);

    const returners = files.filter((file) =>
      RETURNS_OVERDUE.test(stripComments(readSourceText(join(SRC, file)))),
    );
    expect(returners).toEqual([HOME]);
  });

  it("every overdue flag a dose surface publishes comes from the resolver", () => {
    const files = sourceFiles().filter((file) =>
      DOSE_SURFACES.some((prefix) => file.startsWith(prefix)),
    );
    let seen = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readSourceText(join(SRC, file)));
      seen += [...code.matchAll(OVERDUE_PROPERTY)].length;
      for (const hit of offendingProperties(code)) {
        offenders.push(`${file}: ${hit}`);
      }
    }
    // A matcher that finds nothing proves nothing.
    expect(seen).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
