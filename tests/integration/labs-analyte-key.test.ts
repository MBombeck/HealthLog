/**
 * A marker is linked to its analyte, and the link follows its name and unit.
 *
 * `Biomarker.analyteKey` says which analyte a marker is, so a reading in another
 * unit can be converted (#1095). There is no manual choice: the key is derived
 * from the name and unit. It is set when a marker is created, by all three
 * creation paths, re-derived when a rename or unit change moves it, and, for a
 * marker that already exists, brought in line the first time it is needed.
 * Against a real Postgres:
 *   - a marker created by name is linked when the name is a known analyte and
 *     its unit is one the analyte reaches, and left null otherwise;
 *   - the key reaches the API response;
 *   - a rename moves the key, or clears it, and the next reading in another
 *     unit converts with the new analyte's factor;
 *   - `ensureAnalyteKey` fills a null key, replaces one that disagrees with the
 *     name, and two concurrent calls converge;
 *   - the mint path used by the lab writes and the legacy backfill set it too.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { runLabBiomarkerBackfillForUser } from "@/lib/jobs/lab-biomarker-backfill";
import { ensureAnalyteKey } from "@/lib/labs/analyte-key-store";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";

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
const USER = "analyte-key-user";

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
});

async function post(body: Record<string, unknown>) {
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const { POST } = await import("@/app/api/biomarkers/route");
  return POST(
    new NextRequest("http://localhost/api/biomarkers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/biomarkers", () => {
  it("links a marker whose name is a known analyte, and returns the key", async () => {
    const res = await post({ name: "Blutzucker", unit: "mg/dL" });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { analyteKey: string } };
    expect(data.analyteKey).toBe("fasting-glucose");
    const row = await prisma.biomarker.findFirst({
      where: { userId: USER, name: "Blutzucker" },
    });
    expect(row?.analyteKey).toBe("fasting-glucose");
  });

  it("links a catalog seed by its localised name", async () => {
    const res = await post({ name: "Gesamtcholesterin", unit: "mg/dL" });
    const { data } = (await res.json()) as { data: { analyteKey: string } };
    expect(data.analyteKey).toBe("total-cholesterol");
  });

  it("stores the catalog slug for LDL and HDL, and converts them as cholesterol", async () => {
    for (const [name, key] of [
      ["LDL cholesterol", "ldl"],
      ["HDL-Cholesterin", "hdl"],
    ]) {
      const res = await post({ name, unit: "mg/dL" });
      const { data } = (await res.json()) as { data: { analyteKey: string } };
      expect(data.analyteKey, name).toBe(key);
    }
    const ldl = await prisma.biomarker.findFirstOrThrow({
      where: { userId: USER, name: "LDL cholesterol" },
    });
    const reading = await postReading({
      biomarkerId: ldl.id,
      value: 3,
      unit: "mmol/L",
      takenAt: "2026-05-04T08:00:00.000Z",
    });
    expect(reading.status).toBe(201);
    const { data: dto } = (await reading.json()) as {
      data: { value: number; converted: boolean };
    };
    expect(dto.converted).toBe(true);
    // 3 mmol/L x 38.6664 (C27H46O, 386.664 g/mol).
    expect(dto.value.toFixed(2)).toBe("116.00");
  });

  it("leaves a free name, and a known name in an unreachable unit, unlinked", async () => {
    for (const [name, unit] of [
      ["My own marker", "mg/dL"],
      ["Glucose", "mEq/L"],
      ["Calcium (ionisiert)", "mmol/L"],
    ]) {
      const res = await post({ name, unit });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { analyteKey: string | null };
      };
      expect(data.analyteKey, name).toBeNull();
    }
  });
});

async function patch(id: string, body: Record<string, unknown>) {
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const { PUT } = await import("@/app/api/biomarkers/[id]/route");
  return PUT(
    new NextRequest(`http://localhost/api/biomarkers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function postReading(body: Record<string, unknown>) {
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const { POST } = await import("@/app/api/labs/route");
  return POST(
    new NextRequest("http://localhost/api/labs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PUT /api/biomarkers/[id]", () => {
  it("moves the key with a rename, and the next reading converts with the new analyte", async () => {
    const created = await post({ name: "Blood sugar", unit: "mg/dL" });
    const { data: marker } = (await created.json()) as {
      data: { id: string; analyteKey: string | null };
    };
    expect(marker.analyteKey).toBe("fasting-glucose");

    const res = await patch(marker.id, { name: "Cholesterol" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { analyteKey: string | null };
    };
    expect(body.data.analyteKey).toBe("total-cholesterol");
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBe("total-cholesterol");

    // 5.2 mmol/L of cholesterol is 201.07 mg/dL (C27H46O, 386.664 g/mol). With
    // the glucose key left over it would have been stored as 93.7.
    const reading = await postReading({
      biomarkerId: marker.id,
      value: 5.2,
      unit: "mmol/L",
      takenAt: "2026-05-03T08:00:00.000Z",
    });
    expect(reading.status).toBe(201);
    const { data: dto } = (await reading.json()) as {
      data: { value: number; unit: string; converted: boolean };
    };
    expect(dto.converted).toBe(true);
    expect(dto.unit).toBe("mg/dL");
    expect(dto.value.toFixed(2)).toBe("201.07");
  });

  it("clears the key when the new name matches no analyte", async () => {
    const created = await post({ name: "Harnstoff", unit: "mg/dL" });
    const { data: marker } = (await created.json()) as {
      data: { id: string; analyteKey: string | null };
    };
    expect(marker.analyteKey).toBe("urea");
    const res = await patch(marker.id, { name: "Harnstoff (eigene Notiz)" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { analyteKey: string | null } };
    expect(body.data.analyteKey).toBeNull();
  });

  it("re-derives the key when the unit changes on a marker without readings", async () => {
    const created = await post({ name: "Glukose", unit: "mEq/L" });
    const { data: marker } = (await created.json()) as {
      data: { id: string; analyteKey: string | null };
    };
    expect(marker.analyteKey).toBeNull();
    const res = await patch(marker.id, { unit: "mg/dL" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { analyteKey: string | null } };
    expect(body.data.analyteKey).toBe("fasting-glucose");
  });

  it("leaves the key alone on an edit that touches neither name nor unit", async () => {
    const created = await post({ name: "Kalzium gesamt", unit: "mmol/L" });
    const { data: marker } = (await created.json()) as { data: { id: string } };
    const res = await patch(marker.id, { lowerBound: 2.1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { analyteKey: string | null } };
    expect(body.data.analyteKey).toBe("calcium-total");
  });
});

describe("ensureAnalyteKey", () => {
  it("fills a null key once", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Harnsäure", unit: "µmol/L" },
    });
    expect(marker.analyteKey).toBeNull();
    expect(await ensureAnalyteKey(prisma, marker)).toBe("uric-acid");
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBe("uric-acid");
  });

  // This used to pin the opposite: a set key was never replaced. With no
  // manual choice of analyte, a key that disagrees with the name can only be
  // left over from a rename (or written in an older form), and keeping it
  // converted readings with the wrong analyte's factor. So the key follows the
  // name.
  it("replaces a key that disagrees with the marker's name", async () => {
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER,
        name: "Blood glucose",
        unit: "mg/dL",
        analyteKey: "hba1c",
      },
    });
    expect(await ensureAnalyteKey(prisma, marker)).toBe("fasting-glucose");
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBe("fasting-glucose");
  });

  it("clears a key when the name matches no analyte", async () => {
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER,
        name: "Some other marker",
        unit: "mg/dL",
        analyteKey: "fasting-glucose",
      },
    });
    expect(await ensureAnalyteKey(prisma, marker)).toBeNull();
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBeNull();
  });

  it("re-reads the row when the caller's copy is stale", async () => {
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER,
        name: "Urea",
        unit: "mg/dL",
        analyteKey: "urea",
      },
    });
    // A copy read before the key was set: the gated write misses, the row as it
    // stands already agrees, and nothing is overwritten.
    expect(
      await ensureAnalyteKey(prisma, { ...marker, analyteKey: null }),
    ).toBe("urea");
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBe("urea");
  });

  it("corrects a key stored as the registry entry rather than the catalog slug", async () => {
    // Before the slug was stored, an LDL marker got the cholesterol entry's
    // key. Same conversion, wrong identity; the fill step rewrites it once.
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER,
        name: "LDL-Cholesterin",
        unit: "mg/dL",
        analyteKey: "total-cholesterol",
      },
    });
    expect(await ensureAnalyteKey(prisma, marker)).toBe("ldl");
    const row = await prisma.biomarker.findUnique({ where: { id: marker.id } });
    expect(row?.analyteKey).toBe("ldl");
    // And a second run changes nothing.
    expect(await ensureAnalyteKey(prisma, row!)).toBe("ldl");
  });

  it("converges when two callers fill the same marker", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Kreatinin", unit: "mg/dL" },
    });
    const [a, b] = await Promise.all([
      ensureAnalyteKey(prisma, marker),
      ensureAnalyteKey(prisma, marker),
    ]);
    expect(a).toBe("creatinine");
    expect(b).toBe("creatinine");
  });

  it("leaves a marker with no analyte null", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Ferritin", unit: "ng/mL" },
    });
    expect(await ensureAnalyteKey(prisma, marker)).toBeNull();
  });
});

describe("the other creation paths", () => {
  it("links a marker minted by a lab write", async () => {
    const minted = await resolveOrMintBiomarker(USER, {
      analyte: "Gesamtbilirubin",
      unit: "µmol/L",
      referenceLow: null,
      referenceHigh: null,
      panel: null,
    });
    const row = await prisma.biomarker.findUnique({ where: { id: minted.id } });
    expect(row?.analyteKey).toBe("bilirubin-total");
  });

  it("links a marker the legacy backfill mints", async () => {
    await prisma.labResult.create({
      data: {
        userId: USER,
        analyte: "Kalzium",
        value: 2.4,
        unit: "mmol/L",
        takenAt: new Date("2026-05-01T08:00:00Z"),
        source: "MANUAL",
      },
    });
    await runLabBiomarkerBackfillForUser(USER);
    const row = await prisma.biomarker.findFirst({
      where: { userId: USER, name: "Kalzium" },
    });
    expect(row?.analyteKey).toBe("calcium-total");
  });
});
