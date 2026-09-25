/**
 * The compliance heatmap counts a day's ledger rows. An off-schedule row
 * (one that matched no slot) is a real dose only when it carries a taken
 * time; an orphaned skip or auto-miss on an instant that is no slot of the
 * schedule records no dose and must never colour the day as taken.
 */
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { medicationIntakeEvent: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { buildCompliancePayload } from "@/lib/medications/compliance-payload";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/format";

const TZ = "Europe/Berlin";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("counts an off-schedule row as taken only when it has a taken time", async () => {
  const day = new Date("2026-06-10T12:00:00Z");
  const at = (h: number, m = 0) => localHmAsUtc(day, TZ, h, m);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(23, 0));

  const row = (
    scheduledFor: Date,
    takenAt: Date | null,
    flags: { skipped?: boolean; autoMissed?: boolean } = {},
  ) => ({
    scheduledFor,
    takenAt,
    skipped: flags.skipped ?? false,
    autoMissed: flags.autoMissed ?? false,
    attributionSource: "AUTO",
  });
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
    // The 08:00 slot, taken on time.
    row(at(8), at(8)),
    // A real off-schedule take in the afternoon.
    row(at(15), at(15)),
    // Orphans on instants that are no slot of the schedule.
    row(at(11), null, { skipped: true }),
    row(at(12), null, { autoMissed: true }),
  ] as never);

  const payload = await buildCompliancePayload(
    {
      id: "med-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      startsOn: null,
      endsOn: null,
      oneShot: false,
      asNeeded: false,
      trackIntake: true,
      schedules: [
        {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
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
    TZ,
  );

  expect(payload.dailyCompliance[userDayKey(at(12), TZ)]).toMatchObject({
    // The slot, the real off-schedule take and the orphaned skip.
    expected: 3,
    taken: 2,
    onTime: 2,
    skipped: 1,
  });
});
