/**
 * Blood ketones and the glucose-ketone index (#1367), against real Postgres.
 *
 * A fingerstick posts its glucose and ketones as one array: both rows land
 * with one timestamp, or neither does. The index is derived at read time by
 * one pairing rule and reaches the series route, the day and the doctor
 * report with the same numbers; a ketone reading without a glucose reading
 * within 15 minutes, or with a value of zero, has none.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { readGlucoseKetoneIndex } from "@/lib/measurements/read-glucose-ketone-index";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

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

vi.mock("@/lib/cache/invalidate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cache/invalidate")>();
  return { ...actual, invalidateUserData: vi.fn() };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "ketones-owner",
      email: "ketones-owner@example.test",
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner.id;
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MIN = 60_000;
/** A recent morning, inside every default read window. */
const T0 = new Date(Date.now() - 2 * 86_400_000);
T0.setUTCHours(8, 0, 0, 0);
const at = (offsetMin: number) => new Date(T0.getTime() + offsetMin * MIN);

async function seed(
  userId: string,
  rows: Array<{
    type: "BLOOD_GLUCOSE" | "BLOOD_KETONES";
    value: number;
    offsetMin: number;
  }>,
) {
  await getPrismaClient().measurement.createMany({
    data: rows.map((r) => ({
      userId,
      type: r.type,
      value: r.value,
      unit: r.type === "BLOOD_GLUCOSE" ? "mg/dL" : "mmol/L",
      source: "MANUAL" as const,
      measuredAt: at(r.offsetMin),
      glucoseContext: r.type === "BLOOD_GLUCOSE" ? ("FASTING" as const) : null,
    })),
  });
}

/**
 * Four fingersticks: an exact pair, a pair ten minutes apart, a ketone
 * reading whose glucose is twenty minutes away, and a ketone reading of 0.
 */
async function seedMorning(userId: string) {
  await seed(userId, [
    { type: "BLOOD_GLUCOSE", value: 81, offsetMin: 0 },
    { type: "BLOOD_KETONES", value: 1.2, offsetMin: 0 },
    { type: "BLOOD_GLUCOSE", value: 90, offsetMin: 130 },
    { type: "BLOOD_KETONES", value: 2, offsetMin: 120 },
    { type: "BLOOD_GLUCOSE", value: 100, offsetMin: 260 },
    { type: "BLOOD_KETONES", value: 1.5, offsetMin: 240 },
    { type: "BLOOD_GLUCOSE", value: 95, offsetMin: 360 },
    { type: "BLOOD_KETONES", value: 0, offsetMin: 360 },
  ]);
}

describe("fingerstick entry (#1367)", () => {
  it("writes the glucose and the ketones together with one timestamp", async () => {
    const userId = await signIn();
    const { POST } = await import("@/app/api/measurements/route");
    const measuredAt = at(0).toISOString();
    const res = await POST(
      post([
        {
          type: "BLOOD_GLUCOSE",
          value: 81,
          measuredAt,
          glucoseContext: "FASTING",
        },
        { type: "BLOOD_KETONES", value: 1.2, measuredAt },
      ]),
    );
    expect(res.status).toBe(201);
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId },
      orderBy: { type: "asc" },
      select: { type: true, value: true, unit: true, measuredAt: true },
    });
    expect(rows).toEqual([
      { type: "BLOOD_GLUCOSE", value: 81, unit: "mg/dL", measuredAt: at(0) },
      { type: "BLOOD_KETONES", value: 1.2, unit: "mmol/L", measuredAt: at(0) },
    ]);
  });

  it("writes neither reading when the ketones are out of range", async () => {
    const userId = await signIn();
    const { POST } = await import("@/app/api/measurements/route");
    const measuredAt = at(0).toISOString();
    const res = await POST(
      post([
        {
          type: "BLOOD_GLUCOSE",
          value: 81,
          measuredAt,
          glucoseContext: "FASTING",
        },
        { type: "BLOOD_KETONES", value: 12, measuredAt },
      ]),
    );
    expect(res.status).toBe(422);
    expect(
      await getPrismaClient().measurement.count({ where: { userId } }),
    ).toBe(0);
  });

  it("rolls the ketones back when the glucose half is a duplicate", async () => {
    const userId = await signIn();
    const { POST } = await import("@/app/api/measurements/route");
    const measuredAt = at(0).toISOString();
    const glucose = {
      type: "BLOOD_GLUCOSE",
      value: 81,
      measuredAt,
      glucoseContext: "FASTING",
    };
    expect((await POST(post(glucose))).status).toBe(201);
    const res = await POST(
      post([glucose, { type: "BLOOD_KETONES", value: 1.2, measuredAt }]),
    );
    expect(res.status).toBe(409);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId, type: "BLOOD_KETONES" },
      }),
    ).toBe(0);
  });
});

describe("glucose-ketone index (#1367)", () => {
  it("pairs by the one rule and leaves out what has no partner", async () => {
    const userId = await signIn();
    await seedMorning(userId);
    const points = await readGlucoseKetoneIndex({
      userId,
      from: at(-60),
      to: at(24 * 60),
    });
    expect(
      points.map((p) => ({
        at: p.at,
        glucoseAt: p.glucoseAt,
        value: p.value,
        ketonesMmol: p.ketonesMmol,
        glucoseMmol: p.glucoseMmol,
      })),
    ).toEqual([
      // 81 mg/dL = 4.5 mmol/L; / 1.2 = 3.7
      {
        at: at(0).toISOString(),
        glucoseAt: at(0).toISOString(),
        value: 3.7,
        ketonesMmol: 1.2,
        glucoseMmol: 4.5,
      },
      // 90 mg/dL = 5.0 mmol/L, ten minutes later; / 2 = 2.5
      {
        at: at(120).toISOString(),
        glucoseAt: at(130).toISOString(),
        value: 2.5,
        ketonesMmol: 2,
        glucoseMmol: 5,
      },
    ]);
  });

  it("pairs a glucose reading just outside the window with a ketone reading just inside it", async () => {
    const userId = await signIn();
    await seed(userId, [
      { type: "BLOOD_GLUCOSE", value: 90, offsetMin: -5 },
      { type: "BLOOD_KETONES", value: 1, offsetMin: 0 },
    ]);
    const points = await readGlucoseKetoneIndex({
      userId,
      from: at(0),
      to: at(60),
    });
    expect(points.map((p) => p.glucoseAt)).toEqual([at(-5).toISOString()]);
  });

  it("serves the index and the ketones on the series route", async () => {
    await signIn().then(seedMorning);
    const { GET } = await import("@/app/api/measurements/series/route");
    const gki = await GET(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=glucoseKetoneIndex&days=30",
      ),
    );
    expect(gki.status).toBe(200);
    const gkiBody = (await gki.json()) as {
      data: {
        unit: string;
        points: Array<{
          value: number;
          gki: { glucoseAt: string; glucoseMmol: number; ketonesMmol: number };
        }>;
        stats: { count: number };
        referenceLines: unknown[];
      };
    };
    expect(gkiBody.data.unit).toBe("ratio");
    expect(gkiBody.data.points.map((p) => p.value)).toEqual([3.7, 2.5]);
    expect(gkiBody.data.points[1]!.gki).toMatchObject({
      glucoseAt: at(130).toISOString(),
      glucoseMmol: 5,
      ketonesMmol: 2,
    });
    expect(gkiBody.data.stats.count).toBe(2);
    expect(gkiBody.data.referenceLines).toEqual([]);

    const ketones = await GET(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=ketones&days=30",
      ),
    );
    expect(ketones.status).toBe(200);
    const ketoneBody = (await ketones.json()) as {
      data: { unit: string; points: Array<{ value: number }> };
    };
    expect(ketoneBody.data.unit).toBe("mmol/L");
    expect(ketoneBody.data.points.map((p) => p.value)).toEqual([
      1.2, 2, 1.5, 0,
    ]);
  });

  it("carries the day's index on the day", async () => {
    await signIn().then(seedMorning);
    const { GET } = await import("@/app/api/day/[date]/route");
    const date = at(0).toISOString().slice(0, 10);
    const res = await GET(
      new Request(`http://localhost/api/day/${date}`) as never,
      { params: Promise.resolve({ date }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        glucoseKetoneIndex?: Array<{ value: number; glucoseAt: string }>;
        values: Array<{ type: string }>;
      };
    };
    expect(body.data.glucoseKetoneIndex?.map((p) => p.value)).toEqual([
      3.7, 2.5,
    ]);
    expect(body.data.values.some((v) => v.type === "BLOOD_KETONES")).toBe(true);
  });

  it("puts the index in the doctor report only beside both readings", async () => {
    const userId = await signIn();
    await seedMorning(userId);
    const range = {
      start: at(-24 * 60),
      end: at(24 * 60),
      days: 2,
    };
    const both = await collectDoctorReportData(
      userId,
      range,
      selectionFromLeaves(["BLOOD_KETONES", "BLOOD_GLUCOSE"]),
    );
    expect(both.stats.BLOOD_KETONES?.count).toBe(4);
    expect(both.glucoseKetoneIndex).toMatchObject({
      count: 2,
      latest: 2.5,
      min: 2.5,
      max: 3.7,
      avg: 3.1,
    });

    const ketonesOnly = await collectDoctorReportData(
      userId,
      range,
      selectionFromLeaves(["BLOOD_KETONES"]),
    );
    expect(ketonesOnly.stats.BLOOD_KETONES?.count).toBe(4);
    expect(ketonesOnly.glucoseKetoneIndex).toBeNull();
  });
});
