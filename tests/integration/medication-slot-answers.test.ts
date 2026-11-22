/**
 * A dose write tells the device that sent it which slot the dose landed on
 * (iOS #191): `slotInstant` on every entry of the bulk route and on the
 * answer of the per-medication route, and an occupied pin names the take that
 * holds the slot the way `alreadyTaken` does. The app silences the right
 * local reminder from the answer, without reading the history again and
 * without a silent push back to itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { DAY_MS, TZ, perMedPost } from "./medication-dose-state-fixtures";

const syncCalls: Array<{ originDeviceToken?: string | null }> = [];
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: (arg: { originDeviceToken?: string | null }) =>
    syncCalls.push(arg),
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 08:10 in Berlin; doses are due at 08:00 and 20:00.
const NOW = new Date("2026-11-21T07:10:00.000Z");
const MORNING = new Date("2026-11-21T07:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  syncCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(opts: { appleHealth?: boolean } = {}) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "slots",
      email: "slots@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Ramipril",
      dose: "5 mg",
      active: true,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      ...(opts.appleHealth && {
        externalSource: "APPLE_HEALTH" as const,
        externalId: "hk-med-1",
      }),
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "20:00",
          timesOfDay: ["08:00", "20:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  const asNeeded = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Ibuprofen",
      dose: "400 mg",
      active: true,
      asNeeded: true,
      createdAt: new Date(Date.now() - 30 * DAY_MS),
    },
  });
  return { user, medId: med.id, asNeededId: asNeeded.id };
}

interface BulkEntry {
  status: string;
  reason?: string;
  id?: string;
  takenAt?: string | null;
  takenVia?: string | null;
  slotInstant?: string | null;
}

async function bulk(entries: unknown[]): Promise<BulkEntry[]> {
  const { POST } = await import("@/app/api/medications/intake/bulk/route");
  const res = await (POST as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/medications/intake/bulk", {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": "phone" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { entries: BulkEntry[] } }).data
    .entries;
}

async function holdMorning(userId: string, medId: string) {
  const takenAt = new Date("2026-11-21T07:02:00.000Z");
  await getPrismaClient().medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: medId,
      scheduledFor: MORNING,
      takenAt,
      source: "API",
      takenVia: "INTEGRATION",
    },
  });
  return takenAt;
}

describe("bulk intake: every entry names its slot", () => {
  it("a take, its replay and an as-needed dose carry slotInstant", async () => {
    const { medId, asNeededId } = await setup();
    const take = {
      medicationId: medId,
      takenAt: NOW.toISOString(),
      idempotencyKey: "phone-take-1",
    };
    const [first, prn, bad] = await bulk([
      take,
      {
        medicationId: asNeededId,
        takenAt: NOW.toISOString(),
        idempotencyKey: "phone-prn-1",
      },
      { medicationId: "not-a-medication", takenAt: NOW.toISOString() },
    ]);
    expect(first).toMatchObject({ slotInstant: MORNING.toISOString() });
    expect(["inserted", "updated"]).toContain(first.status);
    // An as-needed dose is on no slot; an entry that stored nothing neither.
    expect(prn).toMatchObject({ status: "inserted", slotInstant: null });
    expect(bad).toMatchObject({ status: "skipped", slotInstant: null });

    // The stored row agrees: the take is on the 08:00 slot.
    const row = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow(
      { where: { id: first.id! } },
    );
    expect(row.scheduledFor.toISOString()).toBe(MORNING.toISOString());

    // A replay answers with the same slot.
    const [again] = await bulk([take]);
    expect(again).toMatchObject({
      id: first.id,
      slotInstant: MORNING.toISOString(),
    });
  });

  it("a known Apple Health dose reads its slot off the row it already wrote", async () => {
    const { medId } = await setup({ appleHealth: true });
    const dose = {
      medicationId: medId,
      takenAt: NOW.toISOString(),
      source: "APPLE_HEALTH",
      externalId: "hk-dose-1",
    };
    const [first] = await bulk([dose]);
    expect(first.slotInstant).toBe(MORNING.toISOString());
    const [again] = await bulk([dose]);
    expect(again).toMatchObject({
      status: "duplicate",
      id: first.id,
      slotInstant: MORNING.toISOString(),
    });
  });

  it("alreadyTaken names the slot of the recorded take", async () => {
    const { user, medId } = await setup();
    const boxAt = await holdMorning(user.id, medId);
    const [entry] = await bulk([
      {
        medicationId: medId,
        scheduledFor: MORNING.toISOString(),
        takenAt: NOW.toISOString(),
        idempotencyKey: "phone-2",
      },
    ]);
    expect(entry).toMatchObject({
      status: "alreadyTaken",
      takenAt: boxAt.toISOString(),
      takenVia: "INTEGRATION",
      slotInstant: MORNING.toISOString(),
    });
  });

  it("an occupied pin carries the take that holds the slot", async () => {
    const { user, medId } = await setup();
    const boxAt = await holdMorning(user.id, medId);
    const [entry] = await bulk([
      {
        medicationId: medId,
        takenAt: NOW.toISOString(),
        forceSlotInstant: MORNING.toISOString(),
        idempotencyKey: "phone-pin-1",
      },
    ]);
    expect(entry).toEqual({
      index: 0,
      status: "skipped",
      reason: "force_slot_occupied",
      slotInstant: MORNING.toISOString(),
      takenAt: boxAt.toISOString(),
      takenVia: "INTEGRATION",
    });
    // Nothing was written over the held take.
    const rows = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { medicationId: medId, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].takenAt?.getTime()).toBe(boxAt.getTime());
  });

  it("an occupied pin held by a skip names the slot with no take", async () => {
    const { user, medId } = await setup();
    await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medId,
        scheduledFor: MORNING,
        skipped: true,
        source: "WEB",
      },
    });
    const [entry] = await bulk([
      {
        medicationId: medId,
        takenAt: NOW.toISOString(),
        forceSlotInstant: MORNING.toISOString(),
      },
    ]);
    expect(entry).toMatchObject({
      status: "skipped",
      reason: "force_slot_occupied",
      slotInstant: MORNING.toISOString(),
      takenAt: null,
      takenVia: null,
    });
  });

  it("sends the silent intake sync to the other devices, not back to the sender", async () => {
    const { medId } = await setup();
    await bulk([{ medicationId: medId, takenAt: NOW.toISOString() }]);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].originDeviceToken).toBe("phone");
  });
});

describe("per-medication intake: the answer names its slot", () => {
  async function post(medId: string, body: Record<string, unknown>) {
    const res = await perMedPost(medId, body);
    return {
      status: res.status,
      body: (await res.json()) as {
        data: {
          scheduledFor: string;
          alreadyTaken: boolean;
          slotInstant: string | null;
        } | null;
        meta?: Record<string, unknown>;
      },
    };
  }

  it("a take answers slotInstant equal to scheduledFor; a repeat the same slot", async () => {
    const { medId } = await setup();
    const first = await post(medId, { takenAt: NOW.toISOString() });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      alreadyTaken: false,
      slotInstant: MORNING.toISOString(),
      scheduledFor: MORNING.toISOString(),
    });
    const repeat = await post(medId, {
      takenAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(repeat.status).toBe(200);
    expect(repeat.body.data).toMatchObject({
      alreadyTaken: true,
      slotInstant: MORNING.toISOString(),
    });
  });

  it("an extra dose and an as-needed dose are on no slot", async () => {
    const { medId, asNeededId } = await setup();
    const extra = await post(medId, {
      takenAt: NOW.toISOString(),
      extraDose: true,
    });
    expect(extra.status).toBe(201);
    expect(extra.body.data?.slotInstant).toBeNull();
    const prn = await post(asNeededId, { takenAt: NOW.toISOString() });
    expect(prn.status).toBe(201);
    expect(prn.body.data?.slotInstant).toBeNull();
  });

  it("an occupied pin answers 422 with the take that holds the slot", async () => {
    const { user, medId } = await setup();
    const boxAt = await holdMorning(user.id, medId);
    const refused = await post(medId, {
      takenAt: NOW.toISOString(),
      forceSlotInstant: MORNING.toISOString(),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.meta).toMatchObject({
      errorCode: "medications.intake.force_slot.occupied",
      slotInstant: MORNING.toISOString(),
      takenAt: boxAt.toISOString(),
      takenVia: "INTEGRATION",
    });
  });
});
