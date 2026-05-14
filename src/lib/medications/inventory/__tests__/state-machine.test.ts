import { describe, expect, it } from "vitest";

import {
  computeExpiresAt,
  computeInventoryState,
  daysRemainingInUse,
  decrementDose,
  DEFAULT_IN_USE_WINDOW_DAYS,
  type InventoryItemView,
} from "../state-machine";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-05-14T12:00:00Z");
const NOW_MS = NOW.getTime();

function makeItem(overrides: Partial<InventoryItemView> = {}): InventoryItemView {
  return {
    state: "ACTIVE",
    dosesTotal: 4,
    dosesRemaining: 4,
    firstUseAt: null,
    printedExpiry: null,
    ...overrides,
  };
}

describe("computeInventoryState", () => {
  it("returns ACTIVE for a fresh refrigerated pen", () => {
    expect(computeInventoryState(makeItem(), NOW_MS)).toBe("ACTIVE");
  });

  it("returns IN_USE once firstUseAt is set and within the 30-day window", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("IN_USE");
  });

  it("returns EXPIRED when the in-use clock blew past 30 days", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 31 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns EXPIRED when printed expiry has lapsed (unopened pen)", () => {
    const item = makeItem({
      printedExpiry: new Date(NOW_MS - 1 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns EXPIRED when printed expiry has lapsed even if in-use clock still valid", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
      printedExpiry: new Date(NOW_MS - 1 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns USED_UP when dosesRemaining is zero (terminal — outranks EXPIRED)", () => {
    const item = makeItem({
      dosesRemaining: 0,
      firstUseAt: new Date(NOW_MS - 31 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("USED_UP");
  });

  it("returns USED_UP even when printed expiry has lapsed (dosesRemaining wins)", () => {
    const item = makeItem({
      dosesRemaining: 0,
      printedExpiry: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("USED_UP");
  });

  it("respects a custom in-use window override", () => {
    // Ozempic — 56 days per its EPAR.
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 45 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS, 56)).toBe("IN_USE");
    expect(computeInventoryState(item, NOW_MS, 30)).toBe("EXPIRED");
  });

  it("treats the exact 30-day boundary as still IN_USE", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 30 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("IN_USE");
  });
});

describe("computeExpiresAt", () => {
  it("returns null when neither firstUseAt nor printedExpiry is set", () => {
    expect(computeExpiresAt(null, null)).toBeNull();
  });

  it("returns the printed expiry when only printedExpiry is set", () => {
    const printed = new Date("2027-01-15T00:00:00Z");
    expect(computeExpiresAt(null, printed)).toEqual(printed);
  });

  it("returns firstUseAt + 30 days when only firstUseAt is set", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const result = computeExpiresAt(firstUse, null);
    expect(result?.getTime()).toBe(firstUse.getTime() + 30 * MS_PER_DAY);
  });

  it("returns the in-use deadline when it lands before printed expiry", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const printed = new Date("2027-01-15T00:00:00Z");
    const result = computeExpiresAt(firstUse, printed);
    expect(result?.getTime()).toBe(firstUse.getTime() + 30 * MS_PER_DAY);
  });

  it("returns the printed expiry when it lands before the in-use deadline", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const printed = new Date("2026-05-10T00:00:00Z");
    const result = computeExpiresAt(firstUse, printed);
    expect(result).toEqual(printed);
  });
});

describe("decrementDose", () => {
  it("first_use — flips ACTIVE → IN_USE and sets firstUseAt", () => {
    const item = makeItem();
    const result = decrementDose(item, NOW);

    expect(result.change).toBe("first_use");
    expect(result.item.state).toBe("IN_USE");
    expect(result.item.firstUseAt).toEqual(NOW);
    expect(result.item.dosesRemaining).toBe(3);
    expect(result.item.expiresAt?.getTime()).toBe(
      NOW_MS + DEFAULT_IN_USE_WINDOW_DAYS * MS_PER_DAY,
    );
  });

  it("consumed — IN_USE pen with doses left stays IN_USE", () => {
    const firstUse = new Date(NOW_MS - 3 * MS_PER_DAY);
    const item = makeItem({
      state: "IN_USE",
      dosesRemaining: 3,
      firstUseAt: firstUse,
    });
    const result = decrementDose(item, NOW);

    expect(result.change).toBe("consumed");
    expect(result.item.state).toBe("IN_USE");
    expect(result.item.firstUseAt).toEqual(firstUse);
    expect(result.item.dosesRemaining).toBe(2);
  });

  it("depleted — final dose flips state to USED_UP", () => {
    const firstUse = new Date(NOW_MS - 3 * MS_PER_DAY);
    const item = makeItem({
      state: "IN_USE",
      dosesRemaining: 1,
      firstUseAt: firstUse,
    });
    const result = decrementDose(item, NOW);

    expect(result.change).toBe("depleted");
    expect(result.item.state).toBe("USED_UP");
    expect(result.item.dosesRemaining).toBe(0);
  });

  it("does not mutate its input", () => {
    const firstUse = new Date(NOW_MS - 3 * MS_PER_DAY);
    const item = makeItem({
      state: "IN_USE",
      dosesRemaining: 3,
      firstUseAt: firstUse,
    });
    const snapshot = JSON.stringify(item);
    decrementDose(item, NOW);
    expect(JSON.stringify(item)).toBe(snapshot);
  });

  it("clamps dosesRemaining at zero even if called on an already-empty pen", () => {
    const item = makeItem({
      state: "USED_UP",
      dosesRemaining: 0,
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    const result = decrementDose(item, NOW);

    expect(result.item.dosesRemaining).toBe(0);
    expect(result.item.state).toBe("USED_UP");
  });
});

describe("daysRemainingInUse", () => {
  it("returns null for an ACTIVE (unopened) pen", () => {
    expect(daysRemainingInUse(makeItem(), NOW_MS)).toBeNull();
  });

  it("returns null for an EXPIRED pen (clock blew)", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 31 * MS_PER_DAY),
    });
    expect(daysRemainingInUse(item, NOW_MS)).toBeNull();
  });

  it("returns null for a USED_UP pen", () => {
    const item = makeItem({
      dosesRemaining: 0,
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    expect(daysRemainingInUse(item, NOW_MS)).toBeNull();
  });

  it("returns 25 days when the pen was opened 5 days ago", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    expect(daysRemainingInUse(item, NOW_MS)).toBe(25);
  });

  it("returns 0 on the last day of the window (still IN_USE)", () => {
    // 29 days + 23h59m elapsed — under one day left, floor → 0.
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 30 * MS_PER_DAY + 60_000),
    });
    expect(daysRemainingInUse(item, NOW_MS)).toBe(0);
  });

  describe("thin-shape overload (v1.4.25 W21 Fix-N)", () => {
    // The medication-detail card calls this with just `{ firstUseAt }`
    // because it has already filtered the list to state === "IN_USE"
    // before reaching the helper. The thin overload skips the
    // state-machine gate.
    it("accepts a thin `{ firstUseAt: Date }` shape", () => {
      const firstUseAt = new Date(NOW_MS - 5 * MS_PER_DAY);
      expect(daysRemainingInUse({ firstUseAt }, NOW_MS)).toBe(25);
    });

    it("accepts a thin `{ firstUseAt: string }` ISO shape", () => {
      const firstUseAt = new Date(NOW_MS - 10 * MS_PER_DAY).toISOString();
      expect(daysRemainingInUse({ firstUseAt }, NOW_MS)).toBe(20);
    });

    it("returns null when the thin firstUseAt is null", () => {
      expect(daysRemainingInUse({ firstUseAt: null }, NOW_MS)).toBeNull();
    });

    it("skips the state-machine gate for the thin form", () => {
      // 31 days past the window — the full-view path would return
      // null here (state ≠ IN_USE). The thin form returns 0 because
      // the caller has already gated on IN_USE.
      const firstUseAt = new Date(NOW_MS - 31 * MS_PER_DAY);
      expect(daysRemainingInUse({ firstUseAt }, NOW_MS)).toBe(0);
    });
  });
});
