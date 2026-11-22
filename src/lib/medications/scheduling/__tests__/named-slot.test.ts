/**
 * When a named slot counts for a take (`named-slot.ts`): behind the take
 * however late, ahead of it only from the slot's early grace on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveBand = vi.hoisted(() => vi.fn());
vi.mock("@/lib/medications/scheduling/slot-upsert", () => ({
  TAKEN_SLOT_FORWARD_GRACE_MS: 5 * 60 * 1000,
  resolveForcedSlotBandForWrite: resolveBand,
}));

import {
  bindNamedTake,
  namedSlotCountsForTake,
} from "@/lib/medications/scheduling/named-slot";

const at = (hm: string) => new Date(`2026-11-21T${hm}:00.000Z`);

// The 20:00 dose with the default window: on time from 19:00, early grace
// from 18:00.
const evening = { at: at("20:00"), earlyStart: at("18:00") };

describe("namedSlotCountsForTake", () => {
  it.each([
    ["19:30", "due, half an hour early"],
    ["18:00", "the first minute of the early grace"],
    ["19:56", "inside the clock-skew grace too"],
    ["20:00", "on the slot"],
    ["23:30", "late"],
  ])("a take at %s counts (%s)", (clock) => {
    expect(namedSlotCountsForTake(evening, at(clock))).toBe(true);
  });

  it.each([
    ["17:59", "a minute before the early grace"],
    ["12:00", "the late-morning take that must not consume the evening slot"],
  ])("a take at %s does not count (%s)", (clock) => {
    expect(namedSlotCountsForTake(evening, at(clock))).toBe(false);
  });

  it("counts a slot from an earlier day, however late", () => {
    expect(
      namedSlotCountsForTake(
        {
          at: new Date("2026-11-19T08:00:00.000Z"),
          earlyStart: new Date("2026-11-19T06:00:00.000Z"),
        },
        at("12:00"),
      ),
    ).toBe(true);
  });
});

describe("bindNamedTake", () => {
  const base = {
    userId: "u",
    medicationId: "m",
    userTz: "UTC",
    takenAt: at("19:30"),
  };

  beforeEach(() => {
    resolveBand.mockReset();
  });

  it("keeps the band's slot without a second read when it is the named one", async () => {
    const bound = await bindNamedTake({
      ...base,
      bandSlot: at("20:00"),
      namedSlot: new Date(at("20:00").getTime() + 30_000),
    });
    expect(bound).toEqual({
      canonicalSlot: at("20:00"),
      attributionSource: "AUTO",
    });
    expect(resolveBand).not.toHaveBeenCalled();
  });

  it("puts the take on the named slot over the band's neighbour, as a pin", async () => {
    resolveBand.mockResolvedValue(evening);
    const bound = await bindNamedTake({
      ...base,
      bandSlot: at("19:00"),
      namedSlot: at("20:00"),
    });
    expect(bound).toEqual({
      canonicalSlot: at("20:00"),
      attributionSource: "USER_PIN",
    });
  });

  it("keeps the band when the named instant is not a slot, or the take is before its window", async () => {
    resolveBand.mockResolvedValue(null);
    expect(
      await bindNamedTake({ ...base, bandSlot: null, namedSlot: at("20:07") }),
    ).toEqual({ canonicalSlot: null, attributionSource: "AUTO" });

    resolveBand.mockResolvedValue(evening);
    expect(
      await bindNamedTake({
        ...base,
        takenAt: at("12:00"),
        bandSlot: null,
        namedSlot: at("20:00"),
      }),
    ).toEqual({ canonicalSlot: null, attributionSource: "AUTO" });
  });

  it("answers the band alone when no slot is named", async () => {
    expect(
      await bindNamedTake({ ...base, bandSlot: null, namedSlot: undefined }),
    ).toEqual({ canonicalSlot: null, attributionSource: "AUTO" });
    expect(resolveBand).not.toHaveBeenCalled();
  });
});
