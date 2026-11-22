/**
 * During a pregnancy or its postpartum weeks weight is data: no reader grades
 * it against a goal or a BMI band, no Coach nudge is about it, and nothing
 * celebrates it.
 *
 * The state was honoured where it was first wired (the Health Score's weight
 * goal and body-shape pillar, the weight personal records) and nowhere else:
 * the weight page said "Overweight, 0 of 7 in range" at week 12, the doctor
 * report printed a BMI category beside "Pregnant, week 30", and the Coach
 * still nudged about weight drift. The readers each ask the one helper,
 * `src/lib/cycle/pregnancy-context.ts` (`pregnancyContextActive` for today,
 * `pregnancyDayTest` per day, `weightTargetFor` for the person's target); `resolveTrendVerdict` takes the answer as a
 * required input, so the compiler finds every verdict caller.
 *
 * This freezes the readers: a file that calls a weight or BMI classifier or
 * the weight-target resolver either asks the helper or is listed below with
 * the reason it need not. A new reader fails here until it does one or the
 * other. What the matcher cannot see: a classifier under a new name.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

const CLASSIFIER =
  /\b(classifyBMI|classifyBmi|bmiCategory|getWeightRange|resolveWeightTargetOverride|getBmiClassificationKey|evaluateWeightTrigger)\(/;
const HELPER =
  /\b(pregnancyContextActive|pregnancyContextFor|pregnancyDayTest|weightFramingPaused|weightTargetFor)\(/;

const NEED_NOT_ASK: Readonly<Record<string, string>> = {
  "lib/analytics/classifications.ts":
    "defines the classifiers; the overview hands its alerts no BMI during a pregnancy",
  "lib/analytics/effective-range.ts": "defines the weight-target resolver",
  "lib/doctor-report-pdf/clinical-summary.ts":
    "defines the report's BMI key; the report data carries no BMI during a pregnancy (collect.ts)",
  "lib/doctor-report-pdf/measurements-charts-section.ts":
    "prints the report's BMI, which collect.ts leaves null during a pregnancy",
  "lib/targets/trend-verdict.ts":
    "takes `pregnancy` as a required input; every caller asks the helper",
  "lib/targets/vitals-builder.ts":
    "takes `pregnancy` from build-response.ts, which asks the helper",
  "components/dashboard/tiles/tile-context.ts":
    "client fallback until the snapshot lands; the snapshot's weight trend asks the helper",
};

const files = readSourceFolder("src", {
  floor: 1000,
  include: (rel) =>
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
});

describe("weight and BMI readers respect a pregnancy", () => {
  const readers = files.filter(([, text]) => CLASSIFIER.test(text));

  it("finds the readers at all", () => {
    expect(readers.length).toBeGreaterThanOrEqual(15);
  });

  it("every reader asks the pregnancy helper, or says why it need not", () => {
    const silent = readers
      .filter(([rel, text]) => !HELPER.test(text) && !(rel in NEED_NOT_ASK))
      .map(([rel]) => rel);
    expect(
      silent,
      "these files classify weight or BMI without asking pregnancyContextActive",
    ).toEqual([]);
  });

  it("lists no exemption that no longer reads a classifier", () => {
    const stale = Object.keys(NEED_NOT_ASK).filter(
      (rel) => !readers.some(([path]) => path === rel),
    );
    expect(stale).toEqual([]);
  });
});
