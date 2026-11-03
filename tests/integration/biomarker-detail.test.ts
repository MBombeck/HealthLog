/**
 * Integration suite for the biomarker resource route
 * (`/api/biomarkers/{id}`) against a real Postgres.
 *
 * Covers the two detail-page mutations:
 *   - PUT adjusts the target range (and rejects an inverted window), and
 *     refuses a unit change while readings are linked, because readers
 *     label every reading with the marker's unit,
 *   - DELETE drops the marker together with its readings in one
 *     userId-narrowed transaction, leaving another user's marker untouched.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-biomarker-detail-test";
const OTHER_USER_ID = "user-biomarker-other-test";

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
  const prisma = getPrismaClient();
  await prisma.user.createMany({
    data: [
      { id: USER_ID, username: "bm-detail", email: "bm-detail@example.test" },
      {
        id: OTHER_USER_ID,
        username: "bm-other",
        email: "bm-other@example.test",
      },
    ],
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function putReq(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/biomarkers/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function delReq(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/biomarkers/${id}`, {
    method: "DELETE",
  });
}

async function seedMarkerWithReadings(userId: string, name: string) {
  const prisma = getPrismaClient();
  const marker = await prisma.biomarker.create({
    data: { userId, name, unit: "mg/dL", lowerBound: 0, upperBound: 100 },
  });
  await prisma.labResult.createMany({
    data: [
      {
        userId,
        biomarkerId: marker.id,
        analyte: name,
        unit: "mg/dL",
        value: 95,
        takenAt: new Date("2026-06-20T08:00:00.000Z"),
      },
      {
        userId,
        biomarkerId: marker.id,
        analyte: name,
        unit: "mg/dL",
        value: 88,
        takenAt: new Date("2026-05-20T08:00:00.000Z"),
      },
    ],
  });
  return marker;
}

describe("PUT /api/biomarkers/{id} — target range (real Postgres)", () => {
  it("persists an updated reference window", async () => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    const marker = await seedMarkerWithReadings(USER_ID, "LDL");

    const res = await PUT(
      putReq(marker.id, { lowerBound: 10, upperBound: 50 }),
      params(marker.id),
    );
    expect(res.status).toBe(200);

    const row = await getPrismaClient().biomarker.findUnique({
      where: { id: marker.id },
    });
    expect(row?.lowerBound).toBe(10);
    expect(row?.upperBound).toBe(50);
  });

  it("422s an inverted target range and leaves the bounds untouched", async () => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    const marker = await seedMarkerWithReadings(USER_ID, "HbA1c");

    const res = await PUT(
      putReq(marker.id, { lowerBound: 80, upperBound: 20 }),
      params(marker.id),
    );
    expect(res.status).toBe(422);

    const row = await getPrismaClient().biomarker.findUnique({
      where: { id: marker.id },
    });
    expect(row?.lowerBound).toBe(0);
    expect(row?.upperBound).toBe(100);
  });
});

describe("PUT /api/biomarkers/{id} — unit lock (real Postgres)", () => {
  it("refuses a unit change while readings are linked and changes nothing", async () => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    const marker = await seedMarkerWithReadings(USER_ID, "Glucose");

    const res = await PUT(
      putReq(marker.id, { unit: "mmol/L", upperBound: 120 }),
      params(marker.id),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.meta).toMatchObject({
      errorCode: "biomarkers.unit.locked",
      readingCount: 2,
    });
    const row = await getPrismaClient().biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    // Nothing of the request landed, not even the bound beside the unit.
    expect(row.unit).toBe("mg/dL");
    expect(row.upperBound).toBe(100);
  });

  it("counts a tombstoned reading, since an undo brings it back", async () => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    const prisma = getPrismaClient();
    const marker = await seedMarkerWithReadings(USER_ID, "Ferritin");
    await prisma.labResult.updateMany({
      where: { biomarkerId: marker.id },
      data: { deletedAt: new Date() },
    });

    const res = await PUT(
      putReq(marker.id, { unit: "ng/mL" }),
      params(marker.id),
    );

    expect(res.status).toBe(422);
  });

  it("accepts the unchanged unit beside another edit", async () => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    const marker = await seedMarkerWithReadings(USER_ID, "HbA1c");

    const res = await PUT(
      putReq(marker.id, { unit: "mg/dL", upperBound: 90 }),
      params(marker.id),
    );

    expect(res.status).toBe(200);
    const row = await getPrismaClient().biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(row.upperBound).toBe(90);
  });

  it("allows a unit change on a marker with no readings", async () => {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    const marker = await getPrismaClient().biomarker.create({
      data: { userId: USER_ID, name: "TSH", unit: "mU/L" },
    });

    const res = await PUT(
      putReq(marker.id, { unit: "µIU/mL" }),
      params(marker.id),
    );

    expect(res.status).toBe(200);
    const row = await getPrismaClient().biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(row.unit).toBe("µIU/mL");
  });
});

describe("DELETE /api/biomarkers/{id} (real Postgres)", () => {
  it("drops the marker together with its readings", async () => {
    const { DELETE } = await import("@/app/api/biomarkers/[id]/route");
    const marker = await seedMarkerWithReadings(USER_ID, "Ferritin");

    const res = await DELETE(delReq(marker.id), params(marker.id));
    expect(res.status).toBe(200);

    const prisma = getPrismaClient();
    expect(await prisma.biomarker.count({ where: { id: marker.id } })).toBe(0);
    expect(
      await prisma.labResult.count({ where: { biomarkerId: marker.id } }),
    ).toBe(0);
  });

  it("404s another user's marker and leaves it (and its readings) intact", async () => {
    const { DELETE } = await import("@/app/api/biomarkers/[id]/route");
    const foreign = await seedMarkerWithReadings(OTHER_USER_ID, "TSH");

    const res = await DELETE(delReq(foreign.id), params(foreign.id));
    expect(res.status).toBe(404);

    const prisma = getPrismaClient();
    expect(await prisma.biomarker.count({ where: { id: foreign.id } })).toBe(1);
    expect(
      await prisma.labResult.count({ where: { biomarkerId: foreign.id } }),
    ).toBe(2);
  });
});
