/**
 * When a named slot counts for a take (`named-slot.ts`): behind the take
 * however late, ahead of it only from the slot's early grace on.
 */
import { describe, expect, it } from "vitest";

import { namedSlotCountsForTake } from "@/lib/medications/scheduling/named-slot";

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
