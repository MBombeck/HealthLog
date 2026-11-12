/**
 * v1.16.11 — medication low-stock engine: runway-threshold boundary,
 * once-per-crossing dedupe, re-arm on refill / threshold change, the
 * OFF state, and the schedule-less (no runway derivable) case. Pure
 * helpers are pinned without a DB; the tick runs against a prisma
 * mock. Fixtures use relative PAST instants only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));

import type { PrismaClient } from "@/generated/prisma/client";
import { isModuleEnabled } from "@/lib/modules/gate";
import {
  buildLowStockPayload,
  decideLowStockAction,
  evaluateMedicationRunway,
  runMedicationLowStockTick,
} from "../medication-low-stock";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const now = new Date(Date.now() - 60_000);
const daysAgo = (n: number) => new Date(now.getTime() - n * MS_PER_DAY);

/** One dose per day — `timesOfDay` carries a single entry. */
const dailySchedule = {
  windowStart: "08:00",
  daysOfWeek: null,
  timesOfDay: ["08:00"],
  rrule: null,
  rollingIntervalDays: null,
};

/** Weekly GLP-1 cadence — the special case rides the general math. */
const weeklySchedule = {
  windowStart: "08:00",
  daysOfWeek: "6",
  timesOfDay: ["08:00"],
  rrule: null,
  rollingIntervalDays: null,
};

function item(unitsRemaining: number, state = "ACTIVE" as const) {
  return { state, unitsTotal: 30, unitsRemaining };
}

describe("evaluateMedicationRunway", () => {
  it("derives the runway from available units ÷ daily consumption", () => {
    const out = evaluateMedicationRunway([item(6)], 1, [dailySchedule]);
    expect(out).toEqual({
      runwayDays: 6,
      dosesRemaining: 6,
      unitsRemaining: 6,
      expiredUnits: 0,
      asNeeded: false,
    });
  });

  it("treats a weekly GLP-1 cadence through the same math (4 doses ≈ 28 days)", () => {
    const out = evaluateMedicationRunway([item(4)], 1, [weeklySchedule]);
    expect(out.runwayDays).toBe(28);
  });

  it("honours unitsPerDose and pools only available containers", () => {
    // 2 units per dose, 4 usable + 10 expired units → 2 doses.
    const out = evaluateMedicationRunway(
      [item(4), { state: "EXPIRED", unitsTotal: 30, unitsRemaining: 10 }],
      2,
      [dailySchedule],
    );
    expect(out.dosesRemaining).toBe(2);
    expect(out.runwayDays).toBe(2);
    // Written-off stock is surfaced alongside, never folded into supply.
    expect(out.expiredUnits).toBe(10);
  });

  it("returns runway 0 for an exhausted supply with a consuming schedule", () => {
    const out = evaluateMedicationRunway([item(0)], 1, [dailySchedule]);
    expect(out.runwayDays).toBe(0);
  });

  it("derives NO runway for a schedule-less medication", () => {
    const out = evaluateMedicationRunway(
      [item(2), { state: "EXPIRED", unitsTotal: 30, unitsRemaining: 7 }],
      1,
      [],
    );
    expect(out.runwayDays).toBe(null);
    // The no-runway arm still reports the written-off stock.
    expect(out.expiredUnits).toBe(7);
  });
});

describe("decideLowStockAction — boundary / dedupe / re-arm", () => {
  const armed = { notifiedAt: null, notifiedThresholdDays: null };

  it("notifies just below the trigger", () => {
    expect(
      decideLowStockAction({ runwayDays: 6, triggerDays: 7, ...armed }),
    ).toBe("notify");
  });

  it("notifies AT the trigger (v1.17.0 ≤ boundary — lands before the last dose)", () => {
    expect(
      decideLowStockAction({ runwayDays: 7, triggerDays: 7, ...armed }),
    ).toBe("notify");
  });

  it("stays silent above the trigger", () => {
    expect(
      decideLowStockAction({ runwayDays: 8, triggerDays: 7, ...armed }),
    ).toBe("skip_above_threshold");
  });

  it("does not repeat while still low (stamped crossing)", () => {
    expect(
      decideLowStockAction({
        runwayDays: 5,
        triggerDays: 7,
        notifiedAt: daysAgo(1),
        notifiedThresholdDays: 7,
      }),
    ).toBe("skip_already_notified");
  });

  it("re-arms when the runway rises back above the trigger (refill)", () => {
    expect(
      decideLowStockAction({
        runwayDays: 30,
        triggerDays: 7,
        notifiedAt: daysAgo(2),
        notifiedThresholdDays: 7,
      }),
    ).toBe("rearm");
  });

  it("a changed trigger (threshold OR lead) re-arms even while the runway stays low", () => {
    expect(
      decideLowStockAction({
        runwayDays: 10,
        triggerDays: 14,
        notifiedAt: daysAgo(3),
        notifiedThresholdDays: 7,
      }),
    ).toBe("notify");
  });

  it("never notifies when no runway is derivable", () => {
    expect(
      decideLowStockAction({ runwayDays: null, triggerDays: 7, ...armed }),
    ).toBe("skip_no_runway");
  });
});

const payloadArgs = (
  over: Partial<Parameters<typeof buildLowStockPayload>[0]>,
) =>
  buildLowStockPayload({
    locale: "en",
    medName: "Metformin",
    runwayDays: 5,
    unitsRemaining: 10,
    expiredUnits: 0,
    leadDays: 0,
    triggerDays: 7,
    schedules: [dailySchedule],
    today: new Date(Date.UTC(2026, 5, 1)),
    ...over,
  });

describe("buildLowStockPayload", () => {
  it("names the medication and reorder dates when supply is datable (en)", () => {
    const out = payloadArgs({ runwayDays: 5, leadDays: 3, triggerDays: 9 });
    expect(out.title).toContain("Metformin");
    expect(out.body).toContain("Metformin");
    // runsOutOn = 1 Jun + 5 = 6 Jun; reorderBy = 6 Jun − 3 = 3 Jun.
    // The "en" bundle resolves to the en-US date style ("Jun 6, 2026").
    expect(out.body).toContain("Jun 6, 2026");
    expect(out.body).toContain("Jun 3, 2026");
  });

  it("uses the du-Form German copy", () => {
    const out = payloadArgs({ locale: "de", leadDays: 3, triggerDays: 9 });
    expect(out.body).toContain("Dein Vorrat an Metformin");
  });

  it("switches to the depleted line at runway 0", () => {
    const out = payloadArgs({ runwayDays: 0, unitsRemaining: 1 });
    expect(out.body).toContain("less than one day");
  });

  it("names the written-off stock when nothing usable is left but expired units are", () => {
    // "0 units left" and "everything you have left is written off" are
    // different errands; the second must not read as the first.
    const out = payloadArgs({
      runwayDays: 0,
      unitsRemaining: 0,
      expiredUnits: 54,
    });
    expect(out.body).toContain("no usable supply left");
    expect(out.body).toContain("54 units are marked expired");
    expect(out.body).not.toContain("less than one day");
  });

  it("keeps the depleted line when nothing expired either", () => {
    const out = payloadArgs({
      runwayDays: 0,
      unitsRemaining: 0,
      expiredUnits: 0,
    });
    expect(out.body).toContain("less than one day");
  });

  it("renders the last-dose line when the runway is one cadence interval", () => {
    // Weekly cadence, runway 7 ≈ one dose-interval → last-dose state.
    const out = payloadArgs({
      runwayDays: 7,
      leadDays: 10,
      triggerDays: 17,
      schedules: [weeklySchedule],
    });
    expect(out.body).toContain("final dose");
  });

  it("falls back to the app default locale for unknown locales", () => {
    const out = payloadArgs({ locale: "xx" });
    expect(out.title).toBe("Low supply: Metformin");
  });
});

describe("runMedicationLowStockTick", () => {
  function medRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "med-1",
      name: "Metformin",
      unitsPerDose: 1,
      // v1.17.0 — daily fixtures pin lead 0 so the effective trigger stays
      // the bare 7-day floor (max(7, 0 + 1 dose-interval) = 7); a daily med
      // with no reorder lead is UNCHANGED from the pre-v1.17.0 behaviour.
      // The weekly + lead scenarios opt into a non-zero lead explicitly.
      reorderLeadDays: 0,
      lowStockNotifiedAt: null,
      lowStockNotifiedThresholdDays: null,
      inventoryItems: [item(5)],
      schedules: [dailySchedule],
      ...overrides,
    };
  }

  function prismaMock(overrides: {
    users?: unknown[];
    medications?: unknown[];
  }) {
    return {
      user: {
        findMany: vi.fn(async () => overrides.users ?? []),
      },
      medication: {
        findMany: vi.fn(async () => overrides.medications ?? []),
        update: vi.fn(async () => ({})),
      },
    };
  }

  const userRow = (notificationPrefs: unknown = null) => ({
    id: "user-1",
    locale: "en",
    notificationPrefs,
  });

  const okDispatch = () =>
    vi.fn<
      (payload: unknown) => Promise<{
        dispatched: boolean;
        channelsAttempted: number;
        channelsSucceeded: number;
      }>
    >(async () => ({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isModuleEnabled).mockResolvedValue(true);
  });

  it("notifies a below-threshold medication and stamps the crossing", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "MEDICATION_LOW_STOCK",
        userId: "user-1",
        metadata: expect.objectContaining({
          medicationId: "med-1",
          runwayDays: 5,
          thresholdDays: 7,
          unitsRemaining: 5,
          // Deep link lands on the detail page's Bestand (supply) tab.
          url: "/medications/med-1?tab=supply",
        }),
      }),
    );
    expect(prisma.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: {
        lowStockNotifiedAt: now,
        lowStockNotifiedThresholdDays: 7,
      },
    });
  });

  it("does not repeat while still low (stamp present for this threshold)", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [
        medRow({
          lowStockNotifiedAt: daysAgo(1),
          lowStockNotifiedThresholdDays: 7,
        }),
      ],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedAlreadyNotified).toBe(1);
    expect(summary.notified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("re-arms after a refill, then notifies again on the next crossing", async () => {
    const dispatch = okDispatch();
    const stamped = {
      lowStockNotifiedAt: daysAgo(2),
      lowStockNotifiedThresholdDays: 7,
    };
    // Tick 1 — refilled (30 units, runway 30 ≥ 7): the stamp clears.
    const prismaRefilled = prismaMock({
      users: [userRow()],
      medications: [medRow({ ...stamped, inventoryItems: [item(30)] })],
    });
    const refillSummary = await runMedicationLowStockTick(
      prismaRefilled as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(refillSummary.rearmed).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prismaRefilled.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: { lowStockNotifiedAt: null, lowStockNotifiedThresholdDays: null },
    });

    // Tick 2 — consumed back below the threshold with a cleared stamp:
    // the next crossing notifies again.
    const prismaLow = prismaMock({
      users: [userRow()],
      medications: [medRow({ inventoryItems: [item(3)] })],
    });
    const lowSummary = await runMedicationLowStockTick(
      prismaLow as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(lowSummary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("a changed threshold re-arms a still-low stamped medication", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow({ medication: { lowStockRunwayDays: 14 } })],
      medications: [
        medRow({
          inventoryItems: [item(10)],
          lowStockNotifiedAt: daysAgo(3),
          lowStockNotifiedThresholdDays: 7,
        }),
      ],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ thresholdDays: 14 }),
      }),
    );
  });

  it("threshold OFF (null) skips the user without reading medications", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow({ medication: { lowStockRunwayDays: null } })],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedThresholdOff).toBe(1);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the Medications module switched off skips the user without reading medications", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(isModuleEnabled).toHaveBeenCalledWith("user-1", "medications");
    expect(summary.skippedModuleDisabled).toBe(1);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("skips a medication whose course has ended, keeps one not yet started", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [{ ...userRow(), timezone: "Europe/Berlin" }],
      medications: [
        medRow({ id: "med-ended", endsOn: daysAgo(3), startsOn: daysAgo(13) }),
        medRow({ id: "med-ended-today", endsOn: now, endedAt: daysAgo(0.01) }),
        medRow({
          id: "med-upcoming",
          startsOn: new Date(now.getTime() + 3 * MS_PER_DAY),
        }),
      ],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedCourseEnded).toBe(2);
    expect(summary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ medicationId: "med-upcoming" }),
      }),
    );
  });

  it("a schedule-less medication never notifies (no runway derivable)", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow({ schedules: [], inventoryItems: [item(1)] })],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedNoRunway).toBe(1);
    expect(summary.notified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("an as-needed medication warns once when two doses or fewer are left", async () => {
    const prn = { ...dailySchedule, scheduleType: "PRN" };
    const dispatch = okDispatch();

    // Three doses left: no cadence, so no runway, and above the dose floor.
    const above = prismaMock({
      users: [userRow()],
      medications: [medRow({ schedules: [prn], inventoryItems: [item(3)] })],
    });
    const quiet = await runMedicationLowStockTick(
      above as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(quiet.skippedAboveThreshold).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();

    // Two left: warns, names what is left, and stamps the dose floor.
    const low = prismaMock({
      users: [userRow()],
      medications: [medRow({ schedules: [prn], inventoryItems: [item(2)] })],
    });
    const summary = await runMedicationLowStockTick(
      low as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(summary.notified).toBe(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
      metadata: Record<string, unknown>;
    };
    expect(payload.message).toBe(
      "Metformin: only 2 units left. Reorder before you need the next dose.",
    );
    expect(payload.metadata).toMatchObject({
      runwayDays: null,
      triggerDays: null,
      asNeeded: true,
      dosesRemaining: 2,
    });
    expect(low.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: { lowStockNotifiedAt: now, lowStockNotifiedThresholdDays: 2 },
    });

    // Still two left the next day: no repeat.
    const again = prismaMock({
      users: [userRow()],
      medications: [
        medRow({
          schedules: [prn],
          inventoryItems: [item(1)],
          lowStockNotifiedAt: daysAgo(1),
          lowStockNotifiedThresholdDays: 2,
        }),
      ],
    });
    const repeat = await runMedicationLowStockTick(
      again as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(repeat.skippedAlreadyNotified).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("an exhausted supply (runway 0) notifies with the depleted copy", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow({ inventoryItems: [item(0)] })],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
    };
    expect(payload.message).toContain("less than one day");
  });

  it("leaves the stamp clear when no channel succeeded (retry tomorrow)", async () => {
    const dispatch = vi.fn<
      (payload: unknown) => Promise<{
        dispatched: boolean;
        channelsAttempted: number;
        channelsSucceeded: number;
      }>
    >(async () => ({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    }));
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedNoChannel).toBe(1);
    expect(summary.notified).toBe(0);
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("a daily med with no reorder lead is UNCHANGED (trigger stays the 7-day floor)", async () => {
    const dispatch = okDispatch();
    // Runway 8 (8 daily doses) sits above the bare floor of 7; with lead 0
    // and a 1-day cadence the trigger is max(7, 0 + 1) = 7, so 8 > 7 stays
    // silent — exactly the pre-v1.17.0 boundary.
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow({ inventoryItems: [item(8)], reorderLeadDays: 0 })],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedAboveThreshold).toBe(1);
    expect(summary.notified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a WEEKLY med with one dose left now fires with reorder headroom (the maintainer's scenario)", async () => {
    const dispatch = okDispatch();
    // One weekly dose left ≈ 7 days of runway. Under the old strict-below
    // 7-day floor this fired only AT the last dose; with the default lead
    // (10) the trigger is max(7, 10 + 7) = 17, so runway 7 ≤ 17 fires with
    // ~10 days of reorder headroom before the supply runs out.
    const prisma = prismaMock({
      users: [userRow()],
      medications: [
        medRow({
          schedules: [weeklySchedule],
          inventoryItems: [item(1)],
          reorderLeadDays: null, // inherit the user-level default (10)
        }),
      ],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          runwayDays: 7,
          triggerDays: 17,
          leadDays: 10,
        }),
      }),
    );
    // The stamp records the EFFECTIVE trigger, not the bare floor.
    expect(prisma.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: { lowStockNotifiedAt: now, lowStockNotifiedThresholdDays: 17 },
    });
  });

  it("a per-med reorder-lead override beats the user-level default", async () => {
    const dispatch = okDispatch();
    // User default lead 10; this med overrides it with 0. Daily cadence →
    // trigger max(7, 0 + 1) = 7. Runway 9 (9 daily doses) > 7 stays silent,
    // proving the per-med 0 override displaced the user's 10 (which would
    // have given trigger 11 and fired).
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow({ inventoryItems: [item(9)], reorderLeadDays: 0 })],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedAboveThreshold).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
