/**
 * A multi-hour protocol (`FREQ=DAILY;BYHOUR=7,19`, the morning-and-evening
 * blood pressure course) must be sent at both hours. The tick used to gate
 * on `notifyHour` alone and claim one send per local day, so the evening
 * slot sat due until the next morning and was never sent in the evening.
 *
 * Drives the real tick every 15 minutes across two local days in several
 * zones, with a claim ledger that behaves like the real one (a key claims
 * once), and a Prisma double whose updates land on the row the next tick
 * reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const claimed = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/notifications/reminder-dedup", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/notifications/reminder-dedup")
  >("@/lib/notifications/reminder-dedup");
  return {
    ...actual,
    claimNotificationEvent: vi.fn(
      async (_prisma: unknown, args: { dedupKey: string }) => {
        if (claimed.has(args.dedupKey)) return false;
        claimed.add(args.dedupKey);
        return true;
      },
    ),
  };
});

import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { computeReminderNextDueAt } from "@/lib/measurement-reminders/scheduling";

import { runMeasurementReminderTick } from "../measurement-reminder";

const ZONES = [
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Pacific/Auckland",
] as const;

beforeEach(() => {
  claimed.clear();
});

function at(tz: string, day: number, hour: number, minute = 0): Date {
  return zonedWallClockToUtc({ year: 2026, month: 9, day, hour, minute }, tz);
}

describe.each(ZONES)("BYHOUR=7,19 in %s", (tz) => {
  it("sends at 07:00 and at 19:00 on each day", async () => {
    const base = {
      intervalDays: null,
      rrule: "FREQ=DAILY;BYHOUR=7,19",
      anchorDate: at(tz, 14, 0),
      notifyHour: 7,
      lastSatisfiedAt: null,
      createdAt: at(tz, 13, 12),
    };
    const row: Record<string, unknown> = {
      id: "r-bp",
      userId: "u1",
      origin: "COACH",
      measurementType: null,
      label: "BP",
      location: null,
      lastSkippedAt: null,
      lastNotifiedAt: null,
      enabled: true,
      endsOn: null,
      ...base,
      nextDueAt: computeReminderNextDueAt(base, tz, at(tz, 14, 0)),
      user: { id: "u1", timezone: tz, locale: "en" },
    };
    const prisma = {
      measurementReminder: {
        findMany: vi.fn(async () =>
          (row.nextDueAt as Date | null) === null ? [] : [row],
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      measurement: { findFirst: vi.fn(async () => null) },
      labResult: { findFirst: vi.fn(async () => null) },
    };
    const sent: string[] = [];
    const dispatch = vi.fn(async () => ({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    }));

    for (
      let t = at(tz, 14, 0).getTime();
      t < at(tz, 16, 0).getTime();
      t += 15 * 60_000
    ) {
      const now = new Date(t);
      const before = dispatch.mock.calls.length;
      await runMeasurementReminderTick(prisma as never, now, {
        dispatch: dispatch as never,
        isModuleEnabled: async () => true,
      });
      if (dispatch.mock.calls.length > before) {
        const p = wallClockInTz(now, tz);
        sent.push(
          `${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
        );
      }
    }

    expect(sent).toEqual(["14 07:00", "14 19:00", "15 07:00", "15 19:00"]);
  });

  it("stops after the last slot of a course window and leaves the row for the cleanup", async () => {
    const endsOn = at(tz, 15, 12);
    const base = {
      intervalDays: null,
      rrule: "FREQ=DAILY;BYHOUR=7,19",
      anchorDate: at(tz, 14, 0),
      notifyHour: 7,
      lastSatisfiedAt: null,
      createdAt: at(tz, 13, 12),
      endsOn,
    };
    const row: Record<string, unknown> = {
      id: "r-bp-course",
      userId: "u1",
      origin: "COACH",
      measurementType: null,
      label: "BP",
      location: null,
      lastSkippedAt: null,
      lastNotifiedAt: null,
      enabled: true,
      deletedAt: null,
      ...base,
      nextDueAt: computeReminderNextDueAt(base, tz, at(tz, 14, 0)),
      user: { id: "u1", timezone: tz, locale: "en" },
    };
    const prisma = {
      measurementReminder: {
        findMany: vi.fn(async () =>
          (row.nextDueAt as Date | null) === null ? [] : [row],
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      measurement: { findFirst: vi.fn(async () => null) },
      labResult: { findFirst: vi.fn(async () => null) },
    };
    const sent: string[] = [];
    const dispatch = vi.fn(async () => ({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    }));

    let last = at(tz, 14, 0);
    for (
      let t = at(tz, 14, 0).getTime();
      t < at(tz, 18, 0).getTime();
      t += 15 * 60_000
    ) {
      const now = new Date(t);
      last = now;
      const before = dispatch.mock.calls.length;
      await runMeasurementReminderTick(prisma as never, now, {
        dispatch: dispatch as never,
        isModuleEnabled: async () => true,
      });
      if (dispatch.mock.calls.length > before) {
        const p = wallClockInTz(now, tz);
        sent.push(
          `${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
        );
      }
    }

    expect(sent).toEqual(["14 07:00", "14 19:00", "15 07:00", "15 19:00"]);
    // The course rolled off its end: no next slot, which is exactly the
    // shape the expired-course cleanup tombstones on the following tick.
    expect(row.nextDueAt).toBeNull();
    expect((row.endsOn as Date).getTime()).toBeLessThan(last.getTime());
    const cleanup = prisma.measurementReminder.updateMany.mock.calls.find(
      (call: unknown[]) => JSON.stringify(call[0]).includes('"origin":"COACH"'),
    );
    expect(cleanup).toBeDefined();
  });
});
