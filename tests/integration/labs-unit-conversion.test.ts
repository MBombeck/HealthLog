/**
 * A lab reading in another unit is converted into its marker's unit (#1095).
 *
 * Until now a reading that stated a unit other than its marker's was refused.
 * When the marker's analyte is known and the registry has the pair, the three
 * write paths now convert it, keep what the report printed beside it, and move
 * the report's own reference window with the value. Against a real Postgres:
 *
 *   - POST /api/labs converts, stores full precision and the printed value and
 *     unit, converts the printed window, and says so in the response;
 *   - a pair that cannot be converted is still the 422 it always was, now with
 *     the reason;
 *   - the verdict is judged against the converted window, so a value in range in
 *     the printed unit is in range after conversion;
 *   - the OCR commit converts, and the same scan committed again is a duplicate
 *     (the stored number is converted, so the printed one is what matches);
 *   - changing the value of a converted reading clears the conversion record,
 *     and an edit that sends the value back unchanged keeps it;
 *   - the list returns the fields.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
const USER = "lab-conversion-user";
const MGDL_PER_MMOL = 18.0182;

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
  // A catalog marker the user tracks in mg/dL, with a catalog band.
  await prisma.biomarker.create({
    data: {
      id: "bm-glucose",
      userId: USER,
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 100,
    },
  });
  // A marker the registry knows nothing about.
  await prisma.biomarker.create({
    data: {
      id: "bm-free",
      userId: USER,
      name: "My own marker",
      unit: "mg/dL",
    },
  });
});

async function call<T = unknown>(
  route: "labs" | "ocr" | "one",
  method: "GET" | "POST" | "PUT",
  body?: unknown,
  id?: string,
): Promise<{
  status: number;
  json: { data?: T; meta?: Record<string, unknown> };
}> {
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const url =
    route === "labs"
      ? "http://localhost/api/labs"
      : route === "ocr"
        ? "http://localhost/api/labs/ocr/commit"
        : `http://localhost/api/labs/${id}`;
  const init = {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const req = new NextRequest(url, init);
  let res: Response;
  if (route === "labs") {
    const mod = await import("@/app/api/labs/route");
    res = await (method === "GET" ? mod.GET(req) : mod.POST(req));
  } else if (route === "ocr") {
    const mod = await import("@/app/api/labs/ocr/commit/route");
    res = await mod.POST(req);
  } else {
    const mod = await import("@/app/api/labs/[id]/route");
    res = await (method === "PUT"
      ? mod.PUT(req, { params: Promise.resolve({ id: id! }) })
      : mod.GET(req, { params: Promise.resolve({ id: id! }) }));
  }
  return { status: res.status, json: (await res.json()) as never };
}

type Dto = {
  id: string;
  value: number;
  unit: string;
  converted: boolean;
  sourceValue: number | null;
  sourceUnit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  rangeStatus: string;
};

describe("POST /api/labs", () => {
  it("converts a reading in another unit and keeps what the report printed", async () => {
    const { status, json } = await call<Dto>("labs", "POST", {
      biomarkerId: "bm-glucose",
      value: 5.6,
      unit: "mmol/L",
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 6.0,
      takenAt: "2026-05-01T08:00:00.000Z",
    });
    expect(status).toBe(201);
    const dto = json.data!;
    expect(dto.converted).toBe(true);
    expect(dto.unit).toBe("mg/dL");
    expect(dto.value).toBeCloseTo(5.6 * MGDL_PER_MMOL, 9);
    expect(dto.sourceValue).toBe(5.6);
    expect(dto.sourceUnit).toBe("mmol/L");
    // The report's own window moved with the value.
    expect(dto.sourceReferenceLow).toBeCloseTo(3.9 * MGDL_PER_MMOL, 9);
    expect(dto.sourceReferenceHigh).toBeCloseTo(6.0 * MGDL_PER_MMOL, 9);
    // And the verdict is judged against it: 5.6 of 3.9-6.0 is in range.
    expect(dto.rangeStatus).toBe("in-range");

    const row = await prisma.labResult.findUniqueOrThrow({
      where: { id: dto.id },
    });
    expect(row.value).toBeCloseTo(5.6 * MGDL_PER_MMOL, 9);
    expect(row.sourceValue).toBe(5.6);
    expect(row.sourceUnit).toBe("mmol/L");
  });

  it("flags a converted reading outside the printed window as such", async () => {
    const { json } = await call<Dto>("labs", "POST", {
      biomarkerId: "bm-glucose",
      value: 7.2,
      unit: "mmol/L",
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 6.0,
      takenAt: "2026-05-02T08:00:00.000Z",
    });
    expect(json.data!.rangeStatus).toBe("above");
  });

  it("stores a reading in the marker's unit as stated, with no conversion record", async () => {
    const { json } = await call<Dto>("labs", "POST", {
      biomarkerId: "bm-glucose",
      value: 95,
      unit: "mg/dL",
      takenAt: "2026-05-03T08:00:00.000Z",
    });
    const dto = json.data!;
    expect(dto.converted).toBe(false);
    expect(dto.value).toBe(95);
    expect(dto.sourceValue).toBeNull();
    expect(dto.sourceUnit).toBeNull();
  });

  it("links a marker that had no key yet, the first time it is needed", async () => {
    const before = await prisma.biomarker.findUniqueOrThrow({
      where: { id: "bm-glucose" },
    });
    // The marker was created without a key in this test; the first conversion
    // above has already filled it.
    expect(before.analyteKey).toBe("fasting-glucose");
  });

  it("still refuses a pair that cannot be converted, now with the reason", async () => {
    const { status, json } = await call("labs", "POST", {
      biomarkerId: "bm-free",
      value: 5.6,
      unit: "mmol/L",
      takenAt: "2026-05-04T08:00:00.000Z",
    });
    expect(status).toBe(422);
    expect(json.meta).toMatchObject({
      errorCode: "labs.unit.mismatch",
      markerUnit: "mg/dL",
      readingUnit: "mmol/L",
      reason: "unknown_analyte",
    });
    expect(
      await prisma.labResult.count({ where: { biomarkerId: "bm-free" } }),
    ).toBe(0);
  });
});

describe("the OCR commit", () => {
  const row = {
    analyte: "Glucose",
    value: 5.0,
    unit: "mmol/L",
    referenceText: "3.9 - 5.6",
    takenAt: "2026-06-01T08:00:00.000Z",
  };

  it("converts the row and reports it", async () => {
    const { status, json } = await call<{
      inserted: Dto[];
      skipped: unknown[];
    }>("ocr", "POST", { rows: [row] });
    expect(status).toBe(200);
    expect(json.data!.skipped).toEqual([]);
    const [inserted] = json.data!.inserted;
    expect(inserted.converted).toBe(true);
    expect(inserted.unit).toBe("mg/dL");
    expect(inserted.value).toBeCloseTo(5.0 * MGDL_PER_MMOL, 9);
    expect(inserted.sourceValue).toBe(5.0);
    expect(inserted.sourceUnit).toBe("mmol/L");
    expect(inserted.sourceReferenceLow).toBeCloseTo(3.9 * MGDL_PER_MMOL, 9);
    expect(inserted.sourceReferenceHigh).toBeCloseTo(5.6 * MGDL_PER_MMOL, 9);
  });

  it("treats the same scan committed again as a duplicate", async () => {
    const { json } = await call<{
      inserted: unknown[];
      skipped: Array<{ reason: string }>;
    }>("ocr", "POST", { rows: [row] });
    expect(json.data!.inserted).toEqual([]);
    expect(json.data!.skipped.map((s) => s.reason)).toEqual(["duplicate"]);
  });

  it("tells the scan review which analyte the marker is, and flags a re-scan as a duplicate", async () => {
    const { annotateRow } = await import("@/lib/labs/ocr-extract");
    const scanned = {
      analyte: "Glucose",
      value: 5.0,
      valueText: null,
      unit: "mmol/L",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      takenAt: "2026-06-01",
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
    };
    const annotated = await annotateRow(USER, scanned, "2026-06-01", "UTC");
    expect(annotated).toMatchObject({
      biomarkerMatch: "existing",
      markerUnit: "mg/dL",
      markerAnalyteKey: "fasting-glucose",
    });
    // The converted reading from the commit above holds 90.09 mg/dL; the scan
    // says 5.0 mmol/L, which is what the report printed for it.
    expect(annotated.duplicateOf).not.toBeNull();

    // A different value is not a duplicate.
    const other = await annotateRow(
      USER,
      { ...scanned, value: 6.5 },
      "2026-06-01",
      "UTC",
    );
    expect(other.duplicateOf).toBeNull();

    // A marker the registry knows nothing about reports no analyte.
    const free = await annotateRow(
      USER,
      { ...scanned, analyte: "My own marker", unit: "mg/dL" },
      "2026-06-01",
      "UTC",
    );
    expect(free.markerAnalyteKey).toBeNull();
  });

  it("skips a row whose unit cannot be converted, as before", async () => {
    const { json } = await call<{
      inserted: unknown[];
      skipped: Array<{ reason: string }>;
    }>("ocr", "POST", {
      rows: [
        {
          analyte: "My own marker",
          value: 3,
          unit: "mmol/L",
          takenAt: "2026-06-02T08:00:00.000Z",
        },
      ],
    });
    expect(json.data!.inserted).toEqual([]);
    expect(json.data!.skipped.map((s) => s.reason)).toEqual(["unit_mismatch"]);
  });
});

describe("editing and reading back", () => {
  it("clears the conversion record when the value is edited", async () => {
    const created = await call<Dto>("labs", "POST", {
      biomarkerId: "bm-glucose",
      value: 6.0,
      unit: "mmol/L",
      takenAt: "2026-07-01T08:00:00.000Z",
    });
    const id = created.json.data!.id;
    expect(created.json.data!.converted).toBe(true);

    const edited = await call<Dto>("one", "PUT", { value: 110 }, id);
    expect(edited.status).toBe(200);
    expect(edited.json.data!.value).toBe(110);
    expect(edited.json.data!.converted).toBe(false);
    expect(edited.json.data!.sourceValue).toBeNull();
    expect(edited.json.data!.sourceUnit).toBeNull();
  });

  it("keeps the conversion record when only the note is edited", async () => {
    const created = await call<Dto>("labs", "POST", {
      biomarkerId: "bm-glucose",
      value: 6.1,
      unit: "mmol/L",
      takenAt: "2026-07-02T08:00:00.000Z",
    });
    const id = created.json.data!.id;
    const storedValue = created.json.data!.value;
    // The web edit dialog sends the form back whole, the unchanged value
    // included; only a changed value clears the record.
    const edited = await call<Dto>(
      "one",
      "PUT",
      {
        value: storedValue,
        takenAt: "2026-07-02T09:00:00.000Z",
        note: "fasting",
      },
      id,
    );
    expect(edited.status).toBe(200);
    expect(edited.json.data!.value).toBe(storedValue);
    expect(edited.json.data!.converted).toBe(true);
    expect(edited.json.data!.sourceValue).toBe(6.1);
    expect(edited.json.data!.sourceUnit).toBe("mmol/L");
  });

  it("returns the fields on the list and on the single reading", async () => {
    const list = await call<{ results: Dto[] }>("labs", "GET");
    const converted = list.json.data!.results.filter((r) => r.converted);
    expect(converted.length).toBeGreaterThan(0);
    for (const r of converted) {
      expect(r.sourceValue).not.toBeNull();
      expect(r.sourceUnit).not.toBeNull();
    }
    const one = await call<Dto>("one", "GET", undefined, converted[0].id);
    expect(one.json.data!.converted).toBe(true);
  });
});
