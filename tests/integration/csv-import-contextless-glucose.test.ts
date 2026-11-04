/**
 * #640 — a contextless blood-glucose reading reaches Postgres.
 *
 * The reported import wrote nothing. Two layers had to agree that a reading
 * without a fasting / post-meal classification is a reading: the CSV parser,
 * and the CHECK constraint from migration 0021 that demanded a context on
 * every `BLOOD_GLUCOSE` row. Only a real database proves the second half, so
 * this runs the route end to end and reads the row back.
 *
 * Also pinned here: the constraint's surviving half (a context on any other
 * type is still refused), the re-upload idempotency the importer promises,
 * and the writers that were failing silently against the old constraint
 * (the CGM sync shape and the single-value tool shape) now landing.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import { MGDL_PER_MMOL } from "@/lib/glucose";

const USER = "user-csv-glucose";

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

const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";

async function signIn() {
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "csv-glucose",
      email: "csv-glucose@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: USER,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function csvRequest(rows: string[]): NextRequest {
  return new NextRequest("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: [HEADER, ...rows].join("\n"),
  });
}

interface CsvEnvelope {
  data: {
    inserted: number;
    updated: number;
    skipped: number;
    total: number;
    rows: Array<{ line: number; status: string; reason?: string }>;
  } | null;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("POST /api/import/csv — contextless glucose (real Postgres)", () => {
  it("persists a sensor reading with no context, in the canonical shape", async () => {
    await signIn();
    const { POST } = await import("@/app/api/import/csv/route");

    const res = await POST(
      csvRequest([
        "BLOOD_GLUCOSE,5.3,mmol/L,2024-04-03T13:15:00+1100,,Sensor,sensor-1",
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(0);

    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("BLOOD_GLUCOSE");
    expect(rows[0].glucoseContext).toBeNull();
    expect(rows[0].source).toBe("IMPORT");
    expect(rows[0].unit).toBe("mg/dL");
    // Derived from the shared factor rather than pinned, for the same reason
    // as below: a literal here re-pins whichever copy of the conversion the
    // import path happened to use when it was written.
    expect(rows[0].value).toBeCloseTo(5.3 * MGDL_PER_MMOL, 3);
    expect(rows[0].externalId).toBe("sensor-1");
    expect(rows[0].measuredAt.toISOString()).toBe("2024-04-03T02:15:00.000Z");
  });

  it("stays idempotent when the same external id is re-uploaded", async () => {
    await signIn();
    const { POST } = await import("@/app/api/import/csv/route");

    const first = await POST(
      csvRequest([
        "BLOOD_GLUCOSE,5.3,mmol/L,2024-04-03T13:15:00+1100,,Sensor,sensor-1",
      ]),
    );
    expect(((await first.json()) as CsvEnvelope).data?.inserted).toBe(1);

    const second = await POST(
      csvRequest([
        "BLOOD_GLUCOSE,5.9,mmol/L,2024-04-03T13:15:00+1100,,Sensor,sensor-1",
      ]),
    );
    const secondBody = (await second.json()) as CsvEnvelope;
    expect(secondBody.data?.inserted).toBe(0);
    expect(secondBody.data?.updated).toBe(1);

    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].glucoseContext).toBeNull();
    // Derived, not pinned: this carried the import path's own copy of the
    // conversion factor, so unifying the two conversions left it asserting a
    // number the code no longer produces.
    expect(rows[0].value).toBeCloseTo(5.9 * MGDL_PER_MMOL, 3);
  });

  it("keeps a named context, and still refuses one that is not in the enum", async () => {
    await signIn();
    const { POST } = await import("@/app/api/import/csv/route");

    const res = await POST(
      csvRequest([
        "BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,FASTING,,meter-1",
        "BLOOD_GLUCOSE,95,mg/dL,2026-05-01T09:00:00Z,LUNCH,,meter-2",
      ]),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.rows[1]).toMatchObject({
      status: "skipped",
      reason: "invalid_glucose_context",
    });

    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].glucoseContext).toBe("FASTING");
  });
});

describe("measurements.glucose_context — surviving CHECK half", () => {
  it("still refuses a context on a row that is not blood glucose", async () => {
    await signIn();
    await expect(
      getPrismaClient().measurement.create({
        data: {
          userId: USER,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "IMPORT",
          measuredAt: new Date("2026-05-01T08:00:00.000Z"),
          glucoseContext: "FASTING",
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts the contextless shape the device writers build", async () => {
    await signIn();
    // The Nightscout SGV upsert, the HealthKit batch mapping, and the MCP /
    // Telegram single-value captures all build a BLOOD_GLUCOSE row with no
    // context. Under the old constraint every one of those inserts was
    // refused by the database.
    const sources = ["NIGHTSCOUT", "APPLE_HEALTH", "MCP", "TELEGRAM"] as const;
    for (const [index, source] of sources.entries()) {
      await getPrismaClient().measurement.create({
        data: {
          userId: USER,
          type: "BLOOD_GLUCOSE",
          value: 95,
          unit: "mg/dL",
          source,
          measuredAt: new Date(`2026-05-01T0${index}:00:00.000Z`),
          externalId: `${source}-1`,
        },
      });
    }
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: USER, type: "BLOOD_GLUCOSE" },
    });
    expect(rows).toHaveLength(sources.length);
    expect(rows.every((row) => row.glucoseContext === null)).toBe(true);
  });
});
