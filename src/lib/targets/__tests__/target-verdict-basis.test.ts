import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { targetVerdictReference, withTargetVerdicts } from "../build-response";
import { resolveSummaryVerdicts } from "../trend-verdict";
import type { TargetItem } from "../types";

const OWN_BP = { BLOOD_PRESSURE_SYS: { min: 115, max: 125 } };
const CTX = {
  profile: { dateOfBirth: null, gender: null, heightCm: null },
  thresholdsJson: OWN_BP,
  pregnancy: false,
};

function item(
  type: string,
  current: number | null,
  average30: number | null = null,
): TargetItem {
  return {
    type,
    label: type,
    current,
    average30,
    trend: "up",
    unit: "",
    range: null,
    classification: null,
    source: "",
  } as TargetItem;
}

/**
 * The target tile and the dashboard tile judge the same change, so they are
 * placed with the same value: the seven-day mean, else the latest reading,
 * from the dashboard's summary slice.
 */
describe("target verdict basis", () => {
  it("places a target with the dashboard's seven-day mean, not its last reading", () => {
    // Last reading 118 (inside the own band), seven-day mean 132 (above it).
    const summaries = { BLOOD_PRESSURE_SYS: { avg7: 132, latest: 118 } };
    const [bp] = withTargetVerdicts(
      [item("BLOOD_PRESSURE", 118, 121)],
      CTX,
      summaries,
    );
    const dashboard = resolveSummaryVerdicts(summaries, CTX);
    expect(bp!.direction).toEqual(dashboard.BLOOD_PRESSURE_SYS);
    expect(bp!.direction?.targetPosition).toBe("above");
  });

  it("follows the resting heart rate for the pulse target when it exists", () => {
    expect(
      targetVerdictReference(
        item("PULSE", 70),
        { RESTING_HEART_RATE: { avg7: 52, latest: 50 } },
        undefined,
      ),
    ).toBe(52);
    expect(
      targetVerdictReference(
        item("PULSE", 70),
        { PULSE: { avg7: null, latest: 64 } },
        undefined,
      ),
    ).toBe(64);
  });

  it("judges BMI by the weight summary", () => {
    expect(
      targetVerdictReference(
        item("BMI", 24),
        { WEIGHT: { avg7: 80, latest: 81 } },
        undefined,
      ),
    ).toBe(80);
  });

  it("falls back to the item's own value without a summary", () => {
    expect(
      targetVerdictReference(item("SLEEP_DURATION", 7), {}, undefined),
    ).toBe(420);
    expect(
      targetVerdictReference(item("BMI", 24), {}, item("WEIGHT", null, 79)),
    ).toBe(79);
    expect(
      targetVerdictReference(item("MOOD_SCORE", null), {}, undefined),
    ).toBe(null);
  });
});
