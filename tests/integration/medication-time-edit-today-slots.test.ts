/**
 * A dose time moved during the day: every surface that derives today's slots
 * must agree once the edit has committed. Replays a daily medication moved
 * from 21:16 to 11:30 (Berlin) at 11:26, and to 09:00, a time already past.
 *
 *   - the schedule replace tombstones today's open 21:16 row and wakes the
 *     devices once;
 *   - the reminder worker, resolved-slots, dose-history, the MCP schedule,
 *     the today list, the dashboard count and the digest then all name the
 *     new time (or, for a time already past, no slot today) and none names
 *     21:16.
 *
 * And the echo: a save that repeats the schedule is no change. The open row
 * keeps its id and sync version, no era is archived and no device is woken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  DAY_MS,
  TZ,
  readDashboardCompliance,
  readToday,
} from "./medication-dose-state-fixtures";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }),
}));

vi.mock("@/lib/notifications/medication-intake-sync", async (orig) => ({
  ...(await orig<object>()),
  queueMedicationIntakeSync: vi.fn(),
}));
vi.mock("@/lib/push-relay/data-changed", async (orig) => ({
  ...(await orig<object>()),
  noteDataChanged: vi.fn().mockResolvedValue(undefined),
}));

const { dispatchNotification } = await import("@/lib/notifications/dispatcher");
const { queueMedicationIntakeSync } =
  await import("@/lib/notifications/medication-intake-sync");
const { noteDataChanged } = await import("@/lib/push-relay/data-changed");
const { getMedicationScheduleTool } =
  await import("@/lib/mcp/tools/get-medication-schedule");
const { loadDailyDigest } = await import("@/lib/daily/load-digest");
const { handleReminderCheck } =
  await import("@/lib/jobs/reminder/medication-reminder-check");
const { caches } = await import("@/lib/cache/server-cache");

const OLD_SLOT = "2026-11-23T20:16:00.000Z"; // 21:16 Berlin
const NEW_SLOT = "2026-11-23T10:30:00.000Z"; // 11:30 Berlin
const TOMORROW_PAST_SLOT = "2026-11-24T08:00:00.000Z"; // 09:00 Berlin

type Handler = (
  r: NextRequest,
  c: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type PlainHandler = (r: NextRequest) => Promise<Response>;

const OLD_SCHEDULE = {
  windowStart: "20:46",
  windowEnd: "22:16",
  timesOfDay: ["21:16"],
  rrule: "FREQ=DAILY",
};
const PAST_SCHEDULE = {
  windowStart: "08:30",
  windowEnd: "09:30",
  timesOfDay: ["09:00"],
  rrule: "FREQ=DAILY",
};
const NEW_SCHEDULE = {
  windowStart: "11:00",
  windowEnd: "12:00",
  timesOfDay: ["11:30"],
  rrule: "FREQ=DAILY",
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T10:19:00.000Z"));
  vi.mocked(dispatchNotification).mockClear();
  vi.mocked(queueMedicationIntakeSync).mockClear();
  vi.mocked(noteDataChanged).mockClear();
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "time-edit",
      email: "time-edit@example.test",
      role: "USER",
      timezone: TZ,
      locale: "en",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  const created = new Date("2026-11-22T20:04:33.000Z");
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Test Medication C",
      dose: "1",
      active: true,
      notificationsEnabled: true,
      startsOn: created,
      createdAt: created,
      schedules: {
        create: { ...OLD_SCHEDULE, scheduleType: "SCHEDULED" },
      },
    },
  });
  return { user, med };
}

async function putSchedule(medId: string, schedule: typeof OLD_SCHEDULE) {
  const { PUT } = await import("@/app/api/medications/[id]/route");
  const res = await (PUT as unknown as Handler)(
    new NextRequest(`http://localhost/api/medications/${medId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schedules: [schedule] }),
    }),
    { params: Promise.resolve({ id: medId }) },
  );
  expect(res.status).toBe(200);
}

async function liveRowsToday(medId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: {
      medicationId: medId,
      deletedAt: null,
      scheduledFor: {
        gte: new Date("2026-11-22T23:00:00.000Z"),
        lt: new Date("2026-11-23T23:00:00.000Z"),
      },
    },
    select: { id: true, scheduledFor: true },
  });
}

async function resolvedSlotsToday(medId: string) {
  const { GET } = await import("@/app/api/medications/resolved-slots/route");
  const q = new URLSearchParams({
    from: "2026-11-22T23:00:00.000Z",
    to: "2026-11-23T22:59:59.000Z",
  });
  const res = await (GET as unknown as PlainHandler)(
    new NextRequest(`http://localhost/api/medications/resolved-slots?${q}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      medications: Array<{
        medicationId: string;
        slots: Array<{ slotInstant: string }>;
      }>;
    };
  };
  return (
    body.data.medications
      .find((m) => m.medicationId === medId)
      ?.slots.map((s) => s.slotInstant) ?? []
  );
}

async function doseHistoryToday(medId: string) {
  const { GET } = await import("@/app/api/medications/[id]/dose-history/route");
  const q = new URLSearchParams({
    from: "2026-11-22T23:00:00.000Z",
    to: "2026-11-23T22:59:59.000Z",
  });
  const res = await (GET as unknown as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medId}/dose-history?${q}`,
    ),
    { params: Promise.resolve({ id: medId }) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { rows: Array<{ kind: string; at: string }> };
  };
  return body.data.rows.filter((r) => r.kind === "slot").map((r) => r.at);
}

async function mcpNextDue(userId: string, medId: string) {
  const out = (await getMedicationScheduleTool.run(
    {
      userId,
      tokenId: "t",
      scopes: ["*"],
      binding: `${userId}:t`,
      canRead: true,
      canWrite: false,
    },
    {},
  )) as { medications: Array<{ id: string; nextDueAt: string | null }> };
  return out.medications.find((m) => m.id === `med:${medId}`)?.nextDueAt;
}

async function digestMedicationsLine(userId: string) {
  const user = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
  });
  const digest = await loadDailyDigest(user, new Date(), { locale: "en" });
  return digest.today.find((f) => f.kind === "medications")?.value ?? null;
}

function remindedSlots() {
  return vi
    .mocked(dispatchNotification)
    .mock.calls.map(
      (c) => (c[0].metadata as { scheduledAt?: string }).scheduledAt,
    );
}

/** The silent wakes the edits sent: intake syncs and data-changed notes. */
function wakes() {
  return (
    vi.mocked(queueMedicationIntakeSync).mock.calls.length +
    vi.mocked(noteDataChanged).mock.calls.length
  );
}

describe("a dose time moved during the day", () => {
  it("leaves every today surface on the new time", async () => {
    const { user, med } = await seed();
    const prisma = getPrismaClient();

    // 11:19 Berlin: the app's launch projects today's 21:16 slot.
    const before = await readToday();
    expect(
      before.filter((r) => r.medicationId === med.id).map((r) => r.scheduledAt),
    ).toEqual([OLD_SLOT]);

    // 11:26:01 Berlin: the time moves to 11:30.
    vi.setSystemTime(new Date("2026-11-23T10:26:01.000Z"));
    await putSchedule(med.id, NEW_SCHEDULE);
    expect(
      await prisma.medicationScheduleRevision.count({
        where: { medicationId: med.id },
      }),
    ).toBe(1);
    // A real change wakes the devices.
    expect(vi.mocked(queueMedicationIntakeSync)).toHaveBeenCalledTimes(1);

    // The 21:16 row is tombstoned and nothing has minted 11:30 yet.
    expect(await liveRowsToday(med.id)).toEqual([]);

    // 11:30:23 Berlin: the reminder worker reads the schedule, not the rows.
    vi.setSystemTime(new Date("2026-11-23T10:30:23.000Z"));
    await handleReminderCheck([]);
    expect(remindedSlots()).toEqual([NEW_SLOT]);

    // The schedule-derived readers name 11:30 before any projection ran.
    expect(await resolvedSlotsToday(med.id)).toEqual([NEW_SLOT]);
    expect(await doseHistoryToday(med.id)).toEqual([NEW_SLOT]);
    expect(await mcpNextDue(user.id, med.id)).toBe(NEW_SLOT);

    // The today list projects, and the row table follows.
    const after = await readToday();
    expect(
      after.filter((r) => r.medicationId === med.id).map((r) => r.scheduledAt),
    ).toEqual([NEW_SLOT]);
    expect(
      (await liveRowsToday(med.id)).map((r) => r.scheduledFor.toISOString()),
    ).toEqual([NEW_SLOT]);

    // The dashboard and the digest count the one moved dose.
    expect((await readDashboardCompliance()).scheduledToday).toBe(1);
    expect(await digestMedicationsLine(user.id)).toBe("0 of 1 taken");
  });

  it("names no slot today when the time moves to one already past", async () => {
    const { user, med } = await seed();

    await readToday();
    vi.setSystemTime(new Date("2026-11-23T10:26:01.000Z"));
    await putSchedule(med.id, PAST_SCHEDULE);
    expect(vi.mocked(queueMedicationIntakeSync)).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-23T10:30:23.000Z"));
    await handleReminderCheck([]);
    expect(remindedSlots()).toEqual([]);

    expect(await resolvedSlotsToday(med.id)).toEqual([]);
    expect(await doseHistoryToday(med.id)).toEqual([]);
    expect(await mcpNextDue(user.id, med.id)).toBe(TOMORROW_PAST_SLOT);

    const after = await readToday();
    expect(after.filter((r) => r.medicationId === med.id)).toEqual([]);
    expect(await liveRowsToday(med.id)).toEqual([]);
    expect((await readDashboardCompliance()).scheduledToday).toBe(0);
    expect(await digestMedicationsLine(user.id)).toBeNull();
  });

  it("keeps an earlier dose that is still open when only a later time moves", async () => {
    const { med } = await seed();
    const prisma = getPrismaClient();
    const MORNING_SLOT = "2026-11-23T10:00:00.000Z"; // 11:00 Berlin
    const TWICE = {
      windowStart: "11:00",
      windowEnd: "21:16",
      timesOfDay: ["11:00", "21:16"],
      rrule: "FREQ=DAILY",
    };
    await putSchedule(med.id, TWICE);
    await prisma.medicationScheduleRevision.updateMany({
      where: { medicationId: med.id },
      data: { validUntil: new Date("2026-11-22T20:04:33.000Z") },
    });

    // 11:19 Berlin: the 11:00 dose is due, the 21:16 one ahead.
    const before = await readToday();
    expect(
      before
        .filter((r) => r.medicationId === med.id)
        .map((r) => r.scheduledAt)
        .sort(),
    ).toEqual([MORNING_SLOT, OLD_SLOT]);

    // 11:26 Berlin: the evening time moves to 22:00; 11:00 stays as it is.
    vi.setSystemTime(new Date("2026-11-23T10:26:01.000Z"));
    await putSchedule(med.id, {
      ...TWICE,
      windowEnd: "22:00",
      timesOfDay: ["11:00", "22:00"],
    });

    const after = await readToday();
    expect(
      after
        .filter((r) => r.medicationId === med.id)
        .map((r) => r.scheduledAt)
        .sort(),
    ).toEqual([MORNING_SLOT, "2026-11-23T21:00:00.000Z"]);
    expect(await resolvedSlotsToday(med.id)).toContain(MORNING_SLOT);
    expect((await readDashboardCompliance()).scheduledToday).toBe(2);
  });

  it("keeps the open row and wakes no device on a save that repeats the schedule", async () => {
    const { med } = await seed();
    const prisma = getPrismaClient();

    await readToday();
    const [minted] = await liveRowsToday(med.id);
    expect(minted.scheduledFor.toISOString()).toBe(OLD_SLOT);
    const { syncVersion } =
      await prisma.medicationIntakeEvent.findUniqueOrThrow({
        where: { id: minted.id },
        select: { syncVersion: true },
      });

    const staleCell = `${med.userId}|${med.id}|stale-probe`;
    const staleListCell = `${med.userId}|stale-probe`;
    caches.medicationCompliance.set(staleCell, { stale: true });
    caches.medications.set(staleListCell, { stale: true });

    // 11:25:45 Berlin: the form saves the same schedule back.
    vi.setSystemTime(new Date("2026-11-23T10:25:45.000Z"));
    await putSchedule(med.id, OLD_SCHEDULE);

    // No era: the cadence did not change.
    expect(
      await prisma.medicationScheduleRevision.count({
        where: { medicationId: med.id },
      }),
    ).toBe(0);
    // The open row stays, under its id and sync version ...
    expect(await liveRowsToday(med.id)).toEqual([minted]);
    const kept = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: minted.id },
      select: { deletedAt: true, syncVersion: true },
    });
    expect(kept).toEqual({ deletedAt: null, syncVersion });
    // ... and no device is woken for it.
    expect(wakes()).toBe(0);
    // The save still evicts the record's memoised medication cells: a cell
    // written before the save must not answer the next read.
    expect(caches.medicationCompliance.get(staleCell)).toBeNull();
    expect(caches.medications.get(staleListCell)).toBeNull();

    // The next projecting read finds the same row.
    await readToday();
    expect(await liveRowsToday(med.id)).toEqual([minted]);
  });
});
