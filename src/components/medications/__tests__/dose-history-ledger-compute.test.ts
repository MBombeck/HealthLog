import { describe, expect, it } from "vitest";

import {
  applyOptimisticSlotMark,
  slotMarkRequestBody,
  complianceFromLedger,
  formatSlotDelta,
  groupLedgerByDay,
  isSlotActionable,
  type LedgerPayload,
  type LedgerRow,
} from "@/components/medications/dose-history-ledger-compute";

/**
 * v1.15.18 WE — the pure helpers behind the Verlauf ledger. These cover the
 * instant-recompute contract (the optimistic % must track the ledger the user
 * sees), the day grouping, the actionability guard, and the optimistic-mark
 * mutation that flips a slot before the server round-trip.
 */

function slotRow(
  at: string,
  status: LedgerRow["status"],
  intake?: LedgerRow["intake"],
): LedgerRow {
  return {
    kind: "slot",
    at,
    timeOfDay: "07:00",
    status,
    intake: intake ?? null,
  };
}

describe("complianceFromLedger", () => {
  it("counts taken (on-time + late) over taken + missed, excluding skip/ad-hoc/upcoming", () => {
    const rows: LedgerRow[] = [
      slotRow("2026-06-01T05:00:00.000Z", "taken_on_time"),
      slotRow("2026-06-02T05:00:00.000Z", "taken_late"),
      slotRow("2026-06-03T05:00:00.000Z", "missed"),
      slotRow("2026-06-04T05:00:00.000Z", "skipped"),
      slotRow("2026-06-05T05:00:00.000Z", "upcoming"),
      {
        kind: "ad_hoc",
        at: "2026-06-06T12:00:00.000Z",
        timeOfDay: null,
        status: "ad_hoc",
        intake: null,
      },
    ];
    const c = complianceFromLedger(rows);
    expect(c.takenOnTime).toBe(1);
    expect(c.takenLate).toBe(1);
    expect(c.missed).toBe(1);
    expect(c.denominator).toBe(3); // 2 taken + 1 missed
    expect(c.rate).toBe(67); // round(2/3 * 100)
  });

  it("returns a null rate when nothing counts yet (only upcoming / skipped)", () => {
    const rows: LedgerRow[] = [
      slotRow("2026-06-05T05:00:00.000Z", "upcoming"),
      slotRow("2026-06-04T05:00:00.000Z", "skipped"),
    ];
    expect(complianceFromLedger(rows).rate).toBeNull();
  });

  it("caps the rate at 100", () => {
    const rows: LedgerRow[] = [
      slotRow("2026-06-01T05:00:00.000Z", "taken_on_time"),
      slotRow("2026-06-02T05:00:00.000Z", "taken_on_time"),
    ];
    expect(complianceFromLedger(rows).rate).toBe(100);
  });
});

describe("groupLedgerByDay", () => {
  it("groups by local day, most-recent day first, chronological within a day", () => {
    const rows: LedgerRow[] = [
      slotRow("2026-06-02T17:00:00.000Z", "taken_on_time"), // 19:00 Berlin
      slotRow("2026-06-01T05:00:00.000Z", "taken_on_time"), // 07:00 Berlin
      slotRow("2026-06-02T05:00:00.000Z", "missed"), // 07:00 Berlin
    ];
    const groups = groupLedgerByDay(rows, "Europe/Berlin");
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-06-02", "2026-06-01"]);
    // Within 2026-06-02 the 07:00 row precedes the 19:00 row.
    expect(groups[0].rows.map((r) => r.at)).toEqual([
      "2026-06-02T05:00:00.000Z",
      "2026-06-02T17:00:00.000Z",
    ]);
  });

  it("keeps a late-evening dose on its own local day, not the next UTC day", () => {
    // 23:30 Berlin on 2026-06-01 is 21:30 UTC the same day.
    const rows: LedgerRow[] = [
      slotRow("2026-06-01T21:30:00.000Z", "taken_late"),
    ];
    const groups = groupLedgerByDay(rows, "Europe/Berlin");
    expect(groups[0].dayKey).toBe("2026-06-01");
  });
});

describe("isSlotActionable", () => {
  it("is true only for unfilled slot rows (upcoming / missed)", () => {
    expect(isSlotActionable(slotRow("x", "upcoming"))).toBe(true);
    expect(isSlotActionable(slotRow("x", "missed"))).toBe(true);
    expect(isSlotActionable(slotRow("x", "taken_on_time"))).toBe(false);
    expect(isSlotActionable(slotRow("x", "skipped"))).toBe(false);
    expect(
      isSlotActionable({
        kind: "ad_hoc",
        at: "x",
        timeOfDay: null,
        status: "ad_hoc",
        intake: null,
      }),
    ).toBe(false);
  });
});

// v1.15.20 — the signed offset on the ad-hoc "fällig gewesen" subline.
describe("formatSlotDelta", () => {
  const slot = "2026-06-01T05:00:00.000Z";

  it("renders a take after the slot with a plus sign in minutes", () => {
    expect(formatSlotDelta("2026-06-01T05:45:00.000Z", slot)).toBe("+45 min");
  });

  it("renders a take before the slot with a minus sign", () => {
    expect(formatSlotDelta("2026-06-01T04:30:00.000Z", slot)).toBe("-30 min");
  });

  it("renders whole hours without a minutes part", () => {
    expect(formatSlotDelta("2026-06-01T07:00:00.000Z", slot)).toBe("+2 h");
  });

  it("renders mixed hours + minutes", () => {
    expect(formatSlotDelta("2026-06-01T06:20:00.000Z", slot)).toBe(
      "+1 h 20 min",
    );
  });

  it("collapses a sub-minute delta to +0 min", () => {
    expect(formatSlotDelta("2026-06-01T05:00:20.000Z", slot)).toBe("+0 min");
  });
});

describe("applyOptimisticSlotMark", () => {
  const payload: LedgerPayload = {
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-02T00:00:00.000Z",
    family: "daily",
    hasExpectedSlots: true,
    rows: [
      slotRow("2026-06-01T05:00:00.000Z", "missed"),
      slotRow("2026-06-01T17:00:00.000Z", "upcoming"),
    ],
  };

  it("flips the matched missed slot to taken_late at the time it is reported, bumping the rate instantly", () => {
    expect(complianceFromLedger(payload.rows).rate).toBe(0); // 0 taken / 1 missed
    const next = applyOptimisticSlotMark(
      payload,
      "2026-06-01T05:00:00.000Z",
      "taken",
      "2026-06-03T18:00:00.000Z",
    );
    const marked = next.rows.find((r) => r.at === "2026-06-01T05:00:00.000Z")!;
    // Never flattered to on time: the take is reported now, late.
    expect(marked.status).toBe("taken_late");
    expect(marked.intake?.takenAt).toBe("2026-06-03T18:00:00.000Z");
    expect(marked.intake?.skipped).toBe(false);
    expect(complianceFromLedger(next.rows).rate).toBe(100);
  });

  it("flips a slot to skipped without entering the denominator", () => {
    const next = applyOptimisticSlotMark(
      payload,
      "2026-06-01T05:00:00.000Z",
      "skipped",
    );
    const marked = next.rows.find((r) => r.at === "2026-06-01T05:00:00.000Z")!;
    expect(marked.status).toBe("skipped");
    expect(marked.intake?.skipped).toBe(true);
    // skip excluded → denominator drops to 0 → null rate.
    expect(complianceFromLedger(next.rows).rate).toBeNull();
  });

  it("leaves an already-filled (non-actionable) slot untouched", () => {
    const filled: LedgerPayload = {
      ...payload,
      rows: [slotRow("2026-06-01T05:00:00.000Z", "taken_late")],
    };
    const next = applyOptimisticSlotMark(
      filled,
      "2026-06-01T05:00:00.000Z",
      "skipped",
    );
    expect(next.rows[0].status).toBe("taken_late");
  });
});

describe("slotMarkRequestBody", () => {
  const row = { at: "2026-08-04T07:00:00.000Z" };

  it("names the slot and leaves the take time to the server (now), never the slot instant", () => {
    const body = slotMarkRequestBody(row, "taken");
    expect(body).toEqual({
      skipped: false,
      scheduledFor: "2026-08-04T07:00:00.000Z",
    });
  });

  it("keeps the skipped arm free of takenAt", () => {
    expect(slotMarkRequestBody(row, "skipped")).toEqual({
      skipped: true,
      scheduledFor: "2026-08-04T07:00:00.000Z",
    });
  });
});
