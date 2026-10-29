/**
 * A lab value without its own date, confirmed from a stored document, against
 * a real Postgres and through the real confirm route.
 *
 * A lab report usually prints the collection date once, in its header. The
 * extraction puts that date on the document (`reportDate`) and leaves each
 * value's own date empty, so the confirm step has to date the value by its
 * document. It used to file every such reading under the moment it was
 * confirmed, so a report from years ago showed up as today's results.
 *
 * The route reads the document's two dates once and hands them to the commit
 * step: the report date first, else the filing date (`documentDate`), the order
 * the day view places a document by. A value's own date still wins, but only
 * when it names a real calendar day.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-undated-lab-value";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "undated-lab-value",
      email: "undated-lab-value@example.test",
      modulePreferencesJson: { inboundDocuments: true, labs: true },
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  for (const [name, unit] of [
    ["Ferritin", "ng/mL"],
    ["Glucose", "mmol/L"],
    ["Haemoglobin", "g/L"],
  ]) {
    await prisma.biomarker.create({ data: { userId: USER_ID, name, unit } });
  }
});

const noon = (day: string) => new Date(`${day}T12:00:00.000Z`);

async function storedDocument(dates: {
  reportDate: string | null;
  documentDate: string | null;
}) {
  return getPrismaClient().inboundDocument.create({
    data: {
      userId: USER_ID,
      filename: "befund.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      contentEncrypted: Buffer.from("stand-in for the stored bytes"),
      status: "EXTRACTED",
      reportDate: dates.reportDate ? noon(dates.reportDate) : null,
      documentDate: dates.documentDate ? noon(dates.documentDate) : null,
    },
  });
}

async function stagedValue(
  documentId: string,
  label: string,
  value: number,
  unit: string,
  effectiveDate: string | null,
) {
  const { encryptFactData, encryptFactProvenance } =
    await import("@/lib/documents/store");
  return getPrismaClient().extractedFact.create({
    data: {
      documentId,
      userId: USER_ID,
      factType: "OBSERVATION",
      status: "PENDING",
      confidence: 0.95,
      needsReview: false,
      dataEncrypted: encryptFactData({
        label,
        code: null,
        codeSystem: null,
        value,
        valueText: null,
        unit,
        referenceLow: null,
        referenceHigh: null,
        referenceText: null,
        effectiveDate,
      }),
      provenanceEncrypted: encryptFactProvenance({
        sourceText: `${label} ${value} ${unit}`,
        anchored: true,
        sourceOffset: 0,
        page: 0,
        confidence: 0.95,
      }),
    },
  });
}

async function confirm(documentId: string, factIds: string[]) {
  const { POST } =
    await import("@/app/api/documents/inbound/[id]/confirm/route");
  const res = await POST(
    new NextRequest(
      `http://localhost/api/documents/inbound/${documentId}/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decisions: factIds.map((factId) => ({ factId, action: "approve" })),
        }),
      },
    ),
    { params: Promise.resolve({ id: documentId }) },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.failed).toEqual([]);
  expect(body.data.approved).toHaveLength(factIds.length);
  return body.data.approved as { factId: string; recordId: string }[];
}

async function takenAtOf(recordId: string) {
  const row = await getPrismaClient().labResult.findUniqueOrThrow({
    where: { id: recordId },
  });
  return row.takenAt.toISOString();
}

describe("an undated lab value is dated by its document", () => {
  it("takes the report date over the filing date, keeps a value's own date, and ignores an impossible one", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Collection date printed once in the header; filed today (the upload-day
    // default for documentDate).
    const doc = await storedDocument({
      reportDate: "2021-03-01",
      documentDate: today,
    });
    const undated = await stagedValue(doc.id, "Ferritin", 80, "ng/mL", null);
    const ownDate = await stagedValue(
      doc.id,
      "Glucose",
      5.1,
      "mmol/L",
      "2021-02-20",
    );
    const impossible = await stagedValue(
      doc.id,
      "Haemoglobin",
      142,
      "g/L",
      "2021-02-30",
    );

    const approved = await confirm(doc.id, [
      undated.id,
      ownDate.id,
      impossible.id,
    ]);
    const recordOf = (factId: string) =>
      approved.find((a) => a.factId === factId)!.recordId;

    expect(await takenAtOf(recordOf(undated.id))).toBe(
      "2021-03-01T12:00:00.000Z",
    );
    expect(await takenAtOf(recordOf(ownDate.id))).toBe(
      "2021-02-20T12:00:00.000Z",
    );
    // Not 2 March: a day the month does not have is no date at all.
    expect(await takenAtOf(recordOf(impossible.id))).toBe(
      "2021-03-01T12:00:00.000Z",
    );
  });

  it("takes the filing date when the document has no report date", async () => {
    const doc = await storedDocument({
      reportDate: null,
      documentDate: "2021-02-15",
    });
    const undated = await stagedValue(doc.id, "Ferritin", 80, "ng/mL", null);

    const [approved] = await confirm(doc.id, [undated.id]);

    expect(await takenAtOf(approved!.recordId)).toBe(
      "2021-02-15T12:00:00.000Z",
    );
  });
});
