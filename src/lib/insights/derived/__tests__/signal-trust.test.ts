import { DEFAULT_SOURCE_PRIORITY } from "@/lib/validations/source-priority";
import { describe, it, expect } from "vitest";
import {
  describeRecoveryDivergence,
  type RecoveryRow,
} from "@/lib/insights/derived/recovery-resolve";

// WHOOP stamps the wake morning of day D; the COMPUTED proxy stamps day D−1
// (noon UTC), which the resolver shifts forward one day. With these stamps both
// land on the same physiological night (wake day 2026-06-20).
function nightRows(whoop: number, computed: number): RecoveryRow[] {
  return [
    {
      value: whoop,
      measuredAt: new Date("2026-06-20T06:00:00.000Z"),
      source: "WHOOP",
    },
    {
      value: computed,
      measuredAt: new Date("2026-06-19T12:00:00.000Z"),
      source: "COMPUTED",
    },
  ];
}

describe("describeRecoveryDivergence", () => {
  it("surfaces a material divergence, picking the native source", () => {
    const out = describeRecoveryDivergence(
      nightRows(64, 51),
      "Europe/Berlin",
      DEFAULT_SOURCE_PRIORITY.recovery,
    );
    expect(out).not.toBeNull();
    expect(out!.chosenSource).toBe("WHOOP");
    expect(out!.alternativeSource).toBe("COMPUTED");
    expect(out!.chosenValue).toBe(64);
    expect(out!.alternativeValue).toBe(51);
    expect(out!.divergence).toBe(13);
    expect(out!.chosenIsDirect).toBe(true);
  });

  it("omits a trivial divergence (sources agree)", () => {
    expect(
      describeRecoveryDivergence(
        nightRows(64, 61),
        "Europe/Berlin",
        DEFAULT_SOURCE_PRIORITY.recovery,
      ),
    ).toBeNull();
  });

  it("returns null when only one source is present", () => {
    const rows: RecoveryRow[] = [
      {
        value: 64,
        measuredAt: new Date("2026-06-20T06:00:00.000Z"),
        source: "WHOOP",
      },
    ];
    expect(
      describeRecoveryDivergence(
        rows,
        "Europe/Berlin",
        DEFAULT_SOURCE_PRIORITY.recovery,
      ),
    ).toBeNull();
  });

  it("returns null on an empty set", () => {
    expect(
      describeRecoveryDivergence(
        [],
        "Europe/Berlin",
        DEFAULT_SOURCE_PRIORITY.recovery,
      ),
    ).toBeNull();
  });
});
