/**
 * An extra (off-schedule) dose recorded in Apple Health must arrive as its own
 * unscheduled dose.
 *
 * The phone posts every HealthKit dose event to the bulk route with the
 * event's UUID as `externalId`, `scheduledFor` set to the event's scheduled
 * date or, for an extra dose that has none, its own time. A taken write binds
 * to a slot by window band, and a weekly schedule's band reaches a day either
 * side of its slot. An extra dose on the Wednesday after a Tuesday dose
 * therefore landed on the Tuesday slot and overwrote it: the Tuesday time was
 * replaced by the Wednesday one and the extra dose existed nowhere.
 *
 * Three shapes, each through the shipped `POST` and `GET` exports: an extra
 * dose far from any slot, one half an hour after a slot already taken, and one
 * on a day the schedule has no slot. Each asserts the stored rows AND the dose
 * history the app reads back, where the extra dose must show as off-schedule
 * and the slot keep its own dose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import { localHmAsUtc } from "@/lib/tz/local-day";

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

const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN = 60_000;

let counter = 0;

async function signedInUser(): Promise<string> {
  const prisma = getPrismaClient();
  const suffix = `extra-dose-${counter++}`;
  const user = await prisma.user.create({
    data: {
      username: suffix,
      email: `${suffix}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

async function seedMedication(
  userId: string,
  schedule: { timesOfDay: string[]; daysOfWeek: string | null },
): Promise<string> {
  const med = await getPrismaClient().medication.create({
    data: {
      userId,
      name: "Magnesium",
      dose: "400mg",
      active: true,
      // Dose events from Apple Health only target a mirrored medication.
      externalSource: "APPLE_HEALTH",
      externalId: `hk-medication-${userId}`,
      startsOn: new Date(Date.now() - 60 * DAY_MS),
      // The ledger expects slots only from the medication's creation on.
      createdAt: new Date(Date.now() - 60 * DAY_MS),
      schedules: {
        create: {
          windowStart: schedule.timesOfDay[0],
          windowEnd: schedule.timesOfDay[0],
          timesOfDay: schedule.timesOfDay,
          daysOfWeek: schedule.daysOfWeek,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return med.id;
}

/** A local day at least two weeks back with the given weekday (0 = Sunday). */
function pastLocalDay(weekday: number): Date {
  const day = new Date(Date.now() - 21 * DAY_MS);
  day.setUTCHours(12, 0, 0, 0);
  while (day.getUTCDay() !== weekday) {
    day.setTime(day.getTime() - DAY_MS);
  }
  return day;
}

interface BulkEntry {
  medicationId: string;
  scheduledFor: string;
  takenAt: string;
  externalId: string;
}

/** The phone's shape: one HealthKit dose event per entry. */
function appleDose(
  medicationId: string,
  takenAt: Date,
  externalId: string,
  scheduledFor: Date = takenAt,
): BulkEntry {
  return {
    medicationId,
    scheduledFor: scheduledFor.toISOString(),
    takenAt: takenAt.toISOString(),
    externalId,
  };
}

async function postBulk(entries: BulkEntry[]) {
  const { POST } = await import("@/app/api/medications/intake/bulk/route");
  const response = await POST(
    new NextRequest("http://localhost/api/medications/intake/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: entries.map((entry) => ({
          ...entry,
          source: "APPLE_HEALTH",
        })),
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { entries: Array<{ status: string; id?: string }> };
  };
  return body.data.entries;
}

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

interface LedgerRow {
  kind: "slot" | "ad_hoc";
  at: string;
  status: string;
  intake: { id: string | null; takenAt: string | null } | null;
}

async function readLedger(
  medicationId: string,
  from: Date,
  to: Date,
): Promise<LedgerRow[]> {
  const { GET } = await import("@/app/api/medications/[id]/dose-history/route");
  const search = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const response = await (GET as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medicationId}/dose-history?${search}`,
      { method: "GET" },
    ),
    { params: Promise.resolve({ id: medicationId }) },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { rows: LedgerRow[] } };
  return body.data.rows;
}

async function rowsOf(medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId, deletedAt: null },
    orderBy: { takenAt: "asc" },
  });
}

function takenAtOf(row: LedgerRow | undefined): number | null {
  const taken = row?.intake?.takenAt;
  return taken ? new Date(taken).getTime() : null;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("an extra dose from Apple Health is stored as an unscheduled dose", () => {
  it("(a) far from any slot", async () => {
    const userId = await signedInUser();
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["08:00"],
      daysOfWeek: null,
    });
    const day = pastLocalDay(3);
    const slot = localHmAsUtc(day, TZ, 8, 0);
    const extraAt = localHmAsUtc(day, TZ, 15, 0);

    const results = await postBulk([
      appleDose(medicationId, new Date(slot.getTime() + 5 * MIN), "hk-a-1"),
      appleDose(medicationId, extraAt, "hk-a-2"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["inserted", "inserted"]);

    const rows = await rowsOf(medicationId);
    expect(rows).toHaveLength(2);
    const extra = rows.find((row) => row.externalId === "hk-a-2");
    expect(extra?.takenAt?.getTime()).toBe(extraAt.getTime());
    expect(extra?.scheduledFor.getTime()).toBe(extraAt.getTime());

    const ledger = await readLedger(
      medicationId,
      new Date(slot.getTime() - 6 * 3_600_000),
      new Date(slot.getTime() + 18 * 3_600_000),
    );
    const adHoc = ledger.filter((row) => row.kind === "ad_hoc");
    expect(adHoc).toHaveLength(1);
    expect(takenAtOf(adHoc[0])).toBe(extraAt.getTime());
    const slotRow = ledger.find((row) => row.kind === "slot");
    expect(slotRow?.status).toBe("taken_on_time");
  });

  it("(b) 30 minutes after a slot already taken", async () => {
    const userId = await signedInUser();
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["22:00"],
      daysOfWeek: null,
    });
    const day = pastLocalDay(2);
    const slot = localHmAsUtc(day, TZ, 22, 0);
    const ownAt = new Date(slot.getTime() + 2 * MIN);
    const extraAt = new Date(slot.getTime() + 30 * MIN);

    // The slot's own dose first, then the extra one in a later sync.
    expect(
      (await postBulk([appleDose(medicationId, ownAt, "hk-b-1", slot)])).map(
        (r) => r.status,
      ),
    ).toEqual(["inserted"]);
    expect(
      (await postBulk([appleDose(medicationId, extraAt, "hk-b-2")])).map(
        (r) => r.status,
      ),
    ).toEqual(["inserted"]);

    const rows = await rowsOf(medicationId);
    expect(rows).toHaveLength(2);
    const own = rows.find((row) => row.externalId === "hk-b-1");
    const extra = rows.find((row) => row.externalId === "hk-b-2");
    // The slot keeps its own dose, time unchanged.
    expect(own?.scheduledFor.getTime()).toBe(slot.getTime());
    expect(own?.takenAt?.getTime()).toBe(ownAt.getTime());
    // The extra dose sits on its own instant.
    expect(extra?.scheduledFor.getTime()).toBe(extraAt.getTime());
    expect(extra?.takenAt?.getTime()).toBe(extraAt.getTime());

    const ledger = await readLedger(
      medicationId,
      new Date(slot.getTime() - 6 * 3_600_000),
      new Date(slot.getTime() + 6 * 3_600_000),
    );
    const slotRow = ledger.find((row) => row.kind === "slot");
    expect(slotRow?.status).toBe("taken_on_time");
    expect(takenAtOf(slotRow)).toBe(ownAt.getTime());
    const adHoc = ledger.filter((row) => row.kind === "ad_hoc");
    expect(adHoc).toHaveLength(1);
    expect(takenAtOf(adHoc[0])).toBe(extraAt.getTime());
  });

  it("(b2) a re-sync of the same dose event stays one dose", async () => {
    const userId = await signedInUser();
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["22:00"],
      daysOfWeek: null,
    });
    const slot = localHmAsUtc(pastLocalDay(2), TZ, 22, 0);
    const ownAt = new Date(slot.getTime() + 2 * MIN);

    await postBulk([appleDose(medicationId, ownAt, "hk-b2-1", slot)]);
    const again = await postBulk([
      appleDose(medicationId, ownAt, "hk-b2-1", slot),
    ]);
    expect(again.map((r) => r.status)).toEqual(["duplicate"]);
    expect(await rowsOf(medicationId)).toHaveLength(1);
  });

  it("(c) on a day without a slot, next to the weekly slot the day before", async () => {
    const userId = await signedInUser();
    // Tuesdays and Fridays at 22:00.
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["22:00"],
      daysOfWeek: "2,5",
    });
    const tuesday = pastLocalDay(2);
    const wednesday = new Date(tuesday.getTime() + DAY_MS);
    const tuesdaySlot = localHmAsUtc(tuesday, TZ, 22, 0);
    const tuesdayDose = localHmAsUtc(tuesday, TZ, 20, 23);
    const wednesdayDose = localHmAsUtc(wednesday, TZ, 20, 45);

    await postBulk([appleDose(medicationId, tuesdayDose, "hk-c-tue")]);
    const results = await postBulk([
      appleDose(medicationId, wednesdayDose, "hk-c-wed"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["inserted"]);

    const rows = await rowsOf(medicationId);
    expect(rows).toHaveLength(2);
    const tue = rows.find((row) => row.externalId === "hk-c-tue");
    const wed = rows.find((row) => row.externalId === "hk-c-wed");
    // Tuesday keeps its own time.
    expect(tue?.scheduledFor.getTime()).toBe(tuesdaySlot.getTime());
    expect(tue?.takenAt?.getTime()).toBe(tuesdayDose.getTime());
    // Wednesday is its own unscheduled dose.
    expect(wed?.scheduledFor.getTime()).toBe(wednesdayDose.getTime());
    expect(wed?.takenAt?.getTime()).toBe(wednesdayDose.getTime());

    const ledger = await readLedger(
      medicationId,
      new Date(tuesday.getTime() - 2 * DAY_MS),
      new Date(tuesday.getTime() + 2 * DAY_MS),
    );
    const tuesdayRow = ledger.find(
      (row) =>
        row.kind === "slot" &&
        new Date(row.at).getTime() === tuesdaySlot.getTime(),
    );
    expect(takenAtOf(tuesdayRow)).toBe(tuesdayDose.getTime());
    const adHoc = ledger.filter((row) => row.kind === "ad_hoc");
    expect(adHoc.map(takenAtOf)).toEqual([wednesdayDose.getTime()]);
  });
});

/** Stock the medication with one open bottle of 100 units, one per dose. */
async function stock(userId: string, medicationId: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.medication.update({
    where: { id: medicationId },
    data: { unitsPerDose: 1 },
  });
  await prisma.medicationInventoryItem.create({
    data: {
      userId,
      medicationId,
      state: "IN_USE",
      containerType: "BOTTLE",
      unitsTotal: 100,
      unitsRemaining: 100,
      firstUseAt: new Date(Date.now() - 60 * DAY_MS),
    },
  });
}

async function unitsRemaining(medicationId: string): Promise<number> {
  const item = await getPrismaClient().medicationInventoryItem.findFirstOrThrow(
    { where: { medicationId } },
  );
  return Number(item.unitsRemaining);
}

/** A take tapped in HealthLog: no external record, no Apple provenance. */
async function postAppTap(medicationId: string, slot: Date, takenAt: Date) {
  const { POST } = await import("@/app/api/medications/intake/bulk/route");
  const response = await POST(
    new NextRequest("http://localhost/api/medications/intake/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            medicationId,
            scheduledFor: slot.toISOString(),
            takenAt: takenAt.toISOString(),
          },
        ],
      }),
    }),
  );
  expect(response.status).toBe(200);
}

describe("the same dose recorded twice is one dose", () => {
  it("(d) a tap in HealthLog at 08:00 and the dose in Health at 08:20 the same day", async () => {
    const userId = await signedInUser();
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["08:00"],
      daysOfWeek: null,
    });
    await stock(userId, medicationId);
    const day = pastLocalDay(4);
    const slot = localHmAsUtc(day, TZ, 8, 0);
    const tapAt = slot;
    const appleAt = new Date(slot.getTime() + 20 * MIN);

    await postAppTap(medicationId, slot, tapAt);
    expect(await unitsRemaining(medicationId)).toBe(99);
    // Health sends it as the slot's scheduled dose, and once more as an
    // unscheduled one: either way it is the tapped dose.
    for (const [externalId, scheduledFor] of [
      ["hk-d-1", slot],
      ["hk-d-2", appleAt],
    ] as const) {
      const results = await postBulk([
        appleDose(medicationId, appleAt, externalId, scheduledFor),
      ]);
      expect(results.map((r) => r.status)).toEqual(["updated"]);
    }

    const rows = await rowsOf(medicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scheduledFor.getTime()).toBe(slot.getTime());
    // One dose, one unit off the bottle.
    expect(await unitsRemaining(medicationId)).toBe(99);
    const ledger = await readLedger(
      medicationId,
      new Date(slot.getTime() - 6 * 3_600_000),
      new Date(slot.getTime() + 6 * 3_600_000),
    );
    expect(ledger.filter((row) => row.kind === "ad_hoc")).toHaveLength(0);
  });

  it("(e) a dose edited in Health: a new record, moved by 30 minutes, inside the same slot", async () => {
    const userId = await signedInUser();
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["22:00"],
      daysOfWeek: null,
    });
    await stock(userId, medicationId);
    const slot = localHmAsUtc(pastLocalDay(2), TZ, 22, 0);
    const firstAt = new Date(slot.getTime() + 2 * MIN);
    const editedAt = new Date(slot.getTime() + 32 * MIN);

    await postBulk([appleDose(medicationId, firstAt, "hk-e-1", slot)]);
    // Health replaces an edited dose with a new record; it still names the
    // slot as its scheduled time.
    const results = await postBulk([
      appleDose(medicationId, editedAt, "hk-e-2", slot),
    ]);
    expect(results.map((r) => r.status)).toEqual(["updated"]);

    const rows = await rowsOf(medicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe("hk-e-2");
    expect(rows[0]!.takenAt?.getTime()).toBe(editedAt.getTime());
    expect(rows[0]!.scheduledFor.getTime()).toBe(slot.getTime());
    expect(await unitsRemaining(medicationId)).toBe(99);
  });

  it("(f) an extra dose the next day still stays its own dose, consuming its own unit", async () => {
    const userId = await signedInUser();
    const medicationId = await seedMedication(userId, {
      timesOfDay: ["22:00"],
      daysOfWeek: "2,5",
    });
    await stock(userId, medicationId);
    const tuesday = pastLocalDay(2);
    const tuesdaySlot = localHmAsUtc(tuesday, TZ, 22, 0);
    const wednesdayDose = localHmAsUtc(
      new Date(tuesday.getTime() + DAY_MS),
      TZ,
      20,
      45,
    );

    await postAppTap(medicationId, tuesdaySlot, tuesdaySlot);
    const results = await postBulk([
      appleDose(medicationId, wednesdayDose, "hk-f-wed"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["inserted"]);
    expect(await rowsOf(medicationId)).toHaveLength(2);
    expect(await unitsRemaining(medicationId)).toBe(98);
  });
});
