/**
 * A take outside every dose window still answers its dose, an overdue dose
 * before a later one, and a dose reported twice is recorded once.
 *
 * A pill box posts to the ingest hook when it is opened. Opened five hours
 * after the slot, the take matched no band and landed ad hoc: the slot stayed
 * open, the phone kept asking for the dose, and a second dose was one tap
 * away. Now the take answers the most recent open dose of the day, the today
 * list says when and through which source it was taken, the paired devices
 * are woken, and a second report within two hours answers
 * `alreadyTaken: true` without writing. With no earlier dose open, the take
 * answers the next open dose within six hours. An earlier open dose always
 * wins: a take at 15:00 used to settle the 21:00 dose while the 09:00 dose
 * stayed open, and the evening reminder never came.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  DAY_MS,
  TZ,
  perMedPost,
  readToday,
} from "./medication-dose-state-fixtures";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-nearest-open-slot-ingest-32-bytes-min-12345";

const syncCalls: unknown[] = [];
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: (arg: unknown) => syncCalls.push(arg),
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 18:00 in Berlin; the dose was due at 13:00, its window closed at 17:00.
const NOW = new Date("2026-11-21T17:00:00.000Z");
const SLOT = new Date("2026-11-21T12:00:00.000Z");

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

async function setup() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "pillbox",
      email: "pillbox@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
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
      schedules: {
        create: {
          windowStart: "13:00",
          windowEnd: "13:00",
          timesOfDay: ["13:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  const { hashToken } = await import("@/lib/auth/hmac");
  const raw = `hlk_pillbox_${"0".repeat(48)}`;
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name: "pill box",
      tokenHash: hashToken(raw),
      permissions: ["medication:ingest", `medication:${med.id}:ingest`],
    },
  });
  return { user, medId: med.id, raw };
}

async function ingest(raw: string, idempotencyKey: string, takenAt?: Date) {
  const { POST } = await import("@/app/api/ingest/medication/route");
  return POST(
    new NextRequest("https://health.example/api/ingest/medication", {
      method: "POST",
      headers: {
        authorization: `Bearer ${raw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        medicationName: "Ramipril",
        idempotencyKey,
        ...(takenAt && { takenAt: takenAt.toISOString() }),
      }),
    }),
  );
}

async function liveRows(medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId, deletedAt: null },
  });
}

describe("a take outside every window answers the most recent open slot", () => {
  it("a pill box opened five hours late closes the slot, and a second report is the same dose", async () => {
    const { medId, raw } = await setup();

    const first = await ingest(raw, "box-1");
    expect(first.status).toBe(201);
    const live = await liveRows(medId);
    expect(live).toHaveLength(1);
    expect(live[0].scheduledFor.getTime()).toBe(SLOT.getTime());
    expect(live[0].takenAt?.getTime()).toBe(NOW.getTime());
    expect(live[0].attributionSource).toBe("USER_PIN");
    expect(syncCalls.length).toBeGreaterThan(0);

    const today = await readToday();
    const row = today.find(
      (r) => new Date(r.scheduledAt).getTime() === SLOT.getTime(),
    );
    expect(row).toMatchObject({ status: "taken", takenVia: "INTEGRATION" });
    expect(row?.takenAt).toBe(NOW.toISOString());

    const second = await ingest(
      raw,
      "box-2",
      new Date(NOW.getTime() - 15 * 60_000),
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      data: { id: string; alreadyTaken?: boolean; takenAt: string };
    };
    expect(body.data.alreadyTaken).toBe(true);
    expect(body.data.id).toBe(live[0].id);
    expect(body.data.takenAt).toBe(NOW.toISOString());
    expect(await liveRows(medId)).toHaveLength(1);
  });

  it("the per-medication route follows the same rule", async () => {
    const { medId } = await setup();
    const first = await perMedPost(medId, { skipped: false });
    expect(first.status).toBe(201);
    const live = await liveRows(medId);
    expect(live).toHaveLength(1);
    expect(live[0].scheduledFor.getTime()).toBe(SLOT.getTime());

    const second = await perMedPost(medId, { skipped: false });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      data: { id: string; alreadyTaken?: boolean };
    };
    expect(body.data).toMatchObject({ id: live[0].id, alreadyTaken: true });
    expect(await liveRows(medId)).toHaveLength(1);
  });

  it("a fixed key reused the next day is refused by name, not replayed", async () => {
    const { raw } = await setup();
    expect((await ingest(raw, "intake-fixed")).status).toBe(201);
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 3_600_000));
    const nextDay = await ingest(raw, "intake-fixed");
    expect(nextDay.status).toBe(409);
    const body = (await nextDay.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("ingest.idempotencyKey.reused");
  });

  it("a name with stray whitespace and another case still finds the medication", async () => {
    const { medId, raw } = await setup();
    const { POST } = await import("@/app/api/ingest/medication/route");
    const res = await POST(
      new NextRequest("https://health.example/api/ingest/medication", {
        method: "POST",
        headers: {
          authorization: `Bearer ${raw}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          medicationName: "  ramipril ",
          idempotencyKey: "box-ws",
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await liveRows(medId)).toHaveLength(1);
    const wrong = await ingest(raw, "box-wrong");
    expect(wrong.status).toBeLessThan(300);
  });

  it("a further dose after a taken slot answers the next open slot, not alreadyTaken", async () => {
    const { medId, raw } = await setup();
    const prisma = getPrismaClient();
    // A second dose time at 08:00 Berlin, taken by the box at 08:05.
    await prisma.medicationSchedule.create({
      data: {
        medicationId: medId,
        windowStart: "08:00",
        windowEnd: "08:00",
        timesOfDay: ["08:00"],
        daysOfWeek: null,
        scheduleType: "SCHEDULED",
      },
    });
    const morning = new Date("2026-11-21T07:00:00.000Z");
    const user = await prisma.user.findFirstOrThrow();
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medId,
        scheduledFor: morning,
        takenAt: new Date("2026-11-21T07:05:00.000Z"),
        source: "API",
        takenVia: "INTEGRATION",
        idempotencyKey: "box-morning",
      },
    });
    // 10:20 Berlin: more than two hours after the morning take, so not a
    // repeat of it. It is the midday dose, opened early.
    vi.setSystemTime(new Date("2026-11-21T09:20:00.000Z"));
    const res = await ingest(raw, "box-midday");
    expect(res.status).toBe(201);
    const midday = (await liveRows(medId)).find(
      (r) => r.scheduledFor.getTime() === SLOT.getTime(),
    );
    expect(midday?.takenAt?.toISOString()).toBe("2026-11-21T09:20:00.000Z");
    expect(midday?.attributionSource).toBe("USER_PIN");

    // Within two hours of the morning take it is the same dose again.
    vi.setSystemTime(new Date("2026-11-21T08:30:00.000Z"));
    const repeat = await ingest(raw, "box-again");
    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as { data: { alreadyTaken?: boolean } };
    expect(body.data.alreadyTaken).toBe(true);
  });

  it("a take beyond six hours of any slot stays ad hoc", async () => {
    const { medId, raw } = await setup();
    // 05:00 Berlin, eight hours before the slot.
    const early = new Date("2026-11-21T04:00:00.000Z");
    const res = await ingest(raw, "box-early", early);
    expect(res.status).toBe(201);
    const live = await liveRows(medId);
    const adHoc = live.find((r) => r.takenAt !== null);
    expect(adHoc?.scheduledFor.getTime()).toBe(early.getTime());
  });
});

describe("a take outside every window settles the overdue dose before the next one", () => {
  // Two dose times, 09:00 and 21:00 Berlin. At 15:00 the 09:00 dose is
  // overdue and the 21:00 dose six hours away.
  const MORNING = new Date("2026-11-21T08:00:00.000Z");
  const EVENING = new Date("2026-11-21T20:00:00.000Z");
  // 15:00:27 Berlin: a few seconds nearer to the evening dose than to the
  // morning one.
  const AFTERNOON = new Date("2026-11-21T14:00:27.000Z");

  async function twoDoses() {
    vi.setSystemTime(AFTERNOON);
    const fixture = await setup();
    const prisma = getPrismaClient();
    await prisma.medicationSchedule.deleteMany({
      where: { medicationId: fixture.medId },
    });
    await prisma.medicationSchedule.create({
      data: {
        medicationId: fixture.medId,
        windowStart: "09:00",
        windowEnd: "21:00",
        timesOfDay: ["09:00", "21:00"],
        daysOfWeek: null,
        scheduleType: "SCHEDULED",
      },
    });
    return fixture;
  }

  async function slotRow(medId: string, slot: Date) {
    return (await liveRows(medId)).find(
      (r) => r.scheduledFor.getTime() === slot.getTime(),
    );
  }

  it("settles the overdue morning dose, and the evening dose stays open", async () => {
    const { medId, raw } = await twoDoses();
    const res = await ingest(raw, "box-afternoon");
    expect(res.status).toBe(201);

    const morning = await slotRow(medId, MORNING);
    expect(morning?.takenAt?.getTime()).toBe(AFTERNOON.getTime());
    expect(morning?.takenVia).toBe("INTEGRATION");
    const evening = await slotRow(medId, EVENING);
    expect(evening?.takenAt ?? null).toBeNull();

    const today = await readToday();
    const eveningToday = today.find(
      (r) => new Date(r.scheduledAt).getTime() === EVENING.getTime(),
    );
    expect(eveningToday?.status).not.toBe("taken");

    // The same dose reported again half an hour later writes nothing.
    vi.setSystemTime(new Date(AFTERNOON.getTime() + 30 * 60_000));
    const again = await ingest(raw, "box-afternoon-2");
    expect(again.status).toBe(200);
    const body = (await again.json()) as { data: { alreadyTaken?: boolean } };
    expect(body.data.alreadyTaken).toBe(true);
    expect((await slotRow(medId, EVENING))?.takenAt ?? null).toBeNull();
  });

  it("with the morning dose taken, a pill box opened at 18:30 settles the 21:00 dose", async () => {
    const { user, medId, raw } = await twoDoses();
    const evenTake = new Date("2026-11-21T17:30:00.000Z");
    vi.setSystemTime(evenTake);
    await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medId,
        scheduledFor: MORNING,
        takenAt: new Date(MORNING.getTime() + 5 * 60_000),
        source: "WEB",
        takenVia: "APP",
      },
    });
    const res = await ingest(raw, "box-evening");
    expect(res.status).toBe(201);
    const evening = await slotRow(medId, EVENING);
    expect(evening?.takenAt?.getTime()).toBe(evenTake.getTime());
    expect(evening?.takenVia).toBe("INTEGRATION");
    expect(evening?.attributionSource).toBe("USER_PIN");
    expect(await liveRows(medId)).toHaveLength(2);
  });

  it("the per-medication route follows the same rule", async () => {
    const { medId } = await twoDoses();
    const res = await perMedPost(medId, { skipped: false });
    expect(res.status).toBe(201);
    expect((await slotRow(medId, MORNING))?.takenAt?.getTime()).toBe(
      AFTERNOON.getTime(),
    );
    expect((await slotRow(medId, EVENING))?.takenAt ?? null).toBeNull();
  });
});
