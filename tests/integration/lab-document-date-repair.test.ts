/**
 * The one-shot repair of lab values a document confirm filed under the
 * moment of confirmation (real Postgres).
 *
 * Before the confirm step dated an undated value by its document, such a
 * value got `takenAt = now`, the same instant as its `createdAt`. The repair
 * moves exactly those to the document's report date (else its filing date)
 * at noon UTC, and leaves alone a value with a date of its own, a value that
 * really was taken on its confirmation day in the owner's zone, one the
 * person re-dated since, and one whose document has no date. A second run
 * changes nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { encryptFactData, encryptFactProvenance } from "@/lib/documents/store";
import { repairUndatedDocumentLabValues } from "@/lib/jobs/lab-document-date-repair";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-lab-document-date-repair";
const noon = (day: string) => new Date(`${day}T12:00:00.000Z`);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: "lab-date-repair",
      email: "lab-date-repair@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

/**
 * A document, one confirmed value from it and the fact that links the two,
 * as the confirm route left them.
 */
async function confirmedValue(opts: {
  id: string;
  reportDate: string | null;
  documentDate: string | null;
  effectiveDate: string | null;
  createdAt: Date;
  takenAt: Date;
}) {
  const prisma = getPrismaClient();
  const doc = await prisma.inboundDocument.create({
    data: {
      userId: USER,
      filename: `${opts.id}.pdf`,
      mimeType: "application/pdf",
      byteSize: 1024,
      contentEncrypted: Buffer.from("stand-in for the stored bytes"),
      status: "CONFIRMED",
      reportDate: opts.reportDate ? noon(opts.reportDate) : null,
      documentDate: opts.documentDate ? noon(opts.documentDate) : null,
    },
  });
  await prisma.labResult.create({
    data: {
      id: opts.id,
      userId: USER,
      analyte: "Ferritin",
      value: 80,
      unit: "ng/mL",
      source: "DOCUMENT",
      takenAt: opts.takenAt,
      createdAt: opts.createdAt,
    },
  });
  await prisma.extractedFact.create({
    data: {
      documentId: doc.id,
      userId: USER,
      factType: "OBSERVATION",
      status: "APPROVED",
      confidence: 0.95,
      needsReview: false,
      dataEncrypted: encryptFactData({
        label: "Ferritin",
        code: null,
        codeSystem: null,
        value: 80,
        valueText: null,
        unit: "ng/mL",
        referenceLow: null,
        referenceHigh: null,
        referenceText: null,
        effectiveDate: opts.effectiveDate,
      }),
      provenanceEncrypted: encryptFactProvenance({
        sourceText: "Ferritin 80 ng/mL",
        anchored: true,
        sourceOffset: 0,
        page: 0,
        confidence: 0.95,
      }),
      committedRecordId: opts.id,
      committedRecordType: "labResult",
    },
  });
}

async function takenAt(): Promise<Record<string, string>> {
  const rows = await getPrismaClient().labResult.findMany({
    where: { userId: USER },
    select: { id: true, takenAt: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r.takenAt.toISOString()]));
}

describe("lab document date repair", () => {
  it("moves only values filed under their confirmation moment, and converges", async () => {
    const confirmed = new Date("2026-10-20T08:00:00.123Z");

    // Collection date in the header, value undated, filed at confirmation.
    await confirmedValue({
      id: "misdated",
      reportDate: "2021-03-01",
      documentDate: "2026-10-18",
      effectiveDate: null,
      createdAt: confirmed,
      takenAt: confirmed,
    });
    // No report date: the filing date is the document's day.
    await confirmedValue({
      id: "misdated-filing-date",
      reportDate: null,
      documentDate: "2021-02-15",
      effectiveDate: null,
      createdAt: confirmed,
      takenAt: new Date(confirmed.getTime() + 2),
    });
    // Its own date, even where the row looks like a confirmation moment.
    await confirmedValue({
      id: "own-date",
      reportDate: "2021-03-01",
      documentDate: null,
      effectiveDate: "2021-02-20",
      createdAt: confirmed,
      takenAt: confirmed,
    });
    // Confirmed at 00:30 in Berlin on the report day itself: 22:30 UTC the
    // evening before, which a UTC comparison would have moved.
    const justAfterMidnight = new Date("2026-10-19T22:30:00.000Z");
    await confirmedValue({
      id: "taken-on-confirm-day",
      reportDate: "2026-10-20",
      documentDate: "2026-10-20",
      effectiveDate: null,
      createdAt: justAfterMidnight,
      takenAt: justAfterMidnight,
    });
    // Re-dated by the person after the confirm.
    await confirmedValue({
      id: "re-dated",
      reportDate: "2021-03-01",
      documentDate: null,
      effectiveDate: null,
      createdAt: confirmed,
      takenAt: new Date("2026-10-01T07:45:00.000Z"),
    });
    // A document with no date at all leaves nothing to move to.
    await confirmedValue({
      id: "undated-document",
      reportDate: null,
      documentDate: null,
      effectiveDate: null,
      createdAt: confirmed,
      takenAt: confirmed,
    });

    const before = await takenAt();
    const first = await repairUndatedDocumentLabValues(getPrismaClient());

    expect(first.updated).toBe(2);
    expect(await takenAt()).toEqual({
      ...before,
      misdated: "2021-03-01T12:00:00.000Z",
      "misdated-filing-date": "2021-02-15T12:00:00.000Z",
    });

    const afterFirst = await takenAt();
    const second = await repairUndatedDocumentLabValues(getPrismaClient());
    expect(second.updated).toBe(0);
    expect(await takenAt()).toEqual(afterFirst);
  });

  it("leaves a lab value alone when a second fact also names it", async () => {
    const confirmed = new Date("2026-10-20T08:00:00.000Z");
    await confirmedValue({
      id: "linked-twice",
      reportDate: "2021-03-01",
      documentDate: null,
      effectiveDate: null,
      createdAt: confirmed,
      takenAt: confirmed,
    });
    const prisma = getPrismaClient();
    const second = await prisma.inboundDocument.create({
      data: {
        userId: USER,
        filename: "other.pdf",
        mimeType: "application/pdf",
        byteSize: 1,
        contentEncrypted: Buffer.from("x"),
        reportDate: noon("2020-01-01"),
      },
    });
    const fact = await prisma.extractedFact.findFirstOrThrow({
      where: { committedRecordId: "linked-twice" },
    });
    await prisma.extractedFact.create({
      data: {
        documentId: second.id,
        userId: USER,
        factType: "OBSERVATION",
        status: "APPROVED",
        dataEncrypted: fact.dataEncrypted,
        provenanceEncrypted: fact.provenanceEncrypted,
        committedRecordId: "linked-twice",
        committedRecordType: "labResult",
      },
    });

    const result = await repairUndatedDocumentLabValues(prisma);

    expect(result.updated).toBe(0);
    expect((await takenAt())["linked-twice"]).toBe(confirmed.toISOString());
  });
});
