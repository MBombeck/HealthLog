/**
 * An Apple Health dose takes its stock once, whatever happens to it
 * (iOS #191), against real Postgres.
 *
 * The iPhone app posts a HealthKit dose event through
 * `POST /api/medications/intake/bulk` with its UUID as `externalId`, and may
 * post it again at any time: an outbox that had not drained, a fresh install
 * or a second device reading the whole history, two syncs racing. The
 * invariant held after every step below: the stock consumed equals the
 * number of live taken doses that carry a dose-event id. So no path takes
 * the stock of one dose twice, and none keeps the stock of a dose that is
 * gone.
 *
 *   - A replay of a live dose is `duplicate` and takes nothing.
 *   - Two posts of a new dose racing land one row and one consumption.
 *   - A dose the person deleted in HealthLog is refunded, and its re-post is
 *     `skipped`, reason `deleted_in_healthlog`, and takes nothing, also when
 *     the dose had landed on a pre-minted slot row (whose `source` stays
 *     `REMINDER`).
 *   - A dose the phone reported deleted in Apple Health is refunded, also on
 *     a slot row, and its re-post lands again and takes its stock again.
 *   - The intake tombstones on `GET /api/sync/changes` name the dose event.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const USER = "user-intake-stock-once";
const STOCK = 30;
const DAY_MS = 86_400_000;
/** Yesterday, 08:00 UTC: the slot of the 08:00 schedule. */
const SLOT = new Date(
  Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS + 8 * 3_600_000,
);
const prisma = () => getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma());
  cookieJar.clear();
  headerJar.clear();
  await prisma().user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "UTC",
    },
  });
  const session = await prisma().session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function medication(): Promise<string> {
  const startedAt = new Date(SLOT.getTime() - 30 * DAY_MS);
  const med = await prisma().medication.create({
    data: {
      userId: USER,
      name: "Ramipril",
      dose: "5 mg",
      externalSource: "APPLE_HEALTH",
      createdAt: startedAt,
      schedules: {
        create: [
          { windowStart: "08:00", windowEnd: "10:00", timesOfDay: ["08:00"] },
        ],
      },
    },
    select: { id: true },
  });
  await prisma().medicationInventoryItem.create({
    data: {
      userId: USER,
      medicationId: med.id,
      state: "ACTIVE",
      unitsTotal: STOCK,
      unitsRemaining: STOCK,
    },
  });
  return med.id;
}

async function consumed(medicationId: string): Promise<number> {
  const items = await prisma().medicationInventoryItem.findMany({
    where: { medicationId },
    select: { unitsRemaining: true },
  });
  return STOCK - items.reduce((sum, i) => sum + Number(i.unitsRemaining), 0);
}

/** The invariant: stock consumed = live taken Apple Health doses. */
async function expectStockMatchesDoses(medicationId: string): Promise<number> {
  const live = await prisma().medicationIntakeEvent.count({
    where: {
      medicationId,
      deletedAt: null,
      takenAt: { not: null },
      skipped: false,
      externalId: { not: null },
    },
  });
  expect(await consumed(medicationId)).toBe(live);
  return live;
}

function dose(medicationId: string, externalId: string, takenAt: Date) {
  return {
    medicationId,
    takenAt: takenAt.toISOString(),
    source: "APPLE_HEALTH",
    externalId,
  };
}

async function send(
  entries: unknown[],
): Promise<Array<[string, string | undefined]>> {
  const { POST } = await import("@/app/api/medications/intake/bulk/route");
  const res = await POST(
    new NextRequest("http://localhost/api/medications/intake/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  const body = (await res.json()) as {
    data: { entries: Array<{ status: string; reason?: string }> };
  };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.data.entries.map((e) => [e.status, e.reason]);
}

async function rowOf(externalId: string) {
  return prisma().medicationIntakeEvent.findFirstOrThrow({
    where: { userId: USER, externalId, deletedAt: null },
    select: { id: true, source: true },
  });
}

/** Deleted the way the web and the app delete one dose. */
async function deleteInHealthLog(medicationId: string, eventId: string) {
  const { DELETE } =
    await import("@/app/api/medications/[id]/intake/[eventId]/route");
  const res = await DELETE(
    new NextRequest(
      `http://localhost/api/medications/${medicationId}/intake/${eventId}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: medicationId, eventId }) },
  );
  expect(res.status).toBeLessThan(300);
}

/** Reported deleted by the phone. */
async function deleteInAppleHealth(externalIds: string[]): Promise<number> {
  const { DELETE } =
    await import("@/app/api/medications/intake/by-external-ids/route");
  const res = await DELETE(
    new NextRequest("http://localhost/api/medications/intake/by-external-ids", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalIds }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { deletedCount: number } }).data
    .deletedCount;
}

describe("stock for an Apple Health dose", () => {
  it("is taken once through replays, races and both kinds of deletion", async () => {
    const med = await medication();
    // Off the schedule's band, so each dose is its own row.
    const atX = new Date(SLOT.getTime() + 6 * 3_600_000);
    const atY = new Date(SLOT.getTime() + 8 * 3_600_000);

    expect(await send([dose(med, "X", atX)])).toEqual([
      ["inserted", undefined],
    ]);
    expect(await expectStockMatchesDoses(med)).toBe(1);

    // A replay of a live dose.
    expect(await send([dose(med, "X", atX)])).toEqual([
      ["duplicate", undefined],
    ]);
    // The same id twice in one batch.
    const y = dose(med, "Y", atY);
    const raced = await Promise.all([send([y, y]), send([y])]);
    expect(
      raced
        .flat()
        .filter(([status]) => status === "inserted")
        .map(([status]) => status),
    ).toEqual(["inserted"]);
    expect(await expectStockMatchesDoses(med)).toBe(2);

    // Deleted in HealthLog: refunded, and the re-post takes nothing.
    await deleteInHealthLog(med, (await rowOf("X")).id);
    expect(await expectStockMatchesDoses(med)).toBe(1);
    expect(await send([dose(med, "X", atX)])).toEqual([
      ["skipped", "deleted_in_healthlog"],
    ]);
    expect(await expectStockMatchesDoses(med)).toBe(1);

    // Deleted in Apple Health: refunded, and back in HealthKit it lands and
    // takes its stock again, once.
    expect(await deleteInAppleHealth(["Y"])).toBe(1);
    expect(await expectStockMatchesDoses(med)).toBe(0);
    expect(await send([y])).toEqual([["inserted", undefined]]);
    expect(await send([y])).toEqual([["duplicate", undefined]]);
    expect(await expectStockMatchesDoses(med)).toBe(1);
  });

  it("is taken once for a dose that landed on a pre-minted slot row", async () => {
    const med = await medication();
    const pending = () =>
      prisma().medicationIntakeEvent.create({
        data: {
          userId: USER,
          medicationId: med,
          scheduledFor: SLOT,
          source: "REMINDER",
        },
        select: { id: true },
      });
    const slotRow = await pending();
    const takenAt = new Date(SLOT.getTime() + 10 * 60_000);

    expect(await send([dose(med, "W", takenAt)])).toEqual([
      ["updated", undefined],
    ]);
    // The slot row took the dose and its id, and keeps its own source.
    expect(await rowOf("W")).toEqual({ id: slotRow.id, source: "REMINDER" });
    expect(await expectStockMatchesDoses(med)).toBe(1);

    // The phone reports it deleted in Apple Health: found by its id
    // although the row is not `APPLE_HEALTH`, and refunded.
    expect(await deleteInAppleHealth(["W"])).toBe(1);
    expect(await expectStockMatchesDoses(med)).toBe(0);

    // Back in HealthKit: it lands again, once.
    const [[status]] = await send([dose(med, "W", takenAt)]);
    expect(["inserted", "updated"]).toContain(status);
    expect(await expectStockMatchesDoses(med)).toBe(1);

    // The person deletes it in HealthLog: refunded, and the re-post stays
    // out, whichever row it had landed on.
    await deleteInHealthLog(med, (await rowOf("W")).id);
    expect(await expectStockMatchesDoses(med)).toBe(0);
    expect(await send([dose(med, "W", takenAt)])).toEqual([
      ["skipped", "deleted_in_healthlog"],
    ]);
    expect(await expectStockMatchesDoses(med)).toBe(0);

    // The sync feed names the dose event on its tombstones.
    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(
      new NextRequest("http://localhost/api/sync/changes", { method: "GET" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        changes: {
          intakes: {
            tombstones: Array<{ externalId: string | null; source: string }>;
          };
        };
      };
    };
    const tombstones = body.data.changes.intakes.tombstones;
    expect(tombstones.length).toBeGreaterThanOrEqual(2);
    expect(tombstones.every((t) => t.externalId === "W")).toBe(true);
    expect(tombstones.map((t) => t.source)).toContain("REMINDER");
  });
});
