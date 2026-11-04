/**
 * v1.34.1 (#664) — one persisted rolling occurrence must have
 * one identity across every medication consumer.
 *
 * This is intentionally a RED contract for the diagnosed Mounjaro defect:
 * the weekly occurrence anchored on 2026-07-28 remains actionable after the
 * user's local day changes.  The list and Dashboard are the authoritative
 * server reads; the GLP-1 card and take-all derivations consume the list
 * payload exactly as production does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";
import {
  deriveDueMedications,
  type DueDerivationMedication,
} from "@/components/medications/take-all-due";
import { buildMedsTodayBlock } from "@/lib/dashboard/meds-today";
import { buildMedicationsList } from "@/lib/medications/list-read";
import { applyCanonicalSlotWrite } from "@/lib/medications/scheduling/slot-upsert";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-rolling-overdue-consumers";
const USER_TZ = "Europe/Berlin";
const NOW = new Date("2026-07-29T10:00:00.000Z");
const LAST_TAKEN = new Date("2026-07-21T06:00:00.000Z");
const OVERDUE_OCCURRENCE = new Date("2026-07-28T06:00:00.000Z");
const NEXT_OCCURRENCE = new Date("2026-08-04T06:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "rolling-overdue-consumers",
      email: "rolling-overdue-consumers@example.test",
      timezone: USER_TZ,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function createMounjaro(): Promise<string> {
  const prisma = getPrismaClient();
  const medication = await prisma.medication.create({
    data: {
      userId: USER_ID,
      name: "Mounjaro",
      dose: "5mg",
      active: true,
      treatmentClass: "GLP1",
      deliveryForm: "INJECTION",
      startsOn: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
          daysOfWeek: null,
          rrule: null,
          rollingIntervalDays: 7,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: USER_ID,
      medicationId: medication.id,
      scheduledFor: LAST_TAKEN,
      takenAt: LAST_TAKEN,
      skipped: false,
      source: "WEB",
    },
  });
  return medication.id;
}

async function readConsumerOccurrence(
  medicationId: string,
  complianceStatus: "overdue" | "upcoming" = "overdue",
) {
  const prisma = getPrismaClient();
  const list = await buildMedicationsList(USER_ID, USER_TZ);
  const raw = list.find((row) => row.id === medicationId);
  expect(raw).toBeDefined();
  const medication = raw as unknown as DueDerivationMedication;
  const listOccurrence = medication.nextDueAt ?? null;

  const dashboard = await buildMedsTodayBlock(prisma, USER_ID, USER_TZ, NOW);

  // A prior-day rolling slot is outside today's clock window. The GLP-1
  // card therefore displays the server's canonical nextDueAt verbatim.
  const glp1Occurrence =
    resolveDisplayedSlotInstant({
      currentWindowStatus: {
        status: null,
        schedule: null,
        window: null,
      },
      nextDueAt: listOccurrence,
      now: NOW,
      timeZone: USER_TZ,
    })?.toISOString() ?? null;

  const takeAll = deriveDueMedications([medication], {
    now: NOW,
    tz: USER_TZ,
    // Mirrors the compliance row that keeps the card action enabled for an
    // unresolved weekly dose after its same-day window has passed.
    doseStatusById: new Map([[medicationId, complianceStatus]]),
  });

  return {
    list: {
      occurrence: listOccurrence,
      overdue: medication.nextDueOverdue === true,
    },
    dashboard: {
      occurrence:
        dashboard.dueCandidates?.find(
          (candidate) => candidate.medicationId === medicationId,
        )?.dueAt ?? null,
      overdue:
        dashboard.dueCandidates?.find(
          (candidate) => candidate.medicationId === medicationId,
        )?.overdue ?? false,
    },
    glp1Card: glp1Occurrence,
    takeAllDue:
      takeAll
        .find((entry) => entry.id === medicationId)
        ?.scheduledFor?.toISOString() ?? null,
  };
}

describe("rolling weekly overdue occurrence — shared consumers", () => {
  it("keeps the prior-day occurrence authoritative in list, Dashboard, GLP-1, and take-all", async () => {
    const medicationId = await createMounjaro();

    await expect(readConsumerOccurrence(medicationId)).resolves.toEqual({
      list: {
        occurrence: OVERDUE_OCCURRENCE.toISOString(),
        overdue: true,
      },
      dashboard: {
        occurrence: OVERDUE_OCCURRENCE.toISOString(),
        overdue: true,
      },
      glp1Card: OVERDUE_OCCURRENCE.toISOString(),
      takeAllDue: OVERDUE_OCCURRENCE.toISOString(),
    });
  });

  it.each(["taken", "skipped", "autoMissed"] as const)(
    "an exact %s action suppresses the overdue occurrence everywhere and advances",
    async (status) => {
      const prisma = getPrismaClient();
      const medicationId = await createMounjaro();
      await prisma.medicationIntakeEvent.create({
        data: {
          userId: USER_ID,
          medicationId,
          scheduledFor: OVERDUE_OCCURRENCE,
          takenAt:
            status === "taken" ? new Date("2026-07-28T06:10:00.000Z") : null,
          skipped: status === "skipped",
          autoMissed: status === "autoMissed",
          source: "WEB",
        },
      });

      const state = await readConsumerOccurrence(medicationId, "upcoming");
      expect(state.list).toEqual({
        occurrence: NEXT_OCCURRENCE.toISOString(),
        overdue: false,
      });
      expect(state.dashboard).toEqual({
        occurrence: NEXT_OCCURRENCE.toISOString(),
        overdue: false,
      });
      expect(state.glp1Card).toBe(NEXT_OCCURRENCE.toISOString());
      expect(state.takeAllDue).toBeNull();
    },
  );

  it("concurrent and retried writes converge onto one live exact-occurrence row", async () => {
    const prisma = getPrismaClient();
    const medicationId = await createMounjaro();
    const write = (idempotencyKey: string) =>
      applyCanonicalSlotWrite({
        client: prisma,
        userId: USER_ID,
        medicationId,
        canonicalSlot: OVERDUE_OCCURRENCE,
        takenAt: new Date("2026-07-29T10:01:00.000Z"),
        skipped: false,
        isExplicitTaken: true,
        isExplicitSkip: false,
        idempotencyKey,
        createSource: "WEB",
      });

    const results = await Promise.all([
      write("rolling-concurrent-a"),
      write("rolling-concurrent-b"),
    ]);
    await write("rolling-concurrent-retry");

    expect(results).toHaveLength(2);
    const rows = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: USER_ID,
        medicationId,
        scheduledFor: OVERDUE_OCCURRENCE,
        deletedAt: null,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.takenAt).not.toBeNull();
  });

  it("different occurrence, archived row, and sibling medication never block the exact write", async () => {
    const prisma = getPrismaClient();
    const medicationId = await createMounjaro();
    const siblingId = await createMounjaro();

    await prisma.medicationIntakeEvent.createMany({
      data: [
        {
          userId: USER_ID,
          medicationId,
          scheduledFor: new Date("2026-07-27T06:00:00.000Z"),
          takenAt: new Date("2026-07-27T06:05:00.000Z"),
          skipped: false,
          source: "WEB",
        },
        {
          userId: USER_ID,
          medicationId,
          scheduledFor: OVERDUE_OCCURRENCE,
          takenAt: new Date("2026-07-27T06:05:00.000Z"),
          skipped: false,
          source: "REMINDER",
          deletedAt: new Date("2026-07-27T12:00:00.000Z"),
        },
        {
          userId: USER_ID,
          medicationId: siblingId,
          scheduledFor: OVERDUE_OCCURRENCE,
          takenAt: new Date("2026-07-28T06:05:00.000Z"),
          skipped: false,
          source: "WEB",
        },
      ],
    });

    const result = await applyCanonicalSlotWrite({
      client: prisma,
      userId: USER_ID,
      medicationId,
      canonicalSlot: OVERDUE_OCCURRENCE,
      takenAt: new Date("2026-07-29T10:02:00.000Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: "rolling-isolation-target",
      createSource: "WEB",
    });

    expect(result.outcome).toBe("inserted");
    expect(result.row.scheduledFor).toEqual(OVERDUE_OCCURRENCE);
    expect(
      await prisma.medicationIntakeEvent.count({
        where: {
          userId: USER_ID,
          medicationId,
          scheduledFor: OVERDUE_OCCURRENCE,
          deletedAt: null,
        },
      }),
    ).toBe(1);
  });
});
