/**
 * The whole path a printed reference range travels, against a real Postgres.
 *
 * The failure this pins is a two-ended one: until now the document reading
 * pulled the value off a lab report and dropped the range printed beside it,
 * and every end of that pipe looked healthy on its own. So the assertions here
 * follow ONE range through the real assembly rather than checking each end in
 * isolation:
 *
 *   extract  → the staged fact carries the printed string
 *   commit   → the written row carries the derived bounds AND the string
 *   read     → the API DTO serves both windows and says which is in force
 *   verdict  → the reading is judged against the REPORT's window, not the
 *              catalog band — the case where the two disagree is the point
 *   report   → the doctor-report payload and the FHIR bundle agree with it
 *
 * The catalog band is deliberately set so that the same number reads
 * "in-range" against the report and "above" against the catalog. A test whose
 * two windows agree cannot tell whether the precedence rule is wired at all.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-lab-source-range";

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
      username: "lab-source-range",
      email: "lab-source-range@example.test",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

/** The catalog band the marker carries. 5.2 sits ABOVE this window. */
const CATALOG = { lowerBound: 3.5, upperBound: 5.0 };
/** The window the report printed. 5.2 sits INSIDE this one. */
const PRINTED = "3,9 - 5,4";
const VALUE = 5.2;

async function seedMarker() {
  return getPrismaClient().biomarker.create({
    data: { userId: USER_ID, name: "Kalium", unit: "mmol/L", ...CATALOG },
  });
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/labs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readDto(analyte = "Kalium") {
  const { GET } = await import("@/app/api/labs/route");
  const res = await GET(
    new NextRequest(`http://localhost/api/labs?analyte=${analyte}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.results[0];
}

describe("a printed reference range, end to end", () => {
  it("survives the document path onto the row and governs its verdict", async () => {
    const prisma = getPrismaClient();
    const marker = await seedMarker();

    // The document path, through the REAL commit helper the confirm route
    // calls. The fact carries what a report prints: a value, a unit, and a
    // window stated in German notation beside it.
    const { commitApprovedFact } = await import("@/lib/documents/commit");
    const { encryptFactData, encryptFactProvenance } =
      await import("@/lib/documents/store");
    const doc = await prisma.inboundDocument.create({
      data: {
        userId: USER_ID,
        filename: "befund.pdf",
        mimeType: "application/pdf",
        byteSize: 1024,
        contentEncrypted: Buffer.from("stand-in for the stored bytes"),
        status: "EXTRACTED",
      },
    });
    const fact = await prisma.extractedFact.create({
      data: {
        documentId: doc.id,
        userId: USER_ID,
        factType: "OBSERVATION",
        status: "APPROVED",
        confidence: 0.9,
        needsReview: false,
        dataEncrypted: encryptFactData({
          label: "Kalium",
          code: null,
          codeSystem: null,
          value: VALUE,
          valueText: null,
          unit: "mmol/L",
          referenceLow: null,
          referenceHigh: null,
          referenceText: PRINTED,
          effectiveDate: "2026-07-01",
        }),
        provenanceEncrypted: encryptFactProvenance({
          sourceText: "Kalium 5,2 mmol/l 3,9 - 5,4",
          anchored: true,
          sourceOffset: 0,
          page: 0,
          confidence: 0.9,
        }),
      },
    });

    const ref = await commitApprovedFact(USER_ID, fact);
    expect(ref.recordType).toBe("labResult");

    // The row carries BOTH readings of the printed window: the bounds derived
    // from it and the string itself.
    const row = await prisma.labResult.findUniqueOrThrow({
      where: { id: ref.recordId },
    });
    expect(row.sourceReferenceLow).toBe(3.9);
    expect(row.sourceReferenceHigh).toBe(5.4);
    expect(row.sourceReferenceText).toBe(PRINTED);
    // The catalog stamp is untouched — the marker already existed, so the
    // document's window did not rewrite the user's own band.
    expect(row.referenceLow).toBe(CATALOG.lowerBound);
    expect(row.referenceHigh).toBe(CATALOG.upperBound);
    const markerAfter = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(markerAfter.lowerBound).toBe(CATALOG.lowerBound);
    expect(markerAfter.upperBound).toBe(CATALOG.upperBound);

    // The read side serves both windows, names the winner, and flags that the
    // two disagree.
    const dto = await readDto();
    expect(dto).toMatchObject({
      value: VALUE,
      referenceLow: 3.9,
      referenceHigh: 5.4,
      catalogReferenceLow: CATALOG.lowerBound,
      catalogReferenceHigh: CATALOG.upperBound,
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 5.4,
      sourceReferenceText: PRINTED,
      referenceOrigin: "source",
      referenceDivergesFromCatalog: true,
    });

    // The verdict is the point. Against the catalog band 5.2 is above range;
    // against the window the lab printed it is inside it, and the lab's window
    // is the one the physician read the value against.
    expect(dto.rangeStatus).toBe("in-range");

    // The doctor report reads the same window, and prints the report's own
    // string rather than a reformatted version of it.
    const { loadLabResults } =
      await import("@/lib/doctor-report/clinical-records");
    const labs = await loadLabResults(
      USER_ID,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-12-31T23:59:59.000Z"),
    );
    expect(labs?.[0]).toMatchObject({
      referenceLow: 3.9,
      referenceHigh: 5.4,
      catalogReferenceLow: CATALOG.lowerBound,
      catalogReferenceHigh: CATALOG.upperBound,
      sourceReferenceText: PRINTED,
      referenceOrigin: "source",
      referenceDivergesFromCatalog: true,
    });

    // FHIR exports the same window — a receiver that trusts referenceRange
    // must not be handed the catalog band while the app shows another.
    const { labObservations } = await import("@/lib/fhir/resources/labs");
    let seq = 0;
    const observations = labObservations(
      { labResults: labs } as Parameters<typeof labObservations>[0],
      () => `obs-${++seq}`,
    );
    expect(observations[0].referenceRange?.[0]).toMatchObject({
      low: { value: 3.9 },
      high: { value: 5.4 },
      text: PRINTED,
    });
  });

  it("keeps a converted reading's printed text as evidence, never as the window of the converted value", async () => {
    const prisma = getPrismaClient();
    // A glucose marker tracked in mg/dL; the report prints mmol/L.
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER_ID,
        name: "Glucose",
        unit: "mg/dL",
        lowerBound: 70,
        upperBound: 100,
      },
    });
    const PRINTED_MMOL = "3,9 - 5,5 mmol/l";
    const { POST } = await import("@/app/api/labs/route");
    const res = await POST(
      postReq({
        biomarkerId: marker.id,
        value: 5.6,
        unit: "mmol/L",
        sourceReferenceLow: 3.9,
        sourceReferenceHigh: 5.5,
        sourceReferenceText: PRINTED_MMOL,
        takenAt: "2026-07-03T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(201);

    // The record keeps what the report printed, verbatim.
    const row = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER_ID },
    });
    expect(row.sourceReferenceText).toBe(PRINTED_MMOL);
    expect(row.sourceUnit).toBe("mmol/L");

    // The DTO states the window in force in mg/dL only, and hands the printed
    // text over separately, beside the unit it is in.
    const dto = await readDto("Glucose");
    expect(dto.converted).toBe(true);
    expect(dto.unit).toBe("mg/dL");
    expect(dto.referenceOrigin).toBe("source");
    expect(dto.referenceLow).toBeCloseTo(3.9 * 18.0182, 6);
    expect(dto.referenceHigh).toBeCloseTo(5.5 * 18.0182, 6);
    expect(dto.sourceReferenceText).toBeNull();
    expect(dto.printedReferenceText).toBe(PRINTED_MMOL);
    expect(dto.sourceUnit).toBe("mmol/L");

    // The doctor report has no mmol/L text to print beside mg/dL numbers.
    const { loadLabResults } =
      await import("@/lib/doctor-report/clinical-records");
    const labs = await loadLabResults(
      USER_ID,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-12-31T23:59:59.000Z"),
    );
    expect(labs?.[0].sourceReferenceText).toBeNull();
    expect(labs?.[0].referenceLow).toBeCloseTo(3.9 * 18.0182, 6);
    // ...but it carries the printed figure, so the converted value prints
    // with the precision the report gave it rather than a float's tail.
    expect(labs?.[0].sourceValue).toBe(5.6);
    const { formatLabValue } = await import("@/lib/labs/format-value");
    const { makeFormatters } = await import("@/lib/format-locale");
    const en = makeFormatters("en", "UTC", "AUTO", "AUTO").number;
    expect(
      formatLabValue(labs![0].value as number, en, labs![0].sourceValue),
    ).toBe("101");

    // FHIR: the text, when present, must agree with low and high. Here it is
    // left out, and the bounds carry the marker's unit like the value.
    const { labObservations } = await import("@/lib/fhir/resources/labs");
    let seq = 0;
    const observations = labObservations(
      { labResults: labs } as Parameters<typeof labObservations>[0],
      () => `obs-${++seq}`,
    );
    const range = observations[0].referenceRange?.[0];
    expect(range?.text).toBeUndefined();
    expect(range?.low?.unit).toBe("mg/dL");
    expect(range?.high?.value).toBeCloseTo(5.5 * 18.0182, 6);
    expect(observations[0].valueQuantity?.unit).toBe("mg/dL");
  });

  it("drops the printed text with the conversion record when the value is edited", async () => {
    const prisma = getPrismaClient();
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER_ID,
        name: "Glucose",
        unit: "mg/dL",
        lowerBound: 70,
        upperBound: 100,
      },
    });
    const PRINTED_MMOL = "3,9 - 5,5 mmol/l";
    const { POST } = await import("@/app/api/labs/route");
    const created = await POST(
      postReq({
        biomarkerId: marker.id,
        value: 5.6,
        unit: "mmol/L",
        sourceReferenceLow: 3.9,
        sourceReferenceHigh: 5.5,
        sourceReferenceText: PRINTED_MMOL,
        takenAt: "2026-07-03T08:00:00.000Z",
      }),
    );
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id as string;

    // The person types a new number in mg/dL, and the form echoes the old
    // printed text back with it.
    const { PUT } = await import("@/app/api/labs/[id]/route");
    const edited = await PUT(
      new NextRequest(`http://localhost/api/labs/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 104, sourceReferenceText: PRINTED_MMOL }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(edited.status).toBe(200);

    const row = await prisma.labResult.findUniqueOrThrow({ where: { id } });
    expect(row.sourceUnit).toBeNull();
    expect(row.sourceValue).toBeNull();
    expect(row.sourceReferenceText).toBeNull();
    // The bounds were converted with the value and stay, in mg/dL.
    expect(row.sourceReferenceLow).toBeCloseTo(3.9 * 18.0182, 6);
    expect(row.sourceReferenceHigh).toBeCloseTo(5.5 * 18.0182, 6);

    // No surface shows mmol/L text beside the mg/dL numbers.
    const dto = await readDto("Glucose");
    expect(dto.converted).toBe(false);
    expect(dto.sourceReferenceText).toBeNull();
    expect(dto.printedReferenceText).toBeNull();
    expect(dto.referenceOrigin).toBe("source");
    expect(dto.referenceHigh).toBeCloseTo(5.5 * 18.0182, 6);

    const { loadLabResults } =
      await import("@/lib/doctor-report/clinical-records");
    const labs = await loadLabResults(
      USER_ID,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-12-31T23:59:59.000Z"),
    );
    expect(labs?.[0].sourceReferenceText).toBeNull();
    // An edited value is no longer a conversion, and prints as typed.
    expect(labs?.[0].sourceValue).toBeNull();

    const { labObservations } = await import("@/lib/fhir/resources/labs");
    let seq = 0;
    const observations = labObservations(
      { labResults: labs } as Parameters<typeof labObservations>[0],
      () => `obs-${++seq}`,
    );
    expect(observations[0].referenceRange?.[0]?.text).toBeUndefined();
    expect(observations[0].referenceRange?.[0]?.high?.unit).toBe("mg/dL");
  });

  it("keeps a window it cannot read as text and leaves the catalog in force", async () => {
    const prisma = getPrismaClient();
    await seedMarker();

    const { POST } = await import("@/app/api/labs/route");
    const marker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: USER_ID },
    });
    const res = await POST(
      postReq({
        biomarkerId: marker.id,
        value: VALUE,
        sourceReferenceText: "siehe Befund",
        takenAt: "2026-07-02T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(201);

    const row = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER_ID },
    });
    // The string is on the record — absence would be the old failure, and a
    // fabricated bound would be worse than either.
    expect(row.sourceReferenceText).toBe("siehe Befund");
    expect(row.sourceReferenceLow).toBeNull();
    expect(row.sourceReferenceHigh).toBeNull();

    const dto = await readDto();
    expect(dto).toMatchObject({
      sourceReferenceText: "siehe Befund",
      referenceOrigin: "catalog",
      referenceDivergesFromCatalog: false,
      referenceLow: CATALOG.lowerBound,
      referenceHigh: CATALOG.upperBound,
    });
    // No derivable window means the catalog stays the net, so the catalog's
    // verdict stands.
    expect(dto.rangeStatus).toBe("above");
  });

  it("carries the window through a backup round trip", async () => {
    const prisma = getPrismaClient();
    const marker = await seedMarker();
    await prisma.labResult.create({
      data: {
        userId: USER_ID,
        biomarkerId: marker.id,
        analyte: "Kalium",
        unit: "mmol/L",
        value: VALUE,
        referenceLow: CATALOG.lowerBound,
        referenceHigh: CATALOG.upperBound,
        sourceReferenceLow: 3.9,
        sourceReferenceHigh: 5.4,
        sourceReferenceText: PRINTED,
        takenAt: new Date("2026-07-01T08:00:00.000Z"),
      },
    });

    const { buildRecordsBackupSection } =
      await import("@/lib/export/records-backup");
    const backup = await buildRecordsBackupSection(prisma, USER_ID, {
      purpose: "disaster-recovery",
    });
    expect(backup.labResults[0]).toMatchObject({
      sourceReferenceLow: 3.9,
      sourceReferenceHigh: 5.4,
      sourceReferenceText: PRINTED,
    });
  });

  /**
   * A window whose floor sits above its ceiling. The document path is the one
   * place these numbers arrive unvalidated: the three lab schemas enforce the
   * ordering, the extraction schema did not, and the catalog store takes what
   * it is handed. Before this guard the same run wrote 100/30 onto the row AND
   * onto the freshly minted marker, so every later reading of that analyte
   * inherited a range that cannot be true.
   *
   * The marker is deliberately absent so it gets minted from this fact — the
   * mint is the half that outlives the single row.
   */
  it("drops a transposed window instead of storing it", async () => {
    const prisma = getPrismaClient();
    const { commitApprovedFact } = await import("@/lib/documents/commit");
    const { encryptFactData, encryptFactProvenance } =
      await import("@/lib/documents/store");
    const doc = await prisma.inboundDocument.create({
      data: {
        userId: USER_ID,
        filename: "befund.pdf",
        mimeType: "application/pdf",
        byteSize: 1024,
        contentEncrypted: Buffer.from("stand-in for the stored bytes"),
        status: "EXTRACTED",
      },
    });
    const fact = await prisma.extractedFact.create({
      data: {
        documentId: doc.id,
        userId: USER_ID,
        factType: "OBSERVATION",
        status: "APPROVED",
        confidence: 0.9,
        needsReview: false,
        // No printed text, so the parser never sees the window and these
        // numbers are the whole of what the fact states. They are transposed.
        dataEncrypted: encryptFactData({
          label: "Ferritin",
          code: null,
          codeSystem: null,
          value: 150,
          valueText: null,
          unit: "ng/mL",
          referenceLow: 100,
          referenceHigh: 30,
          referenceText: null,
          effectiveDate: "2026-07-01",
        }),
        provenanceEncrypted: encryptFactProvenance({
          sourceText: "Ferritin 150 ng/mL 30 - 100",
          anchored: true,
          sourceOffset: 0,
          page: 0,
          confidence: 0.9,
        }),
      },
    });

    // The reading itself still lands — the value is the information, the
    // window is not, so an impossible window costs the range and nothing else.
    const ref = await commitApprovedFact(USER_ID, fact);
    const row = await prisma.labResult.findUniqueOrThrow({
      where: { id: ref.recordId },
    });
    expect(row.value).toBe(150);
    expect(row.sourceReferenceLow).toBeNull();
    expect(row.sourceReferenceHigh).toBeNull();
    expect(row.referenceLow).toBeNull();
    expect(row.referenceHigh).toBeNull();

    const minted = await prisma.biomarker.findFirstOrThrow({
      where: { userId: USER_ID, name: "Ferritin" },
    });
    expect(minted.lowerBound).toBeNull();
    expect(minted.upperBound).toBeNull();
  });
});
