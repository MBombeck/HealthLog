/**
 * v1.5.0 — pure-helper tests for the medication-form refactor.
 *
 * The edit-only path of `medication-form.tsx` now composes the
 * v1.5 picker primitives. Two helpers carry the logic that survives
 * the legacy → v1.5 dual-write window:
 *
 *   inferCadenceFromLegacy  — choose the picker kind + sub-controls
 *                             that match a pre-v1.5 schedule
 *   legacyPairFromCadence   — derive the legacy (daysOfWeek,
 *                             intervalWeeks) pair the route still
 *                             persists alongside the v1.5 fields
 *
 * Both are pure functions; the tests pin the mapping table from the
 * design synthesis so a future picker tweak that drops one branch
 * surfaces here, not in a snapshot from production.
 */
import { describe, expect, it } from "vitest";

import {
  inferCadenceFromLegacy,
  legacyPairFromCadence,
  tokensToWeekdayIndexes,
  weekdayIndexesToTokens,
  weekdayIndexToToken,
} from "@/components/medications/scheduling/legacy-bridge";
import {
  DEFAULT_SUB_CONTROLS,
  type WeekdayToken,
} from "@/components/medications/scheduling/types";

describe("weekdayIndexToToken", () => {
  it("maps Sunday-anchored 0..6 to SU/MO/TU/WE/TH/FR/SA", () => {
    expect(weekdayIndexToToken(0)).toBe("SU");
    expect(weekdayIndexToToken(1)).toBe("MO");
    expect(weekdayIndexToToken(2)).toBe("TU");
    expect(weekdayIndexToToken(3)).toBe("WE");
    expect(weekdayIndexToToken(4)).toBe("TH");
    expect(weekdayIndexToToken(5)).toBe("FR");
    expect(weekdayIndexToToken(6)).toBe("SA");
  });

  it("returns null for out-of-range indexes", () => {
    expect(weekdayIndexToToken(-1)).toBeNull();
    expect(weekdayIndexToToken(7)).toBeNull();
    expect(weekdayIndexToToken(NaN)).toBeNull();
  });
});

describe("weekdayIndexesToTokens", () => {
  it("preserves the canonical Mo-Su order independent of input order", () => {
    expect(weekdayIndexesToTokens([5, 1, 3])).toEqual(["MO", "WE", "FR"]);
    expect(weekdayIndexesToTokens([0, 6])).toEqual(["SA", "SU"]);
  });

  it("dedupes duplicate indexes", () => {
    expect(weekdayIndexesToTokens([1, 1, 1])).toEqual(["MO"]);
  });

  it("filters out-of-range values silently", () => {
    expect(weekdayIndexesToTokens([1, 99, 3, -1])).toEqual(["MO", "WE"]);
  });

  it("returns [] for an empty input", () => {
    expect(weekdayIndexesToTokens([])).toEqual([]);
  });
});

describe("tokensToWeekdayIndexes", () => {
  it("inverts weekdayIndexesToTokens", () => {
    const tokens: WeekdayToken[] = ["MO", "WE", "FR"];
    expect(tokensToWeekdayIndexes(tokens)).toEqual([1, 3, 5]);
  });

  it("returns Sunday-anchored sorted indexes", () => {
    expect(tokensToWeekdayIndexes(["SU", "SA", "MO"])).toEqual([0, 1, 6]);
  });

  it("returns [] for an empty input", () => {
    expect(tokensToWeekdayIndexes([])).toEqual([]);
  });
});

describe("inferCadenceFromLegacy — mapping table", () => {
  it("empty daysOfWeek + intervalWeeks=1 → daily", () => {
    const result = inferCadenceFromLegacy({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
    expect(result.value.kind).toBe("daily");
    expect(result.value.rrule).toBe("FREQ=DAILY");
    expect(result.value.rollingIntervalDays).toBeNull();
    expect(result.value.oneShot).toBe(false);
    expect(result.subControls).toEqual(DEFAULT_SUB_CONTROLS);
  });

  it("non-empty daysOfWeek + intervalWeeks=1 → weekdays", () => {
    const result = inferCadenceFromLegacy({
      daysOfWeek: [1, 3, 5],
      intervalWeeks: 1,
    });
    expect(result.value.kind).toBe("weekdays");
    expect(result.value.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(result.subControls.weekdays).toEqual(["MO", "WE", "FR"]);
  });

  it("non-empty daysOfWeek + intervalWeeks>1 → everyNWeeks", () => {
    const result = inferCadenceFromLegacy({
      daysOfWeek: [3],
      intervalWeeks: 2,
    });
    expect(result.value.kind).toBe("everyNWeeks");
    expect(result.value.rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE");
    expect(result.subControls.weekdays).toEqual(["WE"]);
    expect(result.subControls.intervalWeeks).toBe(2);
  });

  it("preserves the multi-week interval verbatim up to the picker cap (52)", () => {
    const result = inferCadenceFromLegacy({
      daysOfWeek: [1],
      intervalWeeks: 4,
    });
    expect(result.value.rrule).toBe("FREQ=WEEKLY;INTERVAL=4;BYDAY=MO");
    expect(result.subControls.intervalWeeks).toBe(4);
  });

  it("empty daysOfWeek + intervalWeeks>1 → safe daily fallback", () => {
    // Pathological legacy shape — daysOfWeek empty AND intervalWeeks
    // bumped past 1. The legacy reader treats this as "every day every
    // N weeks" but the picker has no clean home for it; surface daily
    // so the user can pick a real cadence before saving.
    const result = inferCadenceFromLegacy({
      daysOfWeek: [],
      intervalWeeks: 3,
    });
    expect(result.value.kind).toBe("daily");
  });

  it("NaN intervalWeeks → daily fallback (no throw)", () => {
    const result = inferCadenceFromLegacy({
      daysOfWeek: [],
      intervalWeeks: NaN,
    });
    expect(result.value.kind).toBe("daily");
  });

  it("intervalWeeks=0 + non-empty daysOfWeek → safe daily fallback", () => {
    const result = inferCadenceFromLegacy({
      daysOfWeek: [1, 3],
      intervalWeeks: 0,
    });
    expect(result.value.kind).toBe("daily");
  });
});

describe("legacyPairFromCadence — dual-write derivation", () => {
  it("weekdays cadence → daysOfWeek + intervalWeeks=1", () => {
    const { value, subControls } = inferCadenceFromLegacy({
      daysOfWeek: [1, 3, 5],
      intervalWeeks: 1,
    });
    expect(legacyPairFromCadence(value, subControls)).toEqual({
      daysOfWeek: [1, 3, 5],
      intervalWeeks: 1,
    });
  });

  it("everyNWeeks cadence → daysOfWeek + intervalWeeks (clamped to 4)", () => {
    const { value, subControls } = inferCadenceFromLegacy({
      daysOfWeek: [3],
      intervalWeeks: 2,
    });
    expect(legacyPairFromCadence(value, subControls)).toEqual({
      daysOfWeek: [3],
      intervalWeeks: 2,
    });
  });

  it("everyNWeeks beyond the legacy cap clamps to 4", () => {
    // Picker accepts intervalWeeks up to 52; the legacy column tops
    // out at 4. The dual-write helper clamps so the row still
    // persists, while the canonical engine reads `rrule` for the
    // full interval.
    const value = {
      kind: "everyNWeeks" as const,
      rrule: "FREQ=WEEKLY;INTERVAL=12;BYDAY=MO",
      rollingIntervalDays: null,
      oneShot: false,
    };
    const subControls = { ...DEFAULT_SUB_CONTROLS, intervalWeeks: 12 };
    expect(legacyPairFromCadence(value, subControls)).toEqual({
      daysOfWeek: [1],
      intervalWeeks: 4,
    });
  });

  it("daily cadence → empty daysOfWeek, intervalWeeks=1", () => {
    const { value, subControls } = inferCadenceFromLegacy({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
    expect(legacyPairFromCadence(value, subControls)).toEqual({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
  });

  it("rolling cadence → empty legacy pair (most permissive fallback)", () => {
    const value = {
      kind: "rolling" as const,
      rrule: null,
      rollingIntervalDays: 7,
      oneShot: false,
    };
    expect(legacyPairFromCadence(value, DEFAULT_SUB_CONTROLS)).toEqual({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
  });

  it("oneShot cadence → empty legacy pair", () => {
    const value = {
      kind: "oneShot" as const,
      rrule: null,
      rollingIntervalDays: null,
      oneShot: true,
    };
    expect(legacyPairFromCadence(value, DEFAULT_SUB_CONTROLS)).toEqual({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
  });

  it("monthly cadence → empty legacy pair (no clean legacy mirror)", () => {
    const value = {
      kind: "monthly" as const,
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
      rollingIntervalDays: null,
      oneShot: false,
    };
    expect(legacyPairFromCadence(value, DEFAULT_SUB_CONTROLS)).toEqual({
      daysOfWeek: [],
      intervalWeeks: 1,
    });
  });
});
