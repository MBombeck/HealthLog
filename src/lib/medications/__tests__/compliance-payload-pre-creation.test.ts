/**
 * #1028 — the compliance payload (the detail page's rates and heatmap)
 * over a medication added mid-day. The creation day's 14:00 dose was
 * recorded afterwards on its own slot; the 09:00 slot before the medication
 * existed only ever held the projector's auto-missed placeholder. The
 * payload must read the same day the dose-history view does: two slots, both
 * taken on time, nothing missed.
 */
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { medicationIntakeEvent: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { buildCompliancePayload } from "@/lib/medications/compliance-payload";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/format";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

for (const tz of ["Asia/Kolkata", "America/New_York"]) {
  it(`reads the creation day like the history view (${tz})`, async () => {
    const day1 = new Date("2026-09-23T12:00:00Z");
    const day2 = new Date("2026-09-24T12:00:00Z");
    const d1 = (h: number, m = 0) => localHmAsUtc(day1, tz, h, m);
    const d2 = (h: number, m = 0) => localHmAsUtc(day2, tz, h, m);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(d2(22, 0));

    const take = (slot: Date, takenAt: Date) => ({
      scheduledFor: slot,
      takenAt,
      skipped: false,
      autoMissed: false,
      attributionSource: "AUTO",
    });
    const rows = [
      take(d2(21), d2(21, 30)),
      take(d2(14), d2(14)),
      take(d2(9), d2(10)),
      take(d1(21), d1(21)),
      take(d1(14), d1(14)),
      {
        scheduledFor: d1(9),
        takenAt: null,
        skipped: false,
        autoMissed: true,
        attributionSource: "AUTO",
      },
    ];
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(
      (async (args: {
        where: { scheduledFor: { gte: Date } };
      }): Promise<unknown> =>
        rows.filter(
          (r) => r.scheduledFor >= args.where.scheduledFor.gte,
        )) as never,
    );

    const payload = await buildCompliancePayload(
      {
        id: "med-1",
        createdAt: d1(16, 5),
        startsOn: new Date("2026-09-23T00:00:00Z"),
        endsOn: new Date("2026-09-28T00:00:00Z"),
        oneShot: false,
        asNeeded: false,
        trackIntake: true,
        schedules: [
          {
            windowStart: "09:00",
            windowEnd: "09:00",
            timesOfDay: ["09:00", "14:00", "21:00"],
            daysOfWeek: null,
            rrule: null,
            rollingIntervalDays: null,
            reminderGraceMinutes: null,
            scheduleType: "SCHEDULED",
            cyclicOnWeeks: null,
            cyclicOffWeeks: null,
          },
        ],
      },
      "user-1",
      tz,
    );

    expect(payload.compliance7).toMatchObject({
      taken: 5,
      missed: 0,
      rate: 100,
    });
    expect(payload.dailyCompliance[userDayKey(d1(12), tz)]).toMatchObject({
      expected: 2,
      taken: 2,
      onTime: 2,
      skipped: 0,
    });
  });
}
