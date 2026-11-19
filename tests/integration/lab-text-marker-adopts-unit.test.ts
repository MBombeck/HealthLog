/**
 * A marker minted from a text result takes the unit of its first number.
 *
 * A report that prints "SEE NOTE" for a ratio mints a marker with an empty
 * unit, and a marker with a reading has its unit locked. The next report
 * printed the ratio as a number with no unit, and the save was refused
 * against a unit nothing had ever chosen. The first number that states a
 * unit sets it, also over numbers stored without one. Once a number is
 * stored under a unit, the unit is locked as before.
 *
 * Through the real `POST /api/labs` against Postgres.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
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

const prisma = getPrismaClient();
const USER = "text-marker-unit-user";

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      modulePreferencesJson: { labs: true },
    },
  });
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
});

async function postReading(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/labs/route");
  return POST(
    new NextRequest("http://localhost/api/labs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function textMarker() {
  const marker = await prisma.biomarker.create({
    data: { userId: USER, name: "BUN/Creatinine ratio", unit: "" },
  });
  const first = await postReading({
    biomarkerId: marker.id,
    valueText: "SEE NOTE",
    takenAt: "2026-09-01T08:00:00.000Z",
  });
  expect(first.status).toBe(201);
  return marker;
}

describe("a marker whose readings are all text", () => {
  it("takes the dimensionless unit from its first unitless number", async () => {
    const marker = await textMarker();
    const res = await postReading({
      biomarkerId: marker.id,
      value: 18,
      unit: "1",
      takenAt: "2026-10-01T08:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const stored = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(stored.unit).toBe("1");
    const reading = await prisma.labResult.findFirstOrThrow({
      where: { biomarkerId: marker.id, value: { not: null } },
    });
    expect(reading).toMatchObject({ value: 18, unit: "1" });
  });

  it("takes a real unit from its first number the same way", async () => {
    const marker = await textMarker();
    const res = await postReading({
      biomarkerId: marker.id,
      value: 0.8,
      unit: " mg/dL ",
      takenAt: "2026-10-01T08:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const stored = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(stored.unit).toBe("mg/dL");
  });

  it("locks the unit once a number is stored", async () => {
    const marker = await textMarker();
    expect(
      (
        await postReading({
          biomarkerId: marker.id,
          value: 18,
          unit: "1",
          takenAt: "2026-10-01T08:00:00.000Z",
        })
      ).status,
    ).toBe(201);
    const second = await postReading({
      biomarkerId: marker.id,
      value: 0.8,
      unit: "mg/dL",
      takenAt: "2026-10-15T08:00:00.000Z",
    });
    expect(second.status).toBe(422);
    const stored = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(stored.unit).toBe("1");
  });

  it("takes the unit of a new number when the marker already holds a number without one", async () => {
    // Older data: a number stored under a marker with no unit. Refusing
    // every later reading that states a unit left the marker unable to take
    // any (#1421); the stated unit is adopted and the unitless number takes
    // it with the marker, which is how readers already showed it.
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Legacy ratio", unit: "" },
    });
    const old = await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: marker.id,
        analyte: marker.name,
        value: 12,
        unit: "",
        takenAt: new Date("2026-08-01T08:00:00.000Z"),
        source: "MANUAL",
      },
    });
    const res = await postReading({
      biomarkerId: marker.id,
      value: 0.8,
      unit: "mg/dL",
      takenAt: "2026-10-01T08:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const stored = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(stored.unit).toBe("mg/dL");
    const kept = await prisma.labResult.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(kept.value).toBe(12);
    expect(kept.unit).toBe("mg/dL");
  });

  it("does not count a deleted number as holding the unit", async () => {
    const marker = await textMarker();
    await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: marker.id,
        analyte: marker.name,
        value: 12,
        unit: "",
        takenAt: new Date("2026-08-01T08:00:00.000Z"),
        source: "MANUAL",
        deletedAt: new Date("2026-08-02T08:00:00.000Z"),
      },
    });
    const res = await postReading({
      biomarkerId: marker.id,
      value: 18,
      unit: "1",
      takenAt: "2026-10-01T08:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const stored = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(stored.unit).toBe("1");
  });

  it("leaves a marker with a unit of its own refusing a unitless number", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Creatinine", unit: "mg/dL" },
    });
    const res = await postReading({
      biomarkerId: marker.id,
      value: 18,
      unit: "1",
      takenAt: "2026-10-01T08:00:00.000Z",
    });
    expect(res.status).toBe(422);
    const stored = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(stored.unit).toBe("mg/dL");
  });
});
