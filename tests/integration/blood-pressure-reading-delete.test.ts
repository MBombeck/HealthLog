/**
 * Deleting one row of a blood-pressure reading deletes the reading, through
 * the real routes against a real Postgres.
 *
 * Systolic, diastolic and the cuff's pulse are three rows with no link
 * column; they are one reading because every writer stores them with the
 * same source at the same instant. Deleting the systolic used to tombstone
 * only the systolic and leave a diastolic and a pulse behind. Now the
 * single DELETE and the bulk delete take the whole reading, every row bumps
 * its own syncVersion (so the sync feed carries each tombstone), and the
 * undo, which names only the row the person tapped, brings the whole
 * reading back. A reading of another source at the same instant, a reading
 * a minute later, and a pulse deleted on its own are left alone.
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

const USER = "user-bp-reading-delete";
const AT = new Date("2026-10-20T07:30:00.000Z");
const MINUTE_LATER = new Date(AT.getTime() + 60_000);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: USER,
      username: "bp-reading-delete",
      email: "bp-reading-delete@example.test",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  const row = (
    id: string,
    type: "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA" | "PULSE",
    value: number,
    source: "MANUAL" | "WITHINGS",
    measuredAt: Date,
  ) => ({
    id,
    userId: USER,
    type,
    value,
    unit: type === "PULSE" ? "bpm" : "mmHg",
    source,
    measuredAt,
  });
  await prisma.measurement.createMany({
    data: [
      // The reading under test.
      row("sys", "BLOOD_PRESSURE_SYS", 128, "MANUAL", AT),
      row("dia", "BLOOD_PRESSURE_DIA", 82, "MANUAL", AT),
      row("pulse", "PULSE", 64, "MANUAL", AT),
      // The same instant from another source: another reading.
      row("w-sys", "BLOOD_PRESSURE_SYS", 131, "WITHINGS", AT),
      row("w-dia", "BLOOD_PRESSURE_DIA", 84, "WITHINGS", AT),
      // A minute later from the same source: another reading.
      row("next-sys", "BLOOD_PRESSURE_SYS", 125, "MANUAL", MINUTE_LATER),
      row("next-dia", "BLOOD_PRESSURE_DIA", 80, "MANUAL", MINUTE_LATER),
      row("next-pulse", "PULSE", 62, "MANUAL", MINUTE_LATER),
    ],
  });
});

async function rows(): Promise<
  Record<string, { deleted: boolean; syncVersion: number }>
> {
  const all = await getPrismaClient().measurement.findMany({
    where: { userId: USER },
    select: { id: true, deletedAt: true, syncVersion: true },
  });
  return Object.fromEntries(
    all.map((r) => [
      r.id,
      { deleted: r.deletedAt !== null, syncVersion: r.syncVersion },
    ]),
  );
}

const deletedIds = async () =>
  Object.entries(await rows())
    .filter(([, r]) => r.deleted)
    .map(([id]) => id)
    .sort();

async function deleteOne(id: string) {
  const { DELETE } = await import("@/app/api/measurements/[id]/route");
  const res = await DELETE(
    new NextRequest(`http://localhost/api/measurements/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(200);
}

async function post(path: "bulk-delete" | "restore", ids: string[]) {
  const route =
    path === "bulk-delete"
      ? await import("@/app/api/measurements/bulk-delete/route")
      : await import("@/app/api/measurements/restore/route");
  const res = await route.POST(
    new NextRequest(`http://localhost/api/measurements/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as { deleted?: number; restored?: number };
}

describe("deleting a blood-pressure reading", () => {
  it("takes the other half and the pulse with the systolic, and the undo brings all three back", async () => {
    await deleteOne("sys");

    expect(await deletedIds()).toEqual(["dia", "pulse", "sys"]);
    const after = await rows();
    for (const id of ["sys", "dia", "pulse"]) {
      expect(after[id]!.syncVersion).toBe(2);
    }
    for (const id of ["w-sys", "w-dia", "next-sys", "next-dia"]) {
      expect(after[id]!.syncVersion).toBe(1);
    }

    // The undo names only the row that was tapped.
    const { restored } = await post("restore", ["sys"]);
    expect(restored).toBe(3);
    expect(await deletedIds()).toEqual([]);
  });

  it("takes the systolic and the pulse with the diastolic", async () => {
    await deleteOne("dia");
    expect(await deletedIds()).toEqual(["dia", "pulse", "sys"]);
  });

  it("deletes a pulse on its own, and its undo leaves the reading as it was", async () => {
    await deleteOne("pulse");
    expect(await deletedIds()).toEqual(["pulse"]);
    await post("restore", ["pulse"]);
    expect(await deletedIds()).toEqual([]);
  });

  it("does the same for the bulk delete, and restores only what went in the same delete", async () => {
    // The pulse of the second reading was deleted on its own earlier.
    await deleteOne("next-pulse");

    const { deleted } = await post("bulk-delete", ["sys", "next-dia"]);
    expect(deleted).toBe(5);
    expect(await deletedIds()).toEqual([
      "dia",
      "next-dia",
      "next-pulse",
      "next-sys",
      "pulse",
      "sys",
    ]);

    const { restored } = await post("restore", ["sys", "next-dia"]);
    expect(restored).toBe(5);
    // The pulse deleted at another moment stays deleted.
    expect(await deletedIds()).toEqual(["next-pulse"]);
  });
});
