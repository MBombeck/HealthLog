/**
 * Apple Watch hypertension notifications, against real Postgres:
 * `HKCategoryTypeIdentifierHypertensionEvent` goes through the measurement
 * batch the way the heart-rate events do. It is stored as a
 * `HYPERTENSION_EVENT` row with `value = 1` and the device's neutral `FIRED`
 * verdict (the CHECK from migration 0509 admits it), never as a blood
 * pressure reading, it is listed on the device-notification read, a re-post
 * of the same sample is a duplicate, and `GET /api/integrations/healthkit`
 * tells the app the server takes it.
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

const HYPERTENSION = "HKCategoryTypeIdentifierHypertensionEvent";
const SAMPLE_ID = "6F1C2D3E-0000-4000-8000-00000000A001";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "hypertension-owner",
      email: "hypertension-owner@example.test",
      timezone: "UTC",
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

const entry = {
  hkIdentifier: HYPERTENSION,
  value: 0,
  unit: "event",
  categoryValue: 0,
  startDate: "2026-10-01T06:00:00.000Z",
  endDate: "2026-10-31T06:00:00.000Z",
  externalId: SAMPLE_ID,
};

describe("hypertension notification ingest", () => {
  it("lists the identifier in acceptedTypes", async () => {
    await signIn();
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const res = await GET();
    const body = (await res.json()) as { data: { acceptedTypes: string[] } };
    expect(body.data.acceptedTypes).toContain(HYPERTENSION);
  });

  it("stores a FIRED event row, lists it as a device notification, and folds a re-post", async () => {
    const userId = await signIn();
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/measurements/batch/route");

    const first = await POST(batch([entry]));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(firstBody.data.entries.map((e) => e.status)).toEqual(["inserted"]);

    const rows = await prisma.measurement.findMany({
      where: { userId, deletedAt: null },
      select: {
        type: true,
        value: true,
        unit: true,
        rhythmClassification: true,
        source: true,
        externalId: true,
      },
    });
    expect(rows).toEqual([
      {
        type: "HYPERTENSION_EVENT",
        value: 1,
        unit: "event",
        rhythmClassification: "FIRED",
        source: "APPLE_HEALTH",
        externalId: SAMPLE_ID,
      },
    ]);
    // A notification, never a reading on the blood pressure series.
    expect(
      await prisma.measurement.count({
        where: {
          userId,
          type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
        },
      }),
    ).toBe(0);

    const replay = await POST(batch([entry]));
    const replayBody = (await replay.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(replayBody.data.entries.map((e) => e.status)).toEqual(["duplicate"]);
    expect(await prisma.measurement.count({ where: { userId } })).toBe(1);

    const { GET } = await import("@/app/api/insights/rhythm-events/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const events = (await res.json()) as {
      data: { events: Array<{ type: string; classification: string }> };
    };
    expect(events.data.events).toEqual([
      expect.objectContaining({
        type: "HYPERTENSION_EVENT",
        classification: "FIRED",
      }),
    ]);
  });
});
