/**
 * A target the person sets on `/targets` reaches the dashboard's chart bands.
 *
 * The snapshot resolved the blood-pressure, resting-pulse and body-fat bands
 * from the profile alone (age, sex) and took only the weight target into
 * account, so the zones under the blood-pressure chart stayed on the age
 * default after the person had entered their own band. The resolved bands
 * are what the web dashboard draws and what a native client reads, so the
 * proof runs through the real routes: write the target through
 * `PUT /api/user/thresholds`, read `GET /api/dashboard/snapshot` back from
 * the same Postgres, with the snapshot's cache cell in between.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUser(): Promise<void> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "own-target-bands",
      email: "own-target-bands@example.test",
      role: "USER",
      timezone: "Europe/Berlin",
      dateOfBirth: new Date("1960-03-01T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 178,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60 * 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

interface Bands {
  bpTargets: {
    sysLow: number;
    sysHigh: number;
    diaLow: number;
    diaHigh: number;
  } | null;
  pulseDisplayRange: { greenMin: number; greenMax: number };
  bodyFatRange: { min: number; max: number };
}

async function readBands(): Promise<Bands> {
  const { GET } = await import("@/app/api/dashboard/snapshot/route");
  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { targetBands: Bands } };
  return body.data.targetBands;
}

async function putTargets(payload: unknown): Promise<void> {
  const { PUT } = await import("@/app/api/user/thresholds/route");
  const res = await PUT(
    new NextRequest("http://localhost/api/user/thresholds", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  expect(res.status).toBe(200);
}

describe("dashboard bands follow the person's own targets (real Postgres)", () => {
  it("replaces the age default once a target is saved", async () => {
    await seedUser();

    const before = await readBands();
    // The premise: an age default exists and differs from the target below.
    expect(before.bpTargets).not.toBeNull();
    expect(before.bpTargets?.sysHigh).not.toBe(150);

    await putTargets({
      BLOOD_PRESSURE_SYS: { min: 120, max: 150 },
      BLOOD_PRESSURE_DIA: { min: 75, max: 95 },
      PULSE: { min: 48, max: 58 },
      BODY_FAT: { min: 12, max: 16 },
    });

    // Read again: the save evicts the cached snapshot, so this is a rebuild
    // against the stored blob, not the cell from the first read.
    const after = await readBands();
    expect(after.bpTargets).toEqual({
      sysLow: 120,
      sysHigh: 150,
      diaLow: 75,
      diaHigh: 95,
    });
    expect(after.pulseDisplayRange).toEqual(
      expect.objectContaining({ greenMin: 48, greenMax: 58 }),
    );
    expect(after.bodyFatRange).toEqual({ min: 12, max: 16 });
  });
});
