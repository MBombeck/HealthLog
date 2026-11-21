/**
 * The card's pill when `currentDose` is about a later slot than the one the
 * card shows. `complianceDisplay.currentDose` anchors on the open cycle,
 * which walks forward from now: once a dose's time has passed it already
 * names tomorrow's slot, pending, although today's dose is still due. The
 * card then painted no pill at all for a dose due right now.
 */
import { describe, expect, it } from "vitest";

import { cardWindowPill } from "../pill";

const NOW = new Date("2026-11-21T14:10:00.000Z");
const TODAY_SLOT = "2026-11-21T13:59:00.000Z";
const fallback = {
  status: "in_window" as const,
  window: { start: "13:59", end: "14:59" },
  takenEarlyDaysAgo: null,
};
const tomorrow = {
  state: "upcoming",
  targetAt: "2026-11-22T13:59:00.000Z",
  dueAt: "2026-11-22T12:59:00.000Z",
  overdueSince: "2026-11-22T14:59:00.000Z",
  missedAfter: "2026-11-22T17:59:00.000Z",
};

describe("cardWindowPill", () => {
  it("keeps the card's reading of the open slot when currentDose is about a later one", () => {
    const pill = cardWindowPill(tomorrow, fallback, NOW, "UTC", TODAY_SLOT);
    expect(pill?.status).toBe("in_window");
  });

  it("reads the server's dose when it is about the slot the card shows", () => {
    const sameSlot = {
      state: "due",
      targetAt: TODAY_SLOT,
      dueAt: "2026-11-21T12:59:00.000Z",
      overdueSince: "2026-11-21T14:59:00.000Z",
      missedAfter: "2026-11-21T17:59:00.000Z",
    };
    const pill = cardWindowPill(sameSlot, fallback, NOW, "UTC", TODAY_SLOT);
    expect(pill).toMatchObject({ status: "in_window", windowStart: "12:59" });
  });

  it("without a shown slot, the server's answer stands (no pill)", () => {
    expect(cardWindowPill(tomorrow, fallback, NOW, "UTC")).toBeNull();
  });
});
