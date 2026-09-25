/**
 * #1033 — per-medication intake tracking, against a real Postgres.
 *
 * A medication with `trackIntake = false` keeps its schedule rows as a
 * record. These tests prove, through the real worker, projector, compliance
 * builders and routes, that nothing derives a due dose from those rows: no
 * reminder, no placeholder, no place on the doses card or the today list, no
 * adherence figure. And that switching tracking back on resumes from that
 * moment, with no miss counted for the stretch it was off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
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
const { buildMedsTodayBlock } = await import("@/lib/dashboard/meds-today");
const { buildScheduleAnchoredComplianceBuckets } =
  await import("@/lib/analytics/schedule-anchored-compliance");
const { runIntakeAutoSkipPass } = await import("@/lib/jobs/intake-auto-skip");

const TZ = "Europe/Berlin";
let counter = 0;

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

async function makeUser(): Promise<string> {
  const suffix = `${Date.now()}-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `track-intake-${suffix}`,
      email: `track-intake-${suffix}@example.test`,
      timezone: TZ,
      locale: "en",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

async function seedDaily(
  userId: string,
  name: string,
  trackIntake: boolean,
  createdAt = new Date("2026-06-01T00:00:00.000Z"),
): Promise<string> {
  const medication = await getPrismaClient().medication.create({
    data: {
      userId,
      name,
      dose: "1 tablet",
      trackIntake,
      createdAt,
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          scheduleType: "SCHEDULED",
        },
      },
    },
    select: { id: true },
  });
  return medication.id;
}

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function request(url: string, init?: { method: string; body?: unknown }) {
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined && {
      body: JSON.stringify(init.body),
      headers: { "content-type": "application/json" },
    }),
  });
}

async function call<T>(
  handler: Handler,
  url: string,
  params: Record<string, string> = {},
  init?: { method: string; body?: unknown },
): Promise<{ status: number; data: T }> {
  const res = await handler(request(url, init), {
    params: Promise.resolve(params),
  });
  const json = (await res.json()) as { data: T };
  return { status: res.status, data: json.data };
}

function dispatchedFor(medicationId: string): number {
  return vi
    .mocked(dispatchNotification)
    .mock.calls.filter(
      ([arg]) =>
        (arg as { metadata?: { medicationId?: string } }).metadata
          ?.medicationId === medicationId,
    ).length;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(dispatchNotification).mockClear();
  cookieJar.clear();
  headerJar.clear();
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("intake tracking off — nothing is due", () => {
  it("sends no reminder and mints no placeholder, on any tick", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const tracked = await seedDaily(userId, "Tracked", true);
    const record = await seedDaily(userId, "Record", false);

    // 08:30, 12:00 and 20:00 local: inside the window, past the late mark,
    // past the miss mark (the worker mints a missed placeholder there).
    for (const tick of [
      "2026-06-10T06:30:00.000Z",
      "2026-06-10T10:00:00.000Z",
      "2026-06-10T18:00:00.000Z",
    ]) {
      at(tick);
      await handleReminderCheck([]);
    }

    expect(dispatchedFor(tracked)).toBeGreaterThan(0);
    expect(dispatchedFor(record)).toBe(0);
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { medicationId: record },
      }),
    ).toBe(0);
  });

  it("stays off the doses card, the today list and the take flows", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const tracked = await seedDaily(userId, "Tracked", true);
    const record = await seedDaily(userId, "Record", false);
    at("2026-06-10T09:00:00.000Z"); // 11:00 local, the 08:00 dose overdue

    const block = await buildMedsTodayBlock(prisma, userId, TZ, new Date());
    expect(block.activeCount).toBe(1);
    expect((block.dueCandidates ?? []).map((c) => c.medicationId)).toEqual([
      tracked,
    ]);

    const intakeRoute = await import("@/app/api/medications/intake/route");
    const today = await call<Array<{ medicationId: string }>>(
      intakeRoute.GET as Handler,
      "/api/medications/intake?scope=today",
    );
    expect(today.status).toBe(200);
    expect(today.data.map((r) => r.medicationId)).toEqual([tracked]);
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { medicationId: record },
      }),
    ).toBe(0);

    // The list serves the record-only medication the way it serves an
    // as-needed one: no schedules in force, the stored ones on record.
    const listRoute = await import("@/app/api/medications/route");
    const list = await call<
      Array<{
        id: string;
        trackIntake: boolean;
        schedules: unknown[];
        recordedSchedules?: Array<{ timesOfDay: string[] }>;
        nextDueAt: string | null;
      }>
    >(listRoute.GET as Handler, "/api/medications");
    const recordRow = list.data.find((m) => m.id === record)!;
    const trackedRow = list.data.find((m) => m.id === tracked)!;
    expect(recordRow.trackIntake).toBe(false);
    expect(recordRow.schedules).toEqual([]);
    expect(recordRow.recordedSchedules?.[0]?.timesOfDay).toEqual(["08:00"]);
    expect(recordRow.nextDueAt).toBeNull();
    expect(trackedRow.schedules).toHaveLength(1);
    expect(trackedRow).not.toHaveProperty("recordedSchedules");
    expect(trackedRow.nextDueAt).not.toBeNull();
  });

  it("is left out of every adherence read", async () => {
    const userId = await makeUser();
    const tracked = await seedDaily(userId, "Tracked", true);
    const record = await seedDaily(userId, "Record", false);
    at("2026-06-10T20:00:00.000Z");

    // Dashboard daily buckets: one expected dose a day, the tracked one.
    const buckets = await buildScheduleAnchoredComplianceBuckets(
      userId,
      5,
      TZ,
      new Date(),
    );
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets.slice(0, -1)) {
      expect(bucket.scheduled).toBeLessThanOrEqual(1);
    }

    // The batched card read carries only the tracked medication.
    const batch = await import("@/app/api/medications/compliance/route");
    const summary = await call<Array<{ medicationId: string }>>(
      batch.GET as Handler,
      "/api/medications/compliance",
    );
    expect(summary.data.map((e) => e.medicationId)).toEqual([tracked]);

    // The per-medication read answers not-applicable, with its reason.
    const perId = await import("@/app/api/medications/[id]/compliance/route");
    const payload = await call<{
      applicable: boolean;
      notApplicableReason: string | null;
      dailyCompliance: Record<string, unknown>;
    }>(perId.GET as Handler, `/api/medications/${record}/compliance`, {
      id: record,
    });
    expect(payload.status).toBe(200);
    expect(payload.data.applicable).toBe(false);
    expect(payload.data.notApplicableReason).toBe("INTAKE_NOT_TRACKED");
    expect(payload.data.dailyCompliance).toEqual({});
  });
});

describe("switching intake tracking back on", () => {
  it("resumes from that moment with no miss for the stretch it was off", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedDaily(userId, "Statin", true);
    const route = await import("@/app/api/medications/[id]/route");

    // Four doses taken on time, 1–4 June.
    for (const day of ["01", "02", "03", "04"]) {
      await prisma.medicationIntakeEvent.create({
        data: {
          userId,
          medicationId,
          scheduledFor: new Date(`2026-06-${day}T06:00:00.000Z`),
          takenAt: new Date(`2026-06-${day}T06:02:00.000Z`),
          source: "WEB",
        },
      });
    }

    // 5 June, 07:00 local: the doses card has minted today's pending 08:00.
    at("2026-06-05T05:00:00.000Z");
    await buildMedsTodayBlock(prisma, userId, TZ, new Date());
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { medicationId, takenAt: null, deletedAt: null },
      }),
    ).toBe(1);

    // 07:30 local: tracking off. The open placeholder goes with it.
    at("2026-06-05T05:30:00.000Z");
    const off = await call<{ trackIntake: boolean; schedules: unknown[] }>(
      route.PUT as Handler,
      `/api/medications/${medicationId}`,
      { id: medicationId },
      { method: "PUT", body: { trackIntake: false } },
    );
    expect(off.status).toBe(200);
    expect(off.data.trackIntake).toBe(false);
    expect(off.data.schedules).toEqual([]);
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { medicationId, takenAt: null, deletedAt: null },
      }),
    ).toBe(0);
    // The stored schedule is untouched.
    expect(
      await prisma.medicationSchedule.count({ where: { medicationId } }),
    ).toBe(1);

    // A week off. The auto-miss pass runs; nothing becomes a miss.
    at("2026-06-11T12:00:00.000Z");
    await runIntakeAutoSkipPass(prisma, { nowMs: Date.now() });
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { medicationId, autoMissed: true },
      }),
    ).toBe(0);

    // 12 June, 15:00 local: tracking back on.
    at("2026-06-12T13:00:00.000Z");
    const on = await call<{ trackIntake: boolean; schedules: unknown[] }>(
      route.PUT as Handler,
      `/api/medications/${medicationId}`,
      { id: medicationId },
      { method: "PUT", body: { trackIntake: true } },
    );
    expect(on.status).toBe(200);
    expect(on.data.trackIntake).toBe(true);
    expect(on.data.schedules).toHaveLength(1);

    // Today's 08:00 lies before the switch: not projected, not reminded.
    const block = await buildMedsTodayBlock(prisma, userId, TZ, new Date());
    expect(block.scheduledToday).toBe(0);
    expect((block.dueCandidates ?? []).every((c) => c.overdue === false)).toBe(
      true,
    );
    await handleReminderCheck([]);
    expect(dispatchedFor(medicationId)).toBe(0);

    // Adherence: the four taken doses count, the untracked week does not.
    const perId = await import("@/app/api/medications/[id]/compliance/route");
    const payload = await call<{
      applicable: boolean;
      compliance30: { taken: number; missed: number; totalExpected: number };
    }>(perId.GET as Handler, `/api/medications/${medicationId}/compliance`, {
      id: medicationId,
    });
    expect(payload.data.applicable).toBe(true);
    expect(payload.data.compliance30.taken).toBe(4);
    expect(payload.data.compliance30.missed).toBe(0);

    // From the next morning on, it is a tracked medication again.
    at("2026-06-13T06:30:00.000Z");
    await handleReminderCheck([]);
    expect(dispatchedFor(medicationId)).toBeGreaterThan(0);
  });
});

describe("the shipped iPhone app editing a record-only medication", () => {
  it("never replaces the recorded schedule with its 08:00 default", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedDaily(userId, "Statin", false);
    await prisma.medicationSchedule.updateMany({
      where: { medicationId },
      data: { windowStart: "21:00", windowEnd: "21:00", timesOfDay: ["21:00"] },
    });
    const route = await import("@/app/api/medications/[id]/route");
    at("2026-06-10T10:00:00.000Z");

    // `EditMedicationSheet.save()` in 1.0.3 / 1.0.4 after the dose time on
    // its "daily at 08:00" default was moved to 09:00 and the name edited.
    const res = await call<{
      name: string;
      trackIntake: boolean;
      schedules: unknown[];
      recordedSchedules?: Array<{ timesOfDay: string[] }>;
    }>(
      route.PUT as Handler,
      `/api/medications/${medicationId}`,
      { id: medicationId },
      {
        method: "PUT",
        body: {
          name: "Statin 20",
          dose: "1 tablet",
          treatmentClass: "GENERIC",
          category: "OTHER",
          active: true,
          notificationsEnabled: true,
          deliveryForm: "ORAL",
          schedules: [
            {
              windowStart: "09:00",
              windowEnd: "09:00",
              timesOfDay: ["09:00"],
              rrule: "FREQ=DAILY",
            },
          ],
          oneShot: false,
          asNeeded: false,
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.data.name).toBe("Statin 20");
    expect(res.data.trackIntake).toBe(false);
    expect(res.data.schedules).toEqual([]);
    expect(res.data.recordedSchedules?.[0]?.timesOfDay).toEqual(["21:00"]);
    const stored = await prisma.medicationSchedule.findMany({
      where: { medicationId },
    });
    expect(stored.map((s) => s.timesOfDay)).toEqual([["21:00"]]);
    expect(
      await prisma.medicationScheduleRevision.count({
        where: { medicationId },
      }),
    ).toBe(0);
  });
});

describe("rate readers that never read a schedule", () => {
  it("a week of misses on a record-only medication raises no compliance nudge", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const record = await seedDaily(userId, "Record", false);
    at("2026-06-10T04:00:00.000Z");
    // Seven auto-missed slots left over from before tracking went off.
    for (let d = 1; d <= 7; d++) {
      await prisma.medicationIntakeEvent.create({
        data: {
          userId,
          medicationId: record,
          scheduledFor: new Date(Date.UTC(2026, 5, 10 - d, 6, 0)),
          autoMissed: true,
          source: "REMINDER",
        },
      });
    }
    const { findTriggerForUser } = await import("@/lib/jobs/coach-nudge");
    const user = {
      id: userId,
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      thresholdsJson: null,
      timezone: TZ,
    };
    const groups = { medication: true, vitals: false, routine: false };
    expect(
      await findTriggerForUser(prisma, user, new Date(), groups),
    ).toBeNull();

    // The same rows on a tracked medication do nudge.
    await prisma.medication.update({
      where: { id: record },
      data: { trackIntake: true },
    });
    expect(await findTriggerForUser(prisma, user, new Date(), groups)).toBe(
      "compliance",
    );
  });
});

describe("the live era floors every slot minted from the live schedule", () => {
  const route = () => import("@/app/api/medications/[id]/route");

  async function putSchedule(medicationId: string, time: string) {
    const { PUT } = await route();
    return call(
      PUT as Handler,
      `/api/medications/${medicationId}`,
      { id: medicationId },
      {
        method: "PUT",
        body: {
          trackIntake: true,
          schedules: [
            {
              windowStart: time,
              windowEnd: time,
              timesOfDay: [time],
              rrule: "FREQ=DAILY",
            },
          ],
        },
      },
    );
  }

  async function pendingFor(medicationId: string) {
    return getPrismaClient().medicationIntakeEvent.findMany({
      where: { medicationId, deletedAt: null, takenAt: null, skipped: false },
      select: { scheduledFor: true, autoMissed: true },
    });
  }

  it("tracking back on, then a times edit the same afternoon, mints no earlier slot", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedDaily(userId, "Statin", false);
    const { PUT } = await route();

    at("2026-06-10T12:00:00.000Z"); // 14:00 local: tracking back on
    const on = await call(
      PUT as Handler,
      `/api/medications/${medicationId}`,
      { id: medicationId },
      { method: "PUT", body: { trackIntake: true } },
    );
    expect(on.status).toBe(200);

    at("2026-06-10T12:30:00.000Z"); // 14:30 local: 08:00 moves to 09:00
    expect((await putSchedule(medicationId, "09:00")).status).toBe(200);

    await buildMedsTodayBlock(prisma, userId, TZ, new Date());
    expect(await pendingFor(medicationId)).toEqual([]);

    // Next morning's 09:00 is a real dose again; the next day's pass stamps
    // nothing from the day of the switch.
    at("2026-06-11T22:00:00.000Z");
    await runIntakeAutoSkipPass(prisma, { nowMs: Date.now() });
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { medicationId, autoMissed: true },
      }),
    ).toBe(0);
  });

  it("a same-day times edit on a tracked medication mints no earlier slot", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedDaily(userId, "Ramipril", true);

    at("2026-06-10T12:30:00.000Z"); // 14:30 local: 08:00 moves to 09:00
    expect((await putSchedule(medicationId, "09:00")).status).toBe(200);
    const block = await buildMedsTodayBlock(prisma, userId, TZ, new Date());
    expect(block.scheduledToday).toBe(0);
    expect((block.dueCandidates ?? []).every((c) => !c.overdue)).toBe(true);
    expect(await pendingFor(medicationId)).toEqual([]);

    // The worker does not remind the 09:00 slot either.
    await handleReminderCheck([]);
    expect(dispatchedFor(medicationId)).toBe(0);
  });

  it("auto-miss leaves a placeholder minted after the switch for a slot before it", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedDaily(userId, "Metformin", true);
    const eraStart = new Date("2026-06-10T12:30:00.000Z");
    await prisma.medicationScheduleRevision.create({
      data: {
        medicationId,
        validFrom: new Date("2026-06-01T00:00:00.000Z"),
        validUntil: eraStart,
        payload: [],
      },
    });
    // A real expectation of the old era, minted that morning.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId,
        scheduledFor: new Date("2026-06-09T06:00:00.000Z"),
        source: "REMINDER",
        createdAt: new Date("2026-06-09T04:00:00.000Z"),
      },
    });
    // A phantom: minted after the switch for a slot before it.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId,
        scheduledFor: new Date("2026-06-10T07:00:00.000Z"),
        source: "REMINDER",
        createdAt: new Date("2026-06-10T13:00:00.000Z"),
      },
    });

    at("2026-06-12T12:00:00.000Z");
    await runIntakeAutoSkipPass(prisma, { nowMs: Date.now() });
    const rows = await prisma.medicationIntakeEvent.findMany({
      where: { medicationId },
      orderBy: { scheduledFor: "asc" },
      select: { autoMissed: true },
    });
    expect(rows.map((r) => r.autoMissed)).toEqual([true, false]);
  });
});
