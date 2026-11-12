/**
 * Logging the next dose re-anchors a booster reminder on the dose date. The
 * dose date is a calendar date stored at UTC midnight, which is the evening
 * before west of UTC, so the next booster came due a day early there.
 */
import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { satisfyBoostersForDose } from "@/lib/vaccinations/satisfy-matching";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

const TZ = "America/New_York";

function fakeTx() {
  const updates: Array<Record<string, unknown>> = [];
  const reminder = {
    id: "reminder-1",
    userId: "u1",
    vaccinationAntigen: "tetanus",
    intervalDays: 3650,
    rrule: null,
    anchorDate: new Date("2016-03-10T05:00:00.000Z"),
    notifyHour: 9,
    nextDueAt: new Date("2026-03-07T14:00:00.000Z"),
    lastSatisfiedAt: null,
    lastSkippedAt: null,
    createdAt: new Date("2016-03-10T05:00:00.000Z"),
    endsOn: null,
  };
  const tx = {
    measurementReminder: {
      findMany: vi.fn(async () => [reminder]),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      }),
    },
    measurementReminderEvent: { create: vi.fn(async () => ({})) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, updates };
}

describe("satisfyBoostersForDose", () => {
  it("counts the next interval from the dose's own date west of UTC", async () => {
    const { tx, updates } = fakeTx();
    await satisfyBoostersForDose(
      tx,
      "u1",
      { antigenSlug: "tetanus" },
      new Date("2026-03-10T00:00:00.000Z"),
      TZ,
    );
    // Ten years of days after 10 March, on the person's calendar.
    expect(userDayKey(updates[0].nextDueAt as Date, TZ)).toBe(
      shiftDateKey("2026-03-10", 3650),
    );
    expect(updates[0].lastSatisfiedAt).toEqual(
      startOfLocalDayKey("2026-03-10", TZ),
    );
  });
});
