/**
 * The Apple Health types that join the measurement batch with the second
 * ingest contract, against real Postgres: each lands as its own type in its
 * canonical unit with the payload the app actually sends, the two menopause
 * states take their value from `categoryValue`, the low-cardio-fitness
 * notification passes the verdict CHECK as a LOW_FITNESS event and is listed
 * with the other device notifications, fields the server does not store are
 * ignored rather than refused, and the app's two capability reads say all of
 * it is there.
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "apple-health-v2-owner",
      email: "apple-health-v2-owner@example.test",
      timezone: "UTC",
      gender: "FEMALE",
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner.id;
}

function batch(entries: unknown[]): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

const AT = {
  startDate: "2026-11-18T07:00:00.000Z",
  endDate: "2026-11-18T07:00:00.000Z",
};
const id = (n: number) =>
  `6F1C2D3E-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The entries exactly as the app sends them (contract §4). */
const APP_ENTRIES = [
  {
    hkIdentifier: "HKCategoryTypeIdentifierLowCardioFitnessEvent",
    value: 1,
    unit: "event",
    categoryValue: 1,
    metadata: { vo2MaxThreshold: 28.4 },
    ...AT,
    externalId: id(1),
  },
  {
    hkIdentifier: "HKCategoryTypeIdentifierMenopausalState",
    value: 1,
    unit: "event",
    categoryValue: 2,
    ...AT,
    externalId: id(2),
  },
  {
    hkIdentifier: "HKCategoryTypeIdentifierBleedingAfterMenopause",
    value: 1,
    unit: "event",
    categoryValue: 3,
    ...AT,
    externalId: id(3),
  },
  {
    hkIdentifier: "HKQuantityTypeIdentifierInsulinDelivery",
    value: 4.5,
    unit: "IU",
    insulinDeliveryReason: "BOLUS",
    ...AT,
    externalId: id(4),
  },
  {
    hkIdentifier: "HKQuantityTypeIdentifierInhalerUsage",
    value: 2,
    unit: "count",
    ...AT,
    externalId: id(5),
  },
  {
    hkIdentifier: "HKQuantityTypeIdentifierForcedExpiratoryVolume1",
    value: 3.21,
    unit: "L",
    ...AT,
    externalId: id(6),
  },
  {
    hkIdentifier: "HKQuantityTypeIdentifierForcedVitalCapacity",
    value: 4.05,
    unit: "L",
    ...AT,
    externalId: id(7),
  },
  {
    hkIdentifier: "HKQuantityTypeIdentifierPeakExpiratoryFlowRate",
    value: 455,
    unit: "L/min",
    ...AT,
    externalId: id(8),
  },
];

const EXPECTED_ROWS = [
  {
    externalId: id(1),
    type: "LOW_CARDIO_FITNESS_EVENT",
    value: 1,
    unit: "event",
    rhythmClassification: "LOW_FITNESS",
  },
  {
    externalId: id(2),
    type: "MENOPAUSAL_STATE",
    value: 2,
    unit: "state",
    rhythmClassification: null,
  },
  {
    externalId: id(3),
    type: "BLEEDING_AFTER_MENOPAUSE",
    value: 3,
    unit: "flow",
    rhythmClassification: null,
  },
  {
    externalId: id(4),
    type: "INSULIN_DELIVERY",
    value: 4.5,
    unit: "IU",
    rhythmClassification: null,
  },
  {
    externalId: id(5),
    type: "INHALER_USAGE",
    value: 2,
    unit: "count",
    rhythmClassification: null,
  },
  {
    externalId: id(6),
    type: "FEV1",
    value: 3.21,
    unit: "L",
    rhythmClassification: null,
  },
  {
    externalId: id(7),
    type: "FVC",
    value: 4.05,
    unit: "L",
    rhythmClassification: null,
  },
  {
    externalId: id(8),
    type: "PEAK_EXPIRATORY_FLOW",
    value: 455,
    unit: "L/min",
    rhythmClassification: null,
  },
];

describe("Apple Health ingest v2 measurement types", () => {
  it("names every new identifier in acceptedTypes and the three flags in features", async () => {
    await signIn();
    const healthkit = await import("@/app/api/integrations/healthkit/route");
    const res = await healthkit.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { acceptedTypes: string[] } };
    for (const entry of APP_ENTRIES) {
      expect(body.data.acceptedTypes).toContain(entry.hkIdentifier);
    }

    const me = await import("@/app/api/auth/me/route");
    const meRes = await me.GET();
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      data: { features: Record<string, unknown> };
    };
    expect(meBody.data.features).toMatchObject({
      appleHealthSymptoms: true,
      appleHealthDeletes: true,
      nutrientMacros: true,
    });
  });

  it("stores each type from the app's own payload, ignoring the fields it does not keep", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/batch/route");

    const res = await POST(batch(APP_ENTRIES));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string; reason?: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual(
      APP_ENTRIES.map(() => "inserted"),
    );

    const rows = await prisma.measurement.findMany({
      where: { userId, deletedAt: null },
      orderBy: { externalId: "asc" },
      select: {
        externalId: true,
        type: true,
        value: true,
        unit: true,
        rhythmClassification: true,
      },
    });
    expect(rows).toEqual(EXPECTED_ROWS);

    // A re-post of the same samples is a duplicate, as for every sample.
    const replay = await POST(batch(APP_ENTRIES));
    const replayBody = (await replay.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(replayBody.data.entries.map((e) => e.status)).toEqual(
      APP_ENTRIES.map(() => "duplicate"),
    );

    // The low-fitness notification is a device notification like the
    // heart-rate events.
    const rhythm = await import("@/app/api/insights/rhythm-events/route");
    const events = (await (await rhythm.GET()).json()) as {
      data: { events: Array<{ type: string; classification: string }> };
    };
    expect(events.data.events).toEqual([
      expect.objectContaining({
        type: "LOW_CARDIO_FITNESS_EVENT",
        classification: "LOW_FITNESS",
      }),
    ]);
  });

  it("keeps taking a hypertension notification sent as value 1 or value 0", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      batch([
        {
          hkIdentifier: "HKCategoryTypeIdentifierHypertensionEvent",
          value: 1,
          unit: "event",
          categoryValue: 0,
          ...AT,
          externalId: id(20),
        },
        {
          hkIdentifier: "HKCategoryTypeIdentifierHypertensionEvent",
          value: 0,
          unit: "event",
          categoryValue: 0,
          startDate: "2026-11-19T07:00:00.000Z",
          endDate: "2026-11-19T07:00:00.000Z",
          externalId: id(21),
        },
      ]),
    );
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries.map((e) => e.status)).toEqual([
      "inserted",
      "inserted",
    ]);
    expect(
      await prisma.measurement.findMany({
        where: { userId },
        select: { value: true, rhythmClassification: true },
      }),
    ).toEqual([
      { value: 1, rhythmClassification: "FIRED" },
      { value: 1, rhythmClassification: "FIRED" },
    ]);
  });

  it("skips a menopause state with an unknown codepoint and never touches the cycle", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      batch([
        {
          hkIdentifier: "HKCategoryTypeIdentifierMenopausalState",
          value: 1,
          unit: "event",
          categoryValue: 7,
          ...AT,
          externalId: id(30),
        },
        {
          hkIdentifier: "HKCategoryTypeIdentifierBleedingAfterMenopause",
          value: 1,
          unit: "event",
          categoryValue: 4,
          ...AT,
          externalId: id(31),
        },
      ]),
    );
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string; reason?: string }> };
    };
    expect(body.data.entries).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "value_out_of_range",
      }),
      expect.objectContaining({ status: "inserted" }),
    ]);
    expect(await prisma.cycleDayLog.count({ where: { userId } })).toBe(0);
    expect(await prisma.menstrualCycle.count({ where: { userId } })).toBe(0);
  });
});
