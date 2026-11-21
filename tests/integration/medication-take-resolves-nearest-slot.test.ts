/**
 * A take outside every dose window still answers its dose, and a dose
 * reported twice is recorded once.
 *
 * A pill box posts to the ingest hook when it is opened. Opened three hours
 * before the slot, the take matched no band and landed ad hoc: the slot stayed
 * open, the phone kept asking for the dose, and a second dose was one tap
 * away. Now the take answers the nearest open slot of the day (within six
 * hours), the today list says when and through which source it was taken, the
 * paired devices are woken, and a second report within two hours answers
 * `alreadyTaken: true` without writing.
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

// 10:00 in Berlin; the dose is due at 13:00.
const NOW = new Date("2026-11-21T09:00:00.000Z");
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

describe("a take outside every window answers the nearest open slot", () => {
  it("a pill box opened three hours early closes the slot, and a second report is the same dose", async () => {
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
