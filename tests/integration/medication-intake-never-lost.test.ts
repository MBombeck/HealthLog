/**
 * A dose the server answers 2xx for is stored, or the answer names the dose
 * already stored. Never a success over nothing.
 *
 * The per-medication route treated any row of the medication created in the
 * last sixty seconds as a double tap, and answered 200 with it. A freshly
 * projected pending row counted, so did a take undone a moment ago and a
 * take logged for two hours earlier: "Take an extra dose" right after the
 * first page load of the day, or an unnamed take whose own request projected
 * the day, answered 200 with the pending row and stored nothing. The repeat
 * check now compares the dose: a recorded take within a minute of this one,
 * of the same kind, on no slot; a repeat answers `alreadyTaken: true` with
 * that row.
 *
 * An ad-hoc dose is anchored on its own instant, and since 0515 one live row
 * holds an instant. An extra dose logged at the exact minute of a slot
 * collided with that slot's row and answered 500 (bulk: `duplicate` without
 * an id). Every ad-hoc writer now goes through one insert that moves the row
 * to the next free millisecond.
 *
 * Each case goes through the shipped route exports and checks the table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  DAY_MS,
  TZ,
  eventDelete,
  perMedPost,
  readToday,
} from "./medication-dose-state-fixtures";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => {},
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 10:00 in Berlin. The morning dose is at 08:00 (07:00Z), the evening dose
// at 19:00 (18:00Z): "now" is more than six hours from the evening slot.
const NOW = new Date("2026-11-21T09:00:00.000Z");
const MORNING = new Date("2026-11-21T07:00:00.000Z");
const EVENING = new Date("2026-11-21T18:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

let counter = 0;

async function setup(times: string[] | "prn", opts: { apple?: boolean } = {}) {
  const prisma = getPrismaClient();
  const s = `never-lost-${counter++}`;
  const user = await prisma.user.create({
    data: {
      username: s,
      email: `${s}@example.test`,
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
      asNeeded: times === "prn",
      // Dose events from Apple Health only target a mirrored medication.
      ...(opts.apple && {
        externalSource: "APPLE_HEALTH" as const,
        externalId: `hk-medication-${s}`,
      }),
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      ...(times !== "prn" && {
        schedules: {
          create: times.map((t) => ({
            windowStart: t,
            windowEnd: t,
            timesOfDay: [t],
            daysOfWeek: null,
            scheduleType: "SCHEDULED" as const,
          })),
        },
      }),
    },
  });
  return { user, medId: med.id };
}

async function liveRows(medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId, deletedAt: null },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
  });
}

async function takes(medicationId: string) {
  return (await liveRows(medicationId)).filter((r) => r.takenAt !== null);
}

interface Answer {
  status: number;
  data: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string;
    alreadyTaken?: boolean;
  };
}

async function answer(res: Response): Promise<Answer> {
  const body = (await res.json()) as { data: Answer["data"] };
  return { status: res.status, data: body.data };
}

/**
 * The invariant every case checks: a 2xx names a live row that records an
 * outcome. A 201 is a row written now; a 200 is a recorded row returned as it
 * stands.
 */
async function expectHonest(a: Answer) {
  expect([200, 201]).toContain(a.status);
  const row = await getPrismaClient().medicationIntakeEvent.findUnique({
    where: { id: a.data.id },
  });
  expect(row).not.toBeNull();
  expect(row!.deletedAt).toBeNull();
  expect(row!.takenAt !== null || row!.skipped).toBe(true);
}

describe("a take answered 2xx is stored", () => {
  it("an extra dose right after the day's first read is stored, not answered with the pending row", async () => {
    const { medId } = await setup(["19:00"]);
    // The page load projects today's pending row.
    await readToday();
    expect(await liveRows(medId)).toHaveLength(1);

    const a = await answer(
      await perMedPost(medId, {
        skipped: false,
        takenAt: NOW.toISOString(),
        extraDose: true,
      }),
    );
    expect(a.status).toBe(201);
    await expectHonest(a);
    const taken = await takes(medId);
    expect(taken).toHaveLength(1);
    expect(taken[0].attributionSource).toBe("USER_PIN");
    expect(taken[0].scheduledFor.getTime()).toBe(NOW.getTime());
    // The evening dose stays open.
    const evening = (await liveRows(medId)).find(
      (r) => r.scheduledFor.getTime() === EVENING.getTime(),
    );
    expect(evening?.takenAt).toBeNull();
  });

  it("an unnamed take whose own request projects the day is stored", async () => {
    const { medId } = await setup(["19:00"]);
    const a = await answer(await perMedPost(medId, { skipped: false }));
    expect(a.status).toBe(201);
    await expectHonest(a);
    expect(await takes(medId)).toHaveLength(1);
  });

  it("a take after one logged for two hours earlier is a dose of its own", async () => {
    const { medId } = await setup("prn");
    const earlier = new Date(NOW.getTime() - 2 * 3_600_000);
    const first = await answer(
      await perMedPost(medId, {
        skipped: false,
        takenAt: earlier.toISOString(),
      }),
    );
    expect(first.status).toBe(201);
    const second = await answer(await perMedPost(medId, { skipped: false }));
    expect(second.status).toBe(201);
    await expectHonest(second);
    expect(await takes(medId)).toHaveLength(2);
  });

  it("a take after an undo is stored, not answered with the tombstone", async () => {
    const { medId } = await setup("prn");
    const first = await answer(await perMedPost(medId, { skipped: false }));
    expect(first.status).toBe(201);
    expect((await eventDelete(medId, first.data.id)).status).toBeLessThan(300);
    expect(await takes(medId)).toHaveLength(0);

    const again = await answer(await perMedPost(medId, { skipped: false }));
    expect(again.status).toBe(201);
    await expectHonest(again);
    expect(again.data.id).not.toBe(first.data.id);
    expect(await takes(medId)).toHaveLength(1);
  });

  it("a double tap is one dose, and the second answer says so", async () => {
    const { medId } = await setup("prn");
    const first = await answer(await perMedPost(medId, { skipped: false }));
    expect(first.status).toBe(201);
    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    const second = await answer(await perMedPost(medId, { skipped: false }));
    expect(second.status).toBe(200);
    expect(second.data).toMatchObject({
      id: first.data.id,
      alreadyTaken: true,
    });
    await expectHonest(second);
    expect(await takes(medId)).toHaveLength(1);
  });

  it("an extra dose is not a repeat of a plain take a moment earlier", async () => {
    const { medId } = await setup(["19:00"]);
    const plain = await answer(await perMedPost(medId, { skipped: false }));
    expect(plain.status).toBe(201);
    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    const extra = await answer(
      await perMedPost(medId, {
        skipped: false,
        takenAt: new Date().toISOString(),
        extraDose: true,
      }),
    );
    expect(extra.status).toBe(201);
    await expectHonest(extra);
    expect(await takes(medId)).toHaveLength(2);
  });

  it("a skip tapped twice is one skip, answered with the stored skip", async () => {
    const { medId } = await setup("prn");
    const first = await answer(await perMedPost(medId, { skipped: true }));
    expect(first.status).toBe(201);
    const second = await answer(await perMedPost(medId, { skipped: true }));
    expect(second.status).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    await expectHonest(second);
  });
});

describe("an ad-hoc dose on the exact instant of a slot", () => {
  async function takeMorning(medId: string) {
    const a = await answer(
      await perMedPost(medId, {
        skipped: false,
        scheduledFor: MORNING.toISOString(),
        takenAt: new Date(MORNING.getTime() + 5 * 60_000).toISOString(),
        idempotencyKey: "morning-take",
      }),
    );
    expect(a.status).toBe(201);
    expect(new Date(a.data.scheduledFor).getTime()).toBe(MORNING.getTime());
    return a;
  }

  it("an extra dose at the minute of a taken slot is its own row, not a 500", async () => {
    const { medId } = await setup(["08:00", "19:00"]);
    const morning = await takeMorning(medId);
    const a = await answer(
      await perMedPost(medId, {
        skipped: false,
        takenAt: MORNING.toISOString(),
        extraDose: true,
      }),
    );
    expect(a.status).toBe(201);
    await expectHonest(a);
    expect(a.data.id).not.toBe(morning.data.id);
    const extra = (await takes(medId)).find((r) => r.id === a.data.id)!;
    // One millisecond after the slot, and still its own instant.
    expect(extra.scheduledFor.getTime()).toBe(MORNING.getTime() + 1);
    expect(extra.takenAt!.getTime()).toBe(extra.scheduledFor.getTime());
    expect(extra.attributionSource).toBe("USER_PIN");
    // The slot keeps its own take.
    const slot = (await liveRows(medId)).find((r) => r.id === morning.data.id);
    expect(slot?.scheduledFor.getTime()).toBe(MORNING.getTime());
    expect(await takes(medId)).toHaveLength(2);
  });

  it("an extra dose at the minute of an open slot leaves the slot open", async () => {
    const { medId } = await setup(["08:00", "19:00"]);
    await readToday();
    const a = await answer(
      await perMedPost(medId, {
        skipped: false,
        takenAt: MORNING.toISOString(),
        extraDose: true,
      }),
    );
    expect(a.status).toBe(201);
    await expectHonest(a);
    const slot = (await liveRows(medId)).find(
      (r) => r.scheduledFor.getTime() === MORNING.getTime(),
    );
    expect(slot?.takenAt).toBeNull();
    expect(slot?.id).not.toBe(a.data.id);
  });

  it("two Apple Health doses on the same minute both land with their ids", async () => {
    // Two dose events of one as-needed medication logged for 08:00: two
    // pills, two records. The second used to collide with the first row's
    // instant and answer `duplicate` without an id, and was gone.
    const { medId } = await setup("prn", { apple: true });
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const entry = (n: number) => ({
      medicationId: medId,
      scheduledFor: MORNING.toISOString(),
      takenAt: MORNING.toISOString(),
      skipped: false,
      externalId: `hk-dose-${n}`,
      source: "APPLE_HEALTH",
      idempotencyKey: `hk-dose-${n}`,
    });
    const res = await (
      POST as unknown as (r: NextRequest) => Promise<Response>
    )(
      new NextRequest("http://localhost/api/medications/intake/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [entry(1), entry(2)] }),
      }),
    );
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string; id?: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "inserted",
      "inserted",
    ]);
    const ids = body.data.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    const rows = await takes(medId);
    expect(rows.map((r) => r.externalId).sort()).toEqual([
      "hk-dose-1",
      "hk-dose-2",
    ]);
    expect(rows.map((r) => r.scheduledFor.getTime())).toEqual([
      MORNING.getTime(),
      MORNING.getTime() + 1,
    ]);
  });

  it("every ad-hoc writer moves to the next free millisecond", async () => {
    const { user, medId } = await setup("prn");
    const { createAdHocIntake } =
      await import("@/lib/medications/ad-hoc-intake");
    const prisma = getPrismaClient();
    const write = () =>
      createAdHocIntake(prisma, {
        userId: user.id,
        medicationId: medId,
        scheduledFor: MORNING,
        takenAt: MORNING,
        skipped: false,
        source: "REMINDER",
        takenVia: "TELEGRAM",
      });
    const a = await write();
    const b = await prisma.$transaction((tx) =>
      createAdHocIntake(tx, {
        userId: user.id,
        medicationId: medId,
        scheduledFor: MORNING,
        takenAt: MORNING,
        skipped: false,
        source: "REMINDER",
        takenVia: "TELEGRAM",
      }),
    );
    const c = await write();
    expect(a.scheduledFor.getTime()).toBe(MORNING.getTime());
    expect(b.scheduledFor.getTime()).toBe(MORNING.getTime() + 1);
    expect(c.scheduledFor.getTime()).toBe(MORNING.getTime() + 2);
    for (const row of [a, b, c]) {
      expect(row.takenAt!.getTime()).toBe(row.scheduledFor.getTime());
    }
    // A skip keeps no take time and moves only its anchor.
    const skip = await createAdHocIntake(prisma, {
      userId: user.id,
      medicationId: medId,
      scheduledFor: MORNING,
      takenAt: null,
      skipped: true,
      source: "REMINDER",
    });
    expect(skip.scheduledFor.getTime()).toBe(MORNING.getTime() + 3);
    expect(skip.takenAt).toBeNull();
  });
});
