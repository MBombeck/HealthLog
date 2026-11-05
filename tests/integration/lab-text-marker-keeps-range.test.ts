/**
 * A marker minted from a text result keeps the range the report printed.
 *
 * A report that prints "SEE NOTE" for a ratio, with "10 - 20" in the range
 * column beside it, minted a marker with no bounds: every import path read the
 * range only for a numeric reading. The next report's number then had nothing
 * to be judged against. A numeric range now seeds the new marker the way a
 * numeric first reading does; a range that is text itself ("NEGATIVE") is not
 * a bound and stays out, and a marker that already exists keeps its own.
 *
 * Every path that mints markers from an import, against Postgres: a document's
 * confirmed facts, the lab scan commit, a free-text reading through
 * `POST /api/labs` (the on-device scan posts there), and the CSV import.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { textToStream } from "@/lib/import/csv-stream";
import { importLabsCsv } from "@/lib/import/labs-csv";
import { labsCsvQuerySchema } from "@/lib/validations/record-import";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

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
const USER = "text-marker-range-user";
const TAKEN_AT = "2026-09-01T12:00:00.000Z";

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      timezone: "UTC",
      modulePreferencesJson: { inboundDocuments: true, labs: true },
    },
  });
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
});

function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bounds(name: string) {
  const marker = await prisma.biomarker.findFirstOrThrow({
    where: { userId: USER, name },
  });
  return { low: marker.lowerBound, high: marker.upperBound, id: marker.id };
}

async function seedMarker(name: string) {
  return prisma.biomarker.create({
    data: { userId: USER, name, unit: "", lowerBound: 1, upperBound: 2 },
  });
}

// --- document facts ---------------------------------------------------------

async function confirmTextFact(
  label: string,
  referenceText: string,
  referenceLow: number | null,
  referenceHigh: number | null,
) {
  const { encryptFactData, encryptFactProvenance } =
    await import("@/lib/documents/store");
  const doc = await prisma.inboundDocument.create({
    data: {
      userId: USER,
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      contentEncrypted: Buffer.from("stand-in for the stored bytes"),
      status: "EXTRACTED",
      reportDate: new Date(TAKEN_AT),
    },
  });
  const fact = await prisma.extractedFact.create({
    data: {
      documentId: doc.id,
      userId: USER,
      factType: "OBSERVATION",
      status: "PENDING",
      confidence: 0.95,
      needsReview: false,
      dataEncrypted: encryptFactData({
        label,
        code: null,
        codeSystem: null,
        value: null,
        valueText: "SEE NOTE",
        unit: null,
        referenceLow,
        referenceHigh,
        referenceText,
        effectiveDate: null,
      }),
      provenanceEncrypted: encryptFactProvenance({
        sourceText: `${label} SEE NOTE ${referenceText}`,
        anchored: true,
        sourceOffset: 0,
        page: 0,
        confidence: 0.95,
      }),
    },
  });
  const { POST } =
    await import("@/app/api/documents/inbound/[id]/confirm/route");
  const res = await POST(
    jsonReq(`/api/documents/inbound/${doc.id}/confirm`, {
      decisions: [{ factId: fact.id, action: "approve" }],
    }),
    { params: Promise.resolve({ id: doc.id }) },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.failed).toEqual([]);
}

describe("a document's text result", () => {
  it("gives a new marker the numeric range printed beside it", async () => {
    await confirmTextFact("BUN/Creatinine ratio", "10 - 20", null, null);
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 10,
      high: 20,
    });
  });

  it("does not turn a text range into bounds", async () => {
    await confirmTextFact("Urine nitrite", "NEGATIVE", null, null);
    expect(await bounds("Urine nitrite")).toMatchObject({
      low: null,
      high: null,
    });
  });

  it("leaves an existing marker's range alone", async () => {
    await seedMarker("BUN/Creatinine ratio");
    await confirmTextFact("BUN/Creatinine ratio", "10 - 20", 10, 20);
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 1,
      high: 2,
    });
  });
});

// --- lab scan commit --------------------------------------------------------

async function commitScanRows(rows: Record<string, unknown>[]) {
  const { POST } = await import("@/app/api/labs/ocr/commit/route");
  const res = await POST(
    jsonReq("/api/labs/ocr/commit", {
      rows: rows.map((row) => ({ takenAt: TAKEN_AT, ...row })),
    }),
  );
  expect(res.status).toBe(200);
}

describe("a scanned text result", () => {
  it("gives a new marker the confirmed bounds", async () => {
    await commitScanRows([
      {
        analyte: "BUN/Creatinine ratio",
        valueText: "SEE NOTE",
        referenceLow: 10,
        referenceHigh: 20,
        referenceText: "10 - 20",
      },
    ]);
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 10,
      high: 20,
    });
  });

  it("derives them from the printed range when no bounds were sent", async () => {
    await commitScanRows([
      {
        analyte: "BUN/Creatinine ratio",
        valueText: "SEE NOTE",
        referenceText: "10 - 20",
      },
      { analyte: "Urine nitrite", valueText: "neg", referenceText: "NEGATIVE" },
    ]);
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 10,
      high: 20,
    });
    expect(await bounds("Urine nitrite")).toMatchObject({
      low: null,
      high: null,
    });
  });

  it("drops a transposed window instead of minting it", async () => {
    await commitScanRows([
      {
        analyte: "BUN/Creatinine ratio",
        valueText: "SEE NOTE",
        referenceLow: 20,
        referenceHigh: 10,
      },
    ]);
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: null,
      high: null,
    });
  });

  it("leaves an existing marker's range alone", async () => {
    await seedMarker("BUN/Creatinine ratio");
    await commitScanRows([
      {
        analyte: "BUN/Creatinine ratio",
        valueText: "SEE NOTE",
        referenceLow: 10,
        referenceHigh: 20,
      },
    ]);
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 1,
      high: 2,
    });
  });
});

// --- POST /api/labs ---------------------------------------------------------

async function postLab(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/labs/route");
  const res = await POST(jsonReq("/api/labs", { takenAt: TAKEN_AT, ...body }));
  expect(res.status).toBe(201);
  return (await res.json()).data;
}

describe("a free-text reading that is a text result", () => {
  it("seeds the new marker, and the next number is judged against it", async () => {
    await postLab({
      analyte: "BUN/Creatinine ratio",
      valueText: "SEE NOTE",
      referenceLow: 10,
      referenceHigh: 20,
    });
    const { id } = await bounds("BUN/Creatinine ratio");
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 10,
      high: 20,
    });
    await postLab({
      biomarkerId: id,
      value: 18,
      unit: "1",
      takenAt: "2026-10-01T12:00:00.000Z",
    });
    const reading = await prisma.labResult.findFirstOrThrow({
      where: { biomarkerId: id, value: { not: null } },
    });
    expect(reading).toMatchObject({ referenceLow: 10, referenceHigh: 20 });
  });
});

// --- CSV import -------------------------------------------------------------

describe("a CSV text result", () => {
  const query = () =>
    labsCsvQuerySchema.parse({
      analyte: "0",
      value: "1",
      unit: "2",
      date: "3",
      referenceRange: "4",
    });

  it("gives a new marker a numeric range and leaves a text range out", async () => {
    const result = await importLabsCsv({
      userId: USER,
      tz: "UTC",
      stream: textToStream(
        [
          "Analyte;Value;Unit;Date;Range",
          "BUN/Creatinine ratio;SEE NOTE;;2026-09-01;10 - 20",
          "Urine nitrite;neg;;2026-09-01;NEGATIVE",
        ].join("\n"),
      ),
      maxBytes: 1_000_000,
      query: query(),
    });
    expect(result).toMatchObject({ inserted: 2 });
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 10,
      high: 20,
    });
    expect(await bounds("Urine nitrite")).toMatchObject({
      low: null,
      high: null,
    });
    // The text reading itself still carries no window of its own.
    const reading = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER, analyte: "BUN/Creatinine ratio" },
    });
    expect(reading).toMatchObject({
      valueText: "SEE NOTE",
      sourceReferenceLow: null,
      sourceReferenceHigh: null,
    });
  });

  it("leaves an existing marker's range alone", async () => {
    await seedMarker("BUN/Creatinine ratio");
    await importLabsCsv({
      userId: USER,
      tz: "UTC",
      stream: textToStream(
        "Analyte;Value;Unit;Date;Range\nBUN/Creatinine ratio;SEE NOTE;;2026-09-01;10 - 20\n",
      ),
      maxBytes: 1_000_000,
      query: query(),
    });
    expect(await bounds("BUN/Creatinine ratio")).toMatchObject({
      low: 1,
      high: 2,
    });
  });
});
