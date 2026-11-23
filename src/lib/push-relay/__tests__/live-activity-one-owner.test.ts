/**
 * One owner per dose: a relay start never joins an Activity the app already
 * shows for the dose, and a relay-started Activity the app's own one of the
 * same dose follows is the one that goes. Both use the slot match the end
 * path makes (`activityShowsDose`, within the tolerance of
 * `activitySlotWindow`).
 */
import { describe, expect, it } from "vitest";

import {
  activityShowsDose,
  activitySlotWindow,
} from "@/lib/push-relay/activity-slot";
import { supersededRelayActivities } from "@/lib/push-relay/live-activity";

const SLOT = new Date("2026-11-23T08:00:00Z");
const off = (s: number) => new Date(SLOT.getTime() + s * 1000);

function row(
  id: string,
  relayStarted: boolean,
  slotInstant: Date | null,
  medicationId = "med-a",
) {
  return { id, medicationId, slotInstant, relayStarted };
}

describe("activityShowsDose", () => {
  it("matches the same medication within the end path's window", () => {
    for (const s of [0, 59, -59]) {
      expect(activityShowsDose(row("a", false, off(s)), "med-a", SLOT)).toBe(
        true,
      );
    }
    for (const s of [61, -61]) {
      expect(activityShowsDose(row("a", false, off(s)), "med-a", SLOT)).toBe(
        false,
      );
    }
    expect(
      activityShowsDose(row("a", false, SLOT, "med-b"), "med-a", SLOT),
    ).toBe(false);
    expect(activityShowsDose(row("a", false, null), "med-a", SLOT)).toBe(true);
  });

  it("agrees with the window the end path queries", () => {
    for (const s of [-61, -60, -59.999, 0, 59.999, 60, 61]) {
      const window = activitySlotWindow(off(s));
      const inWindow = window.gte <= SLOT && SLOT <= window.lte;
      expect(activityShowsDose(row("a", false, off(s)), "med-a", SLOT)).toBe(
        inWindow,
      );
    }
  });
});

describe("supersededRelayActivities", () => {
  it("names the relay one the app's own Activity of the dose stands beside", () => {
    const relay = row("relay", true, SLOT);
    expect(
      supersededRelayActivities([relay, row("app", false, off(59))]),
    ).toEqual([relay]);
  });

  it("leaves it alone for another slot or medication, or with no app one", () => {
    const relay = row("relay", true, SLOT);
    expect(
      supersededRelayActivities([relay, row("app", false, off(61))]),
    ).toEqual([]);
    expect(
      supersededRelayActivities([relay, row("app", false, SLOT, "med-b")]),
    ).toEqual([]);
    expect(supersededRelayActivities([relay])).toEqual([]);
    // Two relay-started rows never supersede each other, nor an app one.
    expect(
      supersededRelayActivities([relay, row("relay-2", true, off(30))]),
    ).toEqual([]);
  });
});
