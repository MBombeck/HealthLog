/**
 * Issue #664 — the reminder worker must carry one exact scheduled occurrence
 * through recurrence, persisted intake lookup, dispatch metadata, and the
 * durable push-attempt dedup ledger when its window crosses local midnight.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }),
}));

const { dispatchNotification } = await import("@/lib/notifications/dispatcher");
const { handleReminderCheck } =
  await import("@/lib/jobs/reminder/medication-reminder-check");

const USER_ID = "cross-midnight-reminder-user";
const TZ = "Europe/Berlin";
const PRIOR_OCCURRENCE = new Date("2026-07-28T21:45:00.000Z"); // 23:45 CEST

async function seedMedication(): Promise<string> {
  const prisma = getPrismaClient();
  const medication = await prisma.medication.create({
    data: {
      userId: USER_ID,
      name: "Cross-midnight tablet",
      dose: "1 tablet",
      active: true,
      asNeeded: false,
      notificationsEnabled: true,
      startsOn: new Date("2026-07-01T00:00:00.000Z"),
      // Existed before the doses it is reminded of: a dose whose time had
      // passed when a medication was created is never owed.
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      schedules: {
        create: {
          windowStart: "23:45",
          windowEnd: "00:30",
          timesOfDay: ["23:45"],
          rrule: "FREQ=DAILY",
          scheduleType: "SCHEDULED",
        },
      },
    },
    select: { id: true },
  });
  return medication.id;
}

async function tickAt(instant: string): Promise<void> {
  vi.setSystemTime(new Date(instant));
  await handleReminderCheck([]);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(dispatchNotification).mockClear();
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "cross-midnight-reminder",
      email: "cross-midnight-reminder@example.test",
      timezone: TZ,
      locale: "en",
    },
  });
});

describe("medication reminder cross-midnight persistence", () => {
  it("suppresses an exact taken occurrence after midnight without suppressing the next dose", async () => {
    const prisma = getPrismaClient();
    const medicationId = await seedMedication();
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: USER_ID,
        medicationId,
        scheduledFor: PRIOR_OCCURRENCE,
        takenAt: new Date("2026-07-28T21:50:00.000Z"),
        skipped: false,
        source: "WEB",
      },
    });

    await tickAt("2026-07-28T22:15:00.000Z"); // Jul 29 00:15 CEST
    expect(dispatchNotification).not.toHaveBeenCalled();

    await tickAt("2026-07-29T21:50:00.000Z"); // next distinct 23:45 dose
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          medicationId,
          scheduledAt: "2026-07-29T21:45:00.000Z",
        }),
      }),
    );
  });

  it("dispatches an untaken prior-day occurrence once across worker retries", async () => {
    const prisma = getPrismaClient();
    const medicationId = await seedMedication();

    await tickAt("2026-07-28T22:15:00.000Z");
    await tickAt("2026-07-28T22:30:00.000Z");

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          medicationId,
          scheduledAt: PRIOR_OCCURRENCE.toISOString(),
        }),
      }),
    );

    // The anchor is a record-scoped scheduler event, not a delivery attempt.
    // It used to be a `push_attempts` row on a synthetic `DEDUP` channel; the
    // separation moved it to `notification_events` and nothing writes that
    // channel any more, so a query for it matched no rows and passed on an
    // empty set whatever the tick did. Read the ledger the claim actually
    // appends to, and pin the count, so a second dispatch shows up as a
    // second row rather than as silence.
    const anchors = await prisma.notificationEvent.findMany({
      where: {
        recordUserId: USER_ID,
        eventType: "MEDICATION_REMINDER",
      },
      select: { dedupKey: true },
    });
    expect(anchors).toEqual([
      {
        dedupKey: expect.stringContaining("23:45:YELLOW:2026-07-28"),
      },
    ]);
  });
});
