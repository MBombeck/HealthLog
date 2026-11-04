/**
 * A reading may only be stored under the unit it is actually in.
 *
 * Before this, a reading that stated another unit than its marker's (5.6
 * mmol/L against a marker kept in mg/dL) was written with its value unchanged
 * and the marker's unit stamped on it, and the range check then judged 5.6
 * against a mg/dL band. These tests follow that reading through the real
 * routes and the real database, and assert both what is refused and what is
 * not: a different spelling of the same unit, a qualitative reading, a
 * reading with no unit on the structured path and a brand-new marker must all
 * still write.
 *
 * "Another unit" is refused only where the pair cannot be converted. Ferritin
 * in pmol/L against a marker kept in ng/mL is the standing example: protein
 * molecular weights vary by source, so the registry has no conversion and the
 * reading stays refused. Where the marker's analyte is known and the pair is in
 * the registry (glucose in mmol/L against mg/dL) the reading is converted
 * instead; that is `labs-unit-conversion.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-lab-unit-mismatch";

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
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "lab-unit-mismatch",
      email: "lab-unit-mismatch@example.test",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

const TAKEN_AT = "2026-07-10T12:00:00.000Z";

async function seedGlucose() {
  return getPrismaClient().biomarker.create({
    data: {
      userId: USER_ID,
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 99,
    },
  });
}

/** A marker whose analyte the registry has no conversion for. */
async function seedFerritin() {
  return getPrismaClient().biomarker.create({
    data: {
      userId: USER_ID,
      name: "Ferritin",
      unit: "ng/mL",
      lowerBound: 30,
      upperBound: 400,
    },
  });
}

function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postLab(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/labs/route");
  const res = await POST(jsonReq("/api/labs", { takenAt: TAKEN_AT, ...body }));
  return { status: res.status, body: await res.json() };
}

async function commitRows(rows: Record<string, unknown>[]) {
  const { POST } = await import("@/app/api/labs/ocr/commit/route");
  const res = await POST(
    jsonReq("/api/labs/ocr/commit", {
      rows: rows.map((row) => ({ takenAt: TAKEN_AT, ...row })),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const labCount = () =>
  getPrismaClient().labResult.count({ where: { userId: USER_ID } });

describe("POST /api/labs", () => {
  it("refuses a reading in another unit than its marker's and writes nothing", async () => {
    await seedFerritin();
    const { status, body } = await postLab({
      analyte: "Ferritin",
      value: 450,
      unit: "pmol/L",
    });
    expect(status).toBe(422);
    expect(body.meta).toMatchObject({
      errorCode: "labs.unit.mismatch",
      markerUnit: "ng/mL",
      readingUnit: "pmol/L",
      reason: "unknown_analyte",
    });
    expect(await labCount()).toBe(0);
  });

  it("refuses it on the structured path too, when a unit is sent", async () => {
    const marker = await seedFerritin();
    const { status, body } = await postLab({
      biomarkerId: marker.id,
      value: 450,
      unit: "pmol/L",
    });
    expect(status).toBe(422);
    expect(body.meta.errorCode).toBe("labs.unit.mismatch");
    expect(await labCount()).toBe(0);
  });

  it("writes a reading on the structured path that sends no unit, under the marker's", async () => {
    const marker = await seedGlucose();
    const { status, body } = await postLab({
      biomarkerId: marker.id,
      value: 95,
    });
    expect(status).toBe(201);
    expect(body.data).toMatchObject({ value: 95, unit: "mg/dL" });
  });

  it.each(["mg/dl", "mg/DL", "MG/DL", " mg / dL "])(
    "writes the same unit spelled %j",
    async (spelling) => {
      await seedGlucose();
      const { status, body } = await postLab({
        analyte: "Glucose",
        value: 95,
        unit: spelling,
      });
      expect(status).toBe(201);
      expect(body.data).toMatchObject({ value: 95, unit: "mg/dL" });
    },
  );

  it("does not compare a qualitative reading, which has no unit", async () => {
    await seedGlucose();
    const { status } = await postLab({
      analyte: "Glucose",
      valueText: "negative",
      unit: "mmol/L",
    });
    expect(status).toBe(201);
  });

  it("lets a new marker adopt the unit of its first reading", async () => {
    const { status, body } = await postLab({
      analyte: "Ferritin",
      value: 80,
      unit: "ng/mL",
    });
    expect(status).toBe(201);
    expect(body.data.unit).toBe("ng/mL");
    // …and then holds the next reading in another unit to it.
    const next = await postLab({
      analyte: "Ferritin",
      value: 180,
      unit: "pmol/L",
    });
    expect(next.status).toBe(422);
    expect(await labCount()).toBe(1);
  });

  it("never judges the refused value against the marker's range", async () => {
    // The case from the report, for a pair that is refused: the number must
    // never be kept under a unit it is not in and judged against that band.
    await seedFerritin();
    await postLab({ analyte: "Ferritin", value: 450, unit: "pmol/L" });
    const { GET } = await import("@/app/api/labs/route");
    const res = await GET(
      new NextRequest("http://localhost/api/labs?analyte=Ferritin"),
    );
    expect((await res.json()).data.results).toEqual([]);
  });
});

describe("POST /api/labs/ocr/commit", () => {
  it("writes the matching row, skips the one in another unit, and reports a partial outcome", async () => {
    await seedFerritin();
    const { status, body } = await commitRows([
      { analyte: "Ferritin", value: 95, unit: "ng/mL" },
      {
        analyte: "Ferritin",
        value: 450,
        unit: "pmol/L",
        takenAt: "2026-08-10T12:00:00.000Z",
      },
    ]);
    expect(status).toBe(200);
    expect(body.data.inserted).toHaveLength(1);
    expect(body.data.inserted[0]).toMatchObject({ value: 95, unit: "ng/mL" });
    expect(body.data.skipped).toEqual([
      { analyte: "Ferritin", reason: "unit_mismatch" },
    ]);
    expect(body.data.outcome).toBe("partial");
    expect(await labCount()).toBe(1);
  });

  it("reports a failed outcome when every row is in another unit", async () => {
    await seedFerritin();
    const { body } = await commitRows([
      { analyte: "Ferritin", value: 450, unit: "pmol/L" },
    ]);
    expect(body.data.inserted).toHaveLength(0);
    expect(body.data.outcome).toBe("failed");
    expect(await labCount()).toBe(0);
  });

  it("accepts a different spelling of the marker's unit", async () => {
    await seedGlucose();
    const { body } = await commitRows([
      { analyte: "Glucose", value: 95, unit: "MG/DL" },
    ]);
    expect(body.data.outcome).toBe("success");
    expect(body.data.inserted[0].unit).toBe("mg/dL");
  });

  it("does not compare a qualitative row", async () => {
    await seedGlucose();
    const { body } = await commitRows([
      { analyte: "Glucose", valueText: "negative", unit: "mmol/L" },
    ]);
    expect(body.data.outcome).toBe("success");
  });
});

describe("the scan review's view of a row", () => {
  const scanned = (analyte: string, unit: string) => ({
    analyte,
    value: 5.6,
    valueText: null,
    unit,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    takenAt: null,
    confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
  });

  it("carries the matched marker's unit, so the screen can say so before Save", async () => {
    await seedGlucose();
    const { annotateRow } = await import("@/lib/labs/ocr-extract");
    const known = await annotateRow(
      USER_ID,
      scanned("Glucose", "mmol/L"),
      "2026-07-10",
      "UTC",
    );
    expect(known).toMatchObject({
      biomarkerMatch: "existing",
      markerUnit: "mg/dL",
    });

    const fresh = await annotateRow(
      USER_ID,
      scanned("Creatinine", "µmol/L"),
      "2026-07-10",
      "UTC",
    );
    expect(fresh).toMatchObject({ biomarkerMatch: "new", markerUnit: null });
  });
});
