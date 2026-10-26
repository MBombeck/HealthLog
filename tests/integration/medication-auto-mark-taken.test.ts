/**
 * v1.42.2 — "record doses automatically", against a real Postgres.
 *
 * Proves, through the real pass, the real inventory hook, the real auto-miss
 * pass, the reminder worker and the medication route:
 *   - running the pass twice leaves exactly one taken intake per slot;
 *   - a slot the person skipped by hand is left as they left it;
 *   - a paused medication gets nothing;
 *   - stock goes down once per recorded dose, never again on a re-run;
 *   - nothing before the option was switched on is filled;
 *   - the auto-miss pass leaves the slots the auto-take pass owns alone;
 *   - no reminder goes out for the medication while the option is on;
 *   - the route stamps the switch-on instant on an off→on flip only.
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
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

const { dispatchNotification } = await import("@/lib/notifications/dispatcher");
const { runIntakeAutoTakePass } = await import("@/lib/jobs/intake-auto-take");
const { runIntakeAutoSkipPass } = await import("@/lib/jobs/intake-auto-skip");
const { handleReminderCheck } =
  await import("@/lib/jobs/reminder/medication-reminder-check");

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
      username: `auto-take-${suffix}`,
      email: `auto-take-${suffix}@example.test`,
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

/** A supplement taken every evening at 19:00, with a 30-tablet bottle. */
async function seedEvening(
  userId: string,
  name: string,
  options: {
    autoMarkTakenSince: Date | null;
    pausedAt?: Date | null;
    active?: boolean;
  },
): Promise<string> {
  const prisma = getPrismaClient();
  const medication = await prisma.medication.create({
    data: {
      userId,
      name,
      dose: "1 capsule",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      autoMarkTaken: options.autoMarkTakenSince !== null,
      autoMarkTakenSince: options.autoMarkTakenSince,
      notificationsEnabled: true,
      active: options.active ?? true,
      pausedAt: options.pausedAt ?? null,
      schedules: {
        create: {
          windowStart: "19:00",
          windowEnd: "19:00",
          timesOfDay: ["19:00"],
          rrule: "FREQ=DAILY",
          scheduleType: "SCHEDULED",
        },
      },
    },
    select: { id: true },
  });
  await prisma.medicationInventoryItem.create({
    data: {
      userId,
      medicationId: medication.id,
      state: "ACTIVE",
      unitsTotal: 30,
      unitsRemaining: 30,
    },
  });
  return medication.id;
}

async function stock(medicationId: string): Promise<number> {
  const items = await getPrismaClient().medicationInventoryItem.findMany({
    where: { medicationId },
    select: { unitsRemaining: true },
  });
  return items.reduce((sum, i) => sum + Number(i.unitsRemaining), 0);
}

async function liveRows(medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId, deletedAt: null },
    orderBy: { scheduledFor: "asc" },
    select: {
      scheduledFor: true,
      takenAt: true,
      skipped: true,
      autoMissed: true,
      autoRecorded: true,
      inventoryConsumption: true,
    },
  });
}

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
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

describe("auto-mark-taken pass", () => {
  it("records each slot once, leaves the hand-skipped slot and the paused medication, and moves stock once", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    // Switched on Mon 2026-06-08 at 12:00 local.
    const since = new Date("2026-06-08T10:00:00.000Z");
    const evening = await seedEvening(userId, "Magnesium", {
      autoMarkTakenSince: since,
    });
    const paused = await seedEvening(userId, "Vitamin D", {
      autoMarkTakenSince: since,
      active: false,
      pausedAt: new Date("2026-06-07T00:00:00.000Z"),
    });

    // A Sunday slot before the switch: a pending placeholder that must stay.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId: evening,
        scheduledFor: new Date("2026-06-07T17:00:00.000Z"),
        source: "REMINDER",
      },
    });
    // Tuesday: skipped by hand.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId: evening,
        scheduledFor: new Date("2026-06-09T17:00:00.000Z"),
        skipped: true,
        source: "WEB",
      },
    });
    // Wednesday: the projector's pending placeholder.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId: evening,
        scheduledFor: new Date("2026-06-10T17:00:00.000Z"),
        source: "REMINDER",
      },
    });

    const now = Date.parse("2026-06-10T17:25:00.000Z"); // Wed 19:25 local
    const first = await runIntakeAutoTakePass(prisma, { nowMs: now });
    expect(first.recordedCount).toBe(2);
    const second = await runIntakeAutoTakePass(prisma, {
      nowMs: now + 15 * 60_000,
    });
    expect(second.recordedCount).toBe(0);

    const rows = await liveRows(evening);
    expect(
      rows.map((r) => ({
        at: r.scheduledFor.toISOString(),
        taken: r.takenAt?.toISOString() ?? null,
        skipped: r.skipped,
        auto: r.autoRecorded,
      })),
    ).toEqual([
      // Before the switch: untouched.
      {
        at: "2026-06-07T17:00:00.000Z",
        taken: null,
        skipped: false,
        auto: false,
      },
      // Mon: created, taken at its time.
      {
        at: "2026-06-08T17:00:00.000Z",
        taken: "2026-06-08T17:00:00.000Z",
        skipped: false,
        auto: true,
      },
      // Tue: the person's skip stands.
      {
        at: "2026-06-09T17:00:00.000Z",
        taken: null,
        skipped: true,
        auto: false,
      },
      // Wed: the placeholder converted in place, no sibling.
      {
        at: "2026-06-10T17:00:00.000Z",
        taken: "2026-06-10T17:00:00.000Z",
        skipped: false,
        auto: true,
      },
    ]);

    // Two doses recorded, two capsules gone, each stamped once.
    expect(await stock(evening)).toBe(28);
    expect(
      rows.filter((r) => r.autoRecorded && r.inventoryConsumption !== null),
    ).toHaveLength(2);

    // The paused medication got nothing and kept its stock.
    expect(await liveRows(paused)).toEqual([]);
    expect(await stock(paused)).toBe(30);
  });

  it("the auto-miss pass leaves the slots the auto-take pass owns", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const evening = await seedEvening(userId, "Omega-3", {
      autoMarkTakenSince: new Date("2026-06-08T10:00:00.000Z"),
    });
    // A pending placeholder on an owned slot, more than 24 h old.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId: evening,
        scheduledFor: new Date("2026-06-08T17:00:00.000Z"),
        source: "REMINDER",
      },
    });
    const now = Date.parse("2026-06-10T08:00:00.000Z");
    const skip = await runIntakeAutoSkipPass(prisma, { nowMs: now });
    expect(skip.skippedCount).toBe(0);

    await runIntakeAutoTakePass(prisma, { nowMs: now });
    const monday = (await liveRows(evening)).find(
      (r) => r.scheduledFor.toISOString() === "2026-06-08T17:00:00.000Z",
    );
    expect(monday).toMatchObject({ autoMissed: false, autoRecorded: true });
  });

  it("sends no reminder for the medication while the option is on", async () => {
    const userId = await makeUser();
    const auto = await seedEvening(userId, "Zinc", {
      autoMarkTakenSince: new Date("2026-06-01T00:00:00.000Z"),
    });
    const manual = await seedEvening(userId, "Iron", {
      autoMarkTakenSince: null,
    });
    for (const tick of [
      "2026-06-10T17:30:00.000Z",
      "2026-06-10T19:00:00.000Z",
      "2026-06-10T22:00:00.000Z",
    ]) {
      at(tick);
      await handleReminderCheck([]);
    }
    const dispatchedFor = (medicationId: string) =>
      vi
        .mocked(dispatchNotification)
        .mock.calls.filter(
          ([arg]) =>
            (arg as { metadata?: { medicationId?: string } }).metadata
              ?.medicationId === medicationId,
        ).length;
    expect(dispatchedFor(manual)).toBeGreaterThan(0);
    expect(dispatchedFor(auto)).toBe(0);
  });

  it("the route stamps the switch-on instant on a flip, and only then", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedEvening(userId, "B12", {
      autoMarkTakenSince: null,
    });
    const route = await import("@/app/api/medications/[id]/route");
    const put = (body: unknown) =>
      (route.PUT as Handler)(
        new NextRequest(`http://localhost/api/medications/${medicationId}`, {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id: medicationId }) },
      );

    at("2026-06-10T10:00:00.000Z");
    expect((await put({ autoMarkTaken: true })).status).toBe(200);
    const on = await prisma.medication.findUniqueOrThrow({
      where: { id: medicationId },
      select: { autoMarkTaken: true, autoMarkTakenSince: true },
    });
    expect(on.autoMarkTaken).toBe(true);
    expect(on.autoMarkTakenSince?.toISOString()).toBe(
      "2026-06-10T10:00:00.000Z",
    );

    // Re-saving with the option already on never moves the floor.
    at("2026-06-11T10:00:00.000Z");
    expect((await put({ autoMarkTaken: true, name: "B12 forte" })).status).toBe(
      200,
    );
    const resaved = await prisma.medication.findUniqueOrThrow({
      where: { id: medicationId },
      select: { autoMarkTakenSince: true },
    });
    expect(resaved.autoMarkTakenSince?.toISOString()).toBe(
      "2026-06-10T10:00:00.000Z",
    );

    // Off clears it.
    expect((await put({ autoMarkTaken: false })).status).toBe(200);
    const off = await prisma.medication.findUniqueOrThrow({
      where: { id: medicationId },
      select: { autoMarkTaken: true, autoMarkTakenSince: true },
    });
    expect(off).toEqual({ autoMarkTaken: false, autoMarkTakenSince: null });

    // Each flip is named in the audit row with what it was before; the
    // re-save that left it on names no change to it.
    const audits = await prisma.auditLog.findMany({
      where: { userId, action: "medication.update" },
      orderBy: { createdAt: "asc" },
      select: { details: true },
    });
    const details = audits.map(
      (a) =>
        JSON.parse(a.details ?? "{}") as {
          fields: string[];
          previous: Record<string, unknown>;
        },
    );
    expect(details).toHaveLength(3);
    // Two of the same timestamp: matched by content, not order.
    const flips = details
      .filter((d) => d.fields.includes("autoMarkTaken"))
      .map((d) => d.previous.autoMarkTaken)
      .sort();
    expect(flips).toEqual([false, true]);
    const resave = details.find((d) => d.fields.includes("name"));
    expect(resave?.fields).not.toContain("autoMarkTaken");
  });

  it("the create audit row says whether doses are recorded automatically", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const route = await import("@/app/api/medications/route");
    at("2026-06-10T10:00:00.000Z");
    const res = await (route.POST as Handler)(
      new NextRequest("http://localhost/api/medications", {
        method: "POST",
        body: JSON.stringify({
          name: "Vitamin D",
          dose: "1 capsule",
          autoMarkTaken: true,
          schedules: [{ windowStart: "19:00", windowEnd: "19:00" }],
        }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId, action: "medication.create" },
      select: { details: true },
    });
    expect(JSON.parse(audit.details ?? "{}")).toMatchObject({
      autoMarkTaken: true,
    });
  });
});

describe("reopening past days never backfills them", () => {
  it("a later end date or a re-activation moves the floor to now", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const medicationId = await seedEvening(userId, "Course", {
      autoMarkTakenSince: new Date("2026-06-01T00:00:00.000Z"),
    });
    const route = await import("@/app/api/medications/[id]/route");
    const put = (body: unknown) =>
      (route.PUT as Handler)(
        new NextRequest(`http://localhost/api/medications/${medicationId}`, {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id: medicationId }) },
      );
    const since = async () =>
      (
        await prisma.medication.findUniqueOrThrow({
          where: { id: medicationId },
          select: { autoMarkTakenSince: true },
        })
      ).autoMarkTakenSince?.toISOString();

    // The course ended on 06-05; the pass filled up to then.
    at("2026-06-03T10:00:00.000Z");
    expect(
      (await put({ startsOn: "2026-06-01", endsOn: "2026-06-05" })).status,
    ).toBe(200);
    expect(await since()).toBe("2026-06-01T00:00:00.000Z");
    at("2026-06-10T10:00:00.000Z");
    await runIntakeAutoTakePass(prisma, { nowMs: Date.now() });
    const filled = (await liveRows(medicationId)).length;

    // Extended on 06-10 to the end of the month: 06-06..06-09 reopen, but
    // the person never had them as due.
    expect((await put({ endsOn: "2026-06-30" })).status).toBe(200);
    expect(await since()).toBe("2026-06-10T10:00:00.000Z");
    await runIntakeAutoTakePass(prisma, { nowMs: Date.now() });
    expect((await liveRows(medicationId)).length).toBe(filled);

    // Paused, then active again a week later: nothing in between is filled.
    expect((await put({ active: false })).status).toBe(200);
    at("2026-06-17T10:00:00.000Z");
    expect((await put({ active: true })).status).toBe(200);
    expect(await since()).toBe("2026-06-17T10:00:00.000Z");
    await runIntakeAutoTakePass(prisma, { nowMs: Date.now() });
    expect((await liveRows(medicationId)).length).toBe(filled);
  });
});

describe("rolling cadence under auto-take", () => {
  it("never stalls on a removed dose, and the card shows the slot the pass records", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    // Weekly at 09:00 local. Last taken Mon 06-01; the 06-08 dose the pass
    // recorded was removed by the person (not taken that week).
    const medication = await prisma.medication.create({
      data: {
        userId,
        name: "Weekly injection",
        dose: "1 pen",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        autoMarkTaken: true,
        autoMarkTakenSince: new Date("2026-05-01T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "09:00",
            windowEnd: "09:00",
            timesOfDay: ["09:00"],
            rollingIntervalDays: 7,
            scheduleType: "SCHEDULED",
          },
        },
      },
      select: { id: true },
    });
    await prisma.medicationIntakeEvent.createMany({
      data: [
        {
          userId,
          medicationId: medication.id,
          scheduledFor: new Date("2026-06-01T07:00:00.000Z"),
          takenAt: new Date("2026-06-01T07:00:00.000Z"),
          source: "WEB",
        },
        {
          userId,
          medicationId: medication.id,
          scheduledFor: new Date("2026-06-08T07:00:00.000Z"),
          takenAt: new Date("2026-06-08T07:00:00.000Z"),
          autoRecorded: true,
          source: "REMINDER",
          deletedAt: new Date("2026-06-08T12:00:00.000Z"),
        },
      ],
    });

    const detail = await import("@/app/api/medications/[id]/route");
    const list = await import("@/app/api/medications/route");
    const nextDue = async () => {
      const res = await (detail.GET as Handler)(
        new NextRequest(`http://localhost/api/medications/${medication.id}`),
        { params: Promise.resolve({ id: medication.id }) },
      );
      const listRes = await (list.GET as Handler)(
        new NextRequest("http://localhost/api/medications"),
        { params: Promise.resolve({}) },
      );
      const listed = (
        (await listRes.json()) as {
          data: Array<{ id: string; nextDueAt: string | null }>;
        }
      ).data.find((m) => m.id === medication.id);
      const own = ((await res.json()) as { data: { nextDueAt: string | null } })
        .data.nextDueAt;
      expect(listed?.nextDueAt).toBe(own);
      return own;
    };

    at("2026-06-10T08:00:00.000Z");
    expect(await nextDue()).toBe("2026-06-15T07:00:00.000Z");

    at("2026-06-15T07:20:00.000Z");
    const result = await runIntakeAutoTakePass(prisma, {
      nowMs: Date.now(),
    });
    expect(result.recordedCount).toBe(1);
    const recorded = (await liveRows(medication.id)).filter(
      (r) => r.autoRecorded,
    );
    expect(recorded.map((r) => r.scheduledFor.toISOString())).toEqual([
      "2026-06-15T07:00:00.000Z",
    ]);
  });
});

describe("remindersActive — the published value is the gate", () => {
  it("equals sendsMedicationReminders() on the list and detail reads, for every combination", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const { sendsMedicationReminders } =
      await import("@/lib/medications/auto-mark-taken");
    at("2026-06-10T10:00:00.000Z");

    const combos: Array<{
      notificationsEnabled: boolean;
      autoMarkTaken: boolean;
      active: boolean;
      trackIntake: boolean;
      asNeeded: boolean;
      endsOn: Date | null;
      endedAt: Date | null;
    }> = [];
    for (let bits = 0; bits < 64; bits++) {
      combos.push({
        notificationsEnabled: (bits & 1) !== 0,
        autoMarkTaken: (bits & 2) !== 0,
        active: (bits & 4) !== 0,
        trackIntake: (bits & 8) !== 0,
        asNeeded: (bits & 16) !== 0,
        // A course that ended the day before.
        endsOn: (bits & 32) !== 0 ? new Date("2026-06-09T00:00:00.000Z") : null,
        endedAt: null,
      });
    }
    const ids: string[] = [];
    for (const [i, combo] of combos.entries()) {
      const med = await prisma.medication.create({
        data: {
          userId,
          name: `Combo ${i}`,
          dose: "1",
          ...combo,
          autoMarkTakenSince: combo.autoMarkTaken ? new Date() : null,
          ...(!combo.asNeeded && {
            schedules: {
              create: {
                windowStart: "19:00",
                windowEnd: "19:00",
                timesOfDay: ["19:00"],
                rrule: "FREQ=DAILY",
                scheduleType: "SCHEDULED",
              },
            },
          }),
        },
        select: { id: true },
      });
      ids.push(med.id);
    }

    const list = await import("@/app/api/medications/route");
    const listRes = await (list.GET as Handler)(
      new NextRequest("http://localhost/api/medications"),
      { params: Promise.resolve({}) },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: Array<{ id: string; remindersActive: boolean }>;
    };
    const listed = new Map(
      listBody.data.map((m) => [m.id, m.remindersActive] as const),
    );

    const detail = await import("@/app/api/medications/[id]/route");
    let trueCount = 0;
    for (const [i, id] of ids.entries()) {
      const expected = sendsMedicationReminders(combos[i], {
        now: new Date(),
        timeZone: TZ,
      });
      if (expected) trueCount++;
      expect(listed.get(id), `list combo ${i}`).toBe(expected);
      const res = await (detail.GET as Handler)(
        new NextRequest(`http://localhost/api/medications/${id}`),
        { params: Promise.resolve({ id }) },
      );
      const body = (await res.json()) as { data: { remindersActive: boolean } };
      expect(body.data.remindersActive, `detail combo ${i}`).toBe(expected);
    }
    // Exactly one combination reminds: on, not auto, active, tracked,
    // scheduled, course not ended.
    expect(trueCount).toBe(1);
  });

  it("a course that has ended reads as not reminding, and the worker sends nothing for it", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const ended = await seedEvening(userId, "Antibiotic", {
      autoMarkTakenSince: null,
    });
    const running = await seedEvening(userId, "Iron", {
      autoMarkTakenSince: null,
    });
    await prisma.medication.update({
      where: { id: ended },
      data: { endsOn: new Date("2026-06-09T00:00:00.000Z") },
    });
    for (const tick of [
      "2026-06-10T17:30:00.000Z",
      "2026-06-10T19:00:00.000Z",
      "2026-06-10T22:00:00.000Z",
    ]) {
      at(tick);
      await handleReminderCheck([]);
    }
    const dispatchedFor = (medicationId: string) =>
      vi
        .mocked(dispatchNotification)
        .mock.calls.filter(
          ([arg]) =>
            (arg as { metadata?: { medicationId?: string } }).metadata
              ?.medicationId === medicationId,
        ).length;
    expect(dispatchedFor(running)).toBeGreaterThan(0);
    expect(dispatchedFor(ended)).toBe(0);

    const list = await import("@/app/api/medications/route");
    const res = await (list.GET as Handler)(
      new NextRequest("http://localhost/api/medications"),
      { params: Promise.resolve({}) },
    );
    const published = new Map(
      (
        (await res.json()) as {
          data: Array<{ id: string; remindersActive: boolean }>;
        }
      ).data.map((m) => [m.id, m.remindersActive] as const),
    );
    expect(published.get(running)).toBe(true);
    expect(published.get(ended)).toBe(false);
  });
});
