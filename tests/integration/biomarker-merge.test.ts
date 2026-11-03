/**
 * Merging markers, aliases and catalog shorthand against real SQL (D1223).
 *
 * "Alk.P" and "Alkaline Phosphatase" written by two labs used to be two
 * markers with half a history each. These tests drive the shipped route
 * exports and readers: a merge moves every reading and every reader then
 * shows one series, a dry run answers the same and writes nothing, readings
 * in another unit are converted with what the report printed kept, a pair
 * that cannot be converted refuses the whole merge, and a spelling chosen once
 * on a scan or a document resolves on its own the next time.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

const USER_ID = "user-biomarker-merge";
const OTHER_ID = "user-biomarker-merge-other";
const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  await prisma.user.createMany({
    data: [
      { id: USER_ID, username: "bm-merge", email: "bm-merge@example.test" },
      { id: OTHER_ID, username: "bm-other", email: "bm-other@example.test" },
    ],
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function seedMarker(
  name: string,
  unit: string,
  readings: number,
  options: { userId?: string; firstDay?: number; value?: number } = {},
) {
  const prisma = getPrismaClient();
  const userId = options.userId ?? USER_ID;
  const marker = await prisma.biomarker.create({
    data: { userId, name, unit },
  });
  await prisma.labResult.createMany({
    data: Array.from({ length: readings }, (_, i) => ({
      userId,
      biomarkerId: marker.id,
      analyte: name,
      value: (options.value ?? 80) + (i % 7),
      unit,
      takenAt: daysAgo((options.firstDay ?? 10) + i * 3),
    })),
  });
  return marker;
}

function json(body: unknown, url: string, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function merge(
  targetId: string,
  body: { sourceIds: string[]; dryRun?: boolean },
) {
  const { POST } = await import("@/app/api/biomarkers/[id]/merge/route");
  return POST(json(body, `http://localhost/api/biomarkers/${targetId}/merge`), {
    params: Promise.resolve({ id: targetId }),
  });
}

async function tableCounts() {
  const prisma = getPrismaClient();
  return {
    markers: await prisma.biomarker.count(),
    readings: await prisma.labResult.count(),
    linked: await prisma.labResult.groupBy({
      by: ["biomarkerId"],
      _count: true,
      orderBy: { biomarkerId: "asc" },
    }),
    aliases: await prisma.biomarkerAlias.count(),
    merges: await prisma.biomarkerMerge.count(),
    values: await prisma.labResult.findMany({
      select: { id: true, value: true, unit: true, sourceValue: true },
      orderBy: { id: "asc" },
    }),
  };
}

describe("POST /api/biomarkers/{id}/merge", () => {
  it("merges 30 and 12 readings into one series every reader shows as 42", async () => {
    const target = await seedMarker("Alkaline Phosphatase", "U/L", 30);
    const source = await seedMarker("Alk.P", "U/L", 12, { firstDay: 400 });

    const res = await merge(target.id, { sourceIds: [source.id] });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      dryRun: false,
      movedReadings: 12,
      convertedReadings: 0,
      aliasesAdded: ["Alk.P"],
      sources: [
        {
          id: source.id,
          name: "Alk.P",
          unit: "U/L",
          readingCount: 12,
          conversion: "none",
          refusal: null,
        },
      ],
    });
    expect(data.mergeId).toEqual(expect.any(String));
    expect(data.target.aliases).toEqual(["Alk.P"]);

    // The overview: one marker, 42 readings.
    const { GET: overview } = await import("@/app/api/labs/overview/route");
    const ov = await (
      await overview(new NextRequest("http://localhost/api/labs/overview"))
    ).json();
    expect(ov.data.markers).toHaveLength(1);
    expect(ov.data.markers[0]).toMatchObject({
      key: `bm:${target.id}`,
      count: 42,
    });

    // The marker detail's own list.
    const { GET: list } = await import("@/app/api/labs/route");
    const detail = await (
      await list(
        new NextRequest(
          `http://localhost/api/labs?biomarkerId=${target.id}&limit=100`,
        ),
      )
    ).json();
    expect(detail.data.meta.total).toBe(42);

    // The doctor report: one line, counted 42, under the marker's name.
    const { loadLabResults } =
      await import("@/lib/doctor-report/clinical-records");
    const report = await loadLabResults(USER_ID, daysAgo(1000), new Date());
    expect(report).toHaveLength(1);
    expect(report![0]).toMatchObject({
      analyte: "Alkaline Phosphatase",
      count: 42,
    });

    // FHIR: one Observation for the marker, named after it.
    const { labObservations } = await import("@/lib/fhir/resources/labs");
    let n = 0;
    const observations = labObservations(
      { labResults: report } as Parameters<typeof labObservations>[0],
      () => `obs-${++n}`,
    );
    expect(observations).toHaveLength(1);
    expect(observations[0].code.text).toBe("Alkaline Phosphatase");

    // MCP history: the printed name, the marker's name and the alias all read
    // the whole series.
    const { getLabHistory } = await import("@/lib/mcp/rich-reads");
    for (const analyte of ["Alk.P", "alkaline phosphatase", "ALP"]) {
      const total: number[] = [];
      let offset = 0;
      for (;;) {
        const page = await getLabHistory(USER_ID, { analyte, offset });
        expect(page.present, analyte).toBe(true);
        if (!page.present) break;
        total.push(page.readings!.length);
        if (!page.nextCursor) break;
        offset += page.readings!.length;
      }
      expect(
        total.reduce((a, b) => a + b, 0),
        analyte,
      ).toBe(42);
    }

    // The source is gone, its old id leads to the target, and the reading's
    // printed name survived.
    const prisma = getPrismaClient();
    expect(
      await prisma.biomarker.findUnique({ where: { id: source.id } }),
    ).toBeNull();
    const { GET: getMarker } = await import("@/app/api/biomarkers/[id]/route");
    const stale = await getMarker(
      new NextRequest(`http://localhost/api/biomarkers/${source.id}`),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(stale.status).toBe(404);
    const staleBody = await stale.json();
    expect(staleBody.meta).toMatchObject({
      errorCode: "labs.biomarker.notFound",
      mergedInto: target.id,
    });
    expect(
      await prisma.labResult.count({
        where: { biomarkerId: target.id, analyte: "Alk.P" },
      }),
    ).toBe(12);
    const ledger = await prisma.biomarkerMerge.findMany({});
    expect(ledger).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        targetBiomarkerId: target.id,
        sourceBiomarkerId: source.id,
        sourceName: "Alk.P",
        readingCount: 12,
      }),
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "labs.biomarker.merge" },
    });
    expect(audit.details).not.toContain("Alk.P");
    expect(audit.details).toContain(source.id);
  });

  it("answers a dry run exactly like the merge and writes nothing", async () => {
    const target = await seedMarker("Glucose", "mg/dL", 5, { value: 90 });
    const sameUnit = await seedMarker("Blutzucker", "mg/dL", 3);
    const molar = await seedMarker("Glukose", "mmol/L", 4, { value: 5 });
    const prisma = getPrismaClient();
    await prisma.biomarkerAlias.create({
      data: {
        userId: USER_ID,
        biomarkerId: molar.id,
        name: "GLU",
        nameFolded: "glu",
        source: "MANUAL",
      },
    });

    const before = await tableCounts();
    const preview = await merge(target.id, {
      sourceIds: [sameUnit.id, molar.id],
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    const dry = (await preview.json()).data;
    expect(await tableCounts()).toEqual(before);
    expect(dry.dryRun).toBe(true);
    expect(dry.mergeId).toBeNull();
    expect(dry.target.aliases).toEqual([]);

    const applied = (
      await (
        await merge(target.id, { sourceIds: [sameUnit.id, molar.id] })
      ).json()
    ).data;
    const comparable = (r: Record<string, unknown>) => {
      const rest = { ...r };
      delete rest.dryRun;
      delete rest.mergeId;
      delete rest.target;
      return rest;
    };
    expect(comparable(applied)).toEqual(comparable(dry));
    expect(applied).toMatchObject({
      movedReadings: 7,
      convertedReadings: 4,
      aliasesAdded: ["Blutzucker", "Glukose", "GLU"],
    });
    expect(applied.sources[1]).toMatchObject({
      id: molar.id,
      conversion: "converted",
    });
    expect([...applied.target.aliases].sort()).toEqual(
      ["Blutzucker", "GLU", "Glukose"].sort(),
    );
  });

  it("converts readings in another unit and keeps what the report printed", async () => {
    const target = await seedMarker("Glucose", "mg/dL", 1, { value: 90 });
    const molar = await seedMarker("Glukose", "mmol/L", 0);
    const prisma = getPrismaClient();
    const fresh = await prisma.labResult.create({
      data: {
        userId: USER_ID,
        biomarkerId: molar.id,
        analyte: "Glukose",
        value: 5.5,
        unit: "mmol/L",
        sourceReferenceLow: 3.9,
        sourceReferenceHigh: 5.6,
        takenAt: daysAgo(40),
      },
    });
    // A reading converted on its way in already: its original pair stays.
    const twice = await prisma.labResult.create({
      data: {
        userId: USER_ID,
        biomarkerId: molar.id,
        analyte: "Glukose",
        value: 6,
        unit: "mmol/L",
        sourceValue: 6000,
        sourceUnit: "µmol/L",
        takenAt: daysAgo(50),
      },
    });

    const res = await merge(target.id, { sourceIds: [molar.id] });
    expect(res.status).toBe(200);

    const moved = await prisma.labResult.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(moved.biomarkerId).toBe(target.id);
    expect(moved.unit).toBe("mg/dL");
    expect(moved.value).toBeCloseTo(99.09, 1);
    expect(moved.sourceValue).toBe(5.5);
    expect(moved.sourceUnit).toBe("mmol/L");
    expect(moved.sourceReferenceLow).toBeCloseTo(70.26, 1);
    expect(moved.sourceReferenceHigh).toBeCloseTo(100.89, 1);
    expect(moved.analyte).toBe("Glukose");

    const kept = await prisma.labResult.findUniqueOrThrow({
      where: { id: twice.id },
    });
    expect(kept.value).toBeCloseTo(108.09, 1);
    expect(kept.sourceValue).toBe(6000);
    expect(kept.sourceUnit).toBe("µmol/L");
  });

  it("refuses the whole merge when one source cannot be converted", async () => {
    const target = await seedMarker("ALT", "U/L", 3);
    const convertible = await seedMarker("GPT", "U/L", 2);
    const enzymeSi = await seedMarker("ALAT", "µkat/L", 2, { value: 1 });

    const before = await tableCounts();
    const res = await merge(target.id, {
      sourceIds: [convertible.id, enzymeSi.id],
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta).toMatchObject({
      errorCode: "labs.biomarker.merge.unitMismatch",
      sources: [
        {
          id: enzymeSi.id,
          unit: "µkat/L",
          targetUnit: "U/L",
          reason: expect.any(String),
        },
      ],
    });
    // Nothing moved, not even the source that would have converted.
    expect(await tableCounts()).toEqual(before);

    // The preview names the refusal instead of failing.
    const preview = await merge(target.id, {
      sourceIds: [convertible.id, enzymeSi.id],
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    const dry = (await preview.json()).data;
    expect(dry.sources[0].conversion).toBe("none");
    expect(dry.sources[1]).toMatchObject({
      conversion: "refused",
      refusal: expect.stringMatching(/unknown_(analyte|unit)/),
    });
  });

  it("names every missing id, refuses a target among the sources, and never reaches another account", async () => {
    const target = await seedMarker("TSH", "mIU/L", 1);
    const foreign = await seedMarker("TSH basal", "mIU/L", 1, {
      userId: OTHER_ID,
    });

    const missing = await merge(target.id, {
      sourceIds: [foreign.id, "nope"],
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).meta).toMatchObject({
      errorCode: "labs.biomarker.notFound",
      ids: [foreign.id, "nope"],
    });

    const self = await merge(target.id, { sourceIds: [target.id] });
    expect(self.status).toBe(422);
    expect((await self.json()).meta.errorCode).toBe(
      "labs.biomarker.merge.invalid",
    );

    expect(
      await getPrismaClient().biomarker.count({ where: { userId: OTHER_ID } }),
    ).toBe(1);
  });

  it("follows a marker merged twice to where it ended up", async () => {
    const a = await seedMarker("Ferritin (Serum)", "ng/mL", 1);
    const b = await seedMarker("Ferr", "ng/mL", 1);
    const c = await seedMarker("Ferritin", "ng/mL", 1);
    expect((await merge(b.id, { sourceIds: [a.id] })).status).toBe(200);
    expect((await merge(c.id, { sourceIds: [b.id] })).status).toBe(200);

    const { GET } = await import("@/app/api/biomarkers/[id]/route");
    for (const id of [a.id, b.id]) {
      const res = await GET(
        new NextRequest(`http://localhost/api/biomarkers/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect((await res.json()).meta.mergedInto).toBe(c.id);
    }
    const aliases = await getPrismaClient().biomarkerAlias.findMany({
      where: { biomarkerId: c.id },
      orderBy: { name: "asc" },
    });
    expect(aliases.map((alias) => alias.name)).toEqual([
      "Ferr",
      "Ferritin (Serum)",
    ]);
    expect(
      await getPrismaClient().labResult.count({
        where: { biomarkerId: c.id },
      }),
    ).toBe(3);
  });
});

describe("aliases on the marker", () => {
  async function put(id: string, body: unknown) {
    const { PUT } = await import("@/app/api/biomarkers/[id]/route");
    return PUT(json(body, `http://localhost/api/biomarkers/${id}`, "PUT"), {
      params: Promise.resolve({ id }),
    });
  }

  it("replaces the set, keeps where a kept spelling came from, and leaves it alone when omitted", async () => {
    const alp = await seedMarker("Alkaline Phosphatase", "U/L", 0);
    const prisma = getPrismaClient();
    await prisma.biomarkerAlias.create({
      data: {
        userId: USER_ID,
        biomarkerId: alp.id,
        name: "Alk.P",
        nameFolded: "alk.p",
        source: "IMPORT_CHOICE",
      },
    });

    const res = await put(alp.id, {
      aliases: ["Alk.P", "AP", "alkaline phosphatase"],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.aliases).toEqual(["Alk.P", "AP"]);
    const rows = await prisma.biomarkerAlias.findMany({
      where: { biomarkerId: alp.id },
      orderBy: { nameFolded: "asc" },
    });
    expect(rows.map((r) => [r.name, r.source])).toEqual([
      ["Alk.P", "IMPORT_CHOICE"],
      ["AP", "MANUAL"],
    ]);

    // An older client's PUT without the field keeps them.
    const untouched = await put(alp.id, { lowerBound: 40 });
    expect((await untouched.json()).data.aliases).toEqual(["Alk.P", "AP"]);

    const cleared = await put(alp.id, { aliases: [] });
    expect((await cleared.json()).data.aliases).toEqual([]);
  });

  it("refuses a spelling another marker already answers to", async () => {
    const alt = await seedMarker("ALT", "U/L", 0);
    const ast = await seedMarker("AST", "U/L", 0);
    await getPrismaClient().biomarkerAlias.create({
      data: {
        userId: USER_ID,
        biomarkerId: ast.id,
        name: "GOT",
        nameFolded: "got",
        source: "MANUAL",
      },
    });

    for (const [alias, owner] of [
      ["ast", ast.id],
      ["got", ast.id],
    ] as const) {
      const res = await put(alt.id, { aliases: ["GPT", alias] });
      expect(res.status).toBe(409);
      expect((await res.json()).meta).toMatchObject({
        errorCode: "labs.biomarker.alias.taken",
        alias,
        biomarkerId: owner,
      });
    }
    expect(
      await getPrismaClient().biomarkerAlias.count({
        where: { biomarkerId: alt.id },
      }),
    ).toBe(0);
  });
});

describe("a spelling resolves on its own once chosen", () => {
  it("maps T.Bili to the chosen marker on the second scan and on manual entry", async () => {
    const bili = await seedMarker("Bilirubin (Total)", "mg/dL", 2, {
      value: 1,
    });
    const { annotateRow } = await import("@/lib/labs/ocr-extract");
    const scanned = {
      analyte: "Bilirubin ges.",
      value: 0.8,
      valueText: null,
      unit: "mg/dL",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      takenAt: "2026-06-01",
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
    };

    // First scan: a name nothing resolves; the review offers the marker.
    const first = await annotateRow(USER_ID, scanned, null, "UTC");
    expect(first.biomarkerId).toBeNull();
    expect(first.biomarkerMatch).toBe("new");
    expect(first.suggestions[0]).toMatchObject({
      biomarkerId: bili.id,
      matchKind: "similar",
    });

    // The catalog's shorthand resolves without a choice.
    const shorthand = await annotateRow(
      USER_ID,
      { ...scanned, analyte: "T.Bili" },
      null,
      "UTC",
    );
    expect(shorthand).toMatchObject({
      biomarkerId: bili.id,
      matchKind: "catalog",
      biomarkerMatch: "existing",
      suggestions: [],
    });

    // The person picks the marker for "Bilirubin ges." and commits.
    const { POST: commit } = await import("@/app/api/labs/ocr/commit/route");
    const committed = await commit(
      json(
        {
          rows: [
            {
              analyte: "Bilirubin ges.",
              value: 0.8,
              unit: "mg/dL",
              takenAt: "2026-06-01T08:00:00.000Z",
              biomarkerId: bili.id,
            },
          ],
        },
        "http://localhost/api/labs/ocr/commit",
      ),
    );
    expect(committed.status).toBe(200);
    const prisma = getPrismaClient();
    expect(
      await prisma.labResult.count({ where: { biomarkerId: bili.id } }),
    ).toBe(3);
    expect(
      await prisma.biomarkerAlias.findFirst({
        where: { biomarkerId: bili.id },
        select: { name: true, source: true },
      }),
    ).toEqual({ name: "Bilirubin ges.", source: "IMPORT_CHOICE" });

    // The second scan of the same lab matches without asking.
    const second = await annotateRow(
      USER_ID,
      { ...scanned, takenAt: "2026-07-01" },
      null,
      "UTC",
    );
    expect(second).toMatchObject({
      biomarkerId: bili.id,
      matchKind: "alias",
      suggestions: [],
    });

    // Manual entry with the alias lands on the marker, no new marker.
    const { POST: create } = await import("@/app/api/labs/route");
    const typed = await create(
      json(
        {
          analyte: "bilirubin ges.",
          value: 0.9,
          unit: "mg/dL",
          takenAt: new Date().toISOString(),
        },
        "http://localhost/api/labs",
      ),
    );
    expect(typed.status).toBe(201);
    expect((await typed.json()).data.biomarkerId).toBe(bili.id);
    expect(await prisma.biomarker.count({ where: { userId: USER_ID } })).toBe(
      1,
    );
  });

  it("skips a row naming a marker the record does not have", async () => {
    const foreign = await seedMarker("Ferritin", "ng/mL", 0, {
      userId: OTHER_ID,
    });
    const { POST: commit } = await import("@/app/api/labs/ocr/commit/route");
    const res = await commit(
      json(
        {
          rows: [
            {
              analyte: "Ferritin",
              value: 50,
              unit: "ng/mL",
              takenAt: "2026-06-01T08:00:00.000Z",
              biomarkerId: foreign.id,
            },
          ],
        },
        "http://localhost/api/labs/ocr/commit",
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.skipped).toEqual([
      { analyte: "Ferritin", reason: "unknown_biomarker" },
    ]);
    expect(await getPrismaClient().labResult.count()).toBe(0);
  });

  it("files a confirmed document value under the chosen marker and remembers the label", async () => {
    const alp = await seedMarker("Alkaline Phosphatase", "U/L", 0);
    const prisma = getPrismaClient();
    const { encryptFactData, encryptFactProvenance, serialiseFact } =
      await import("@/lib/documents/store");
    const document = await prisma.inboundDocument.create({
      data: {
        userId: USER_ID,
        kind: "LAB_RESULT",
        filename: "report.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
        contentEncrypted: new Uint8Array([1, 2, 3]),
      },
    });
    const fact = await prisma.extractedFact.create({
      data: {
        userId: USER_ID,
        documentId: document.id,
        factType: "OBSERVATION",
        status: "PENDING",
        confidence: 0.95,
        needsReview: false,
        dataEncrypted: encryptFactData({
          label: "Alk. Phosph.",
          code: null,
          codeSystem: null,
          value: 70,
          valueText: null,
          unit: "U/L",
          referenceLow: null,
          referenceHigh: null,
          referenceText: null,
          effectiveDate: "2026-05-02",
        }),
        provenanceEncrypted: encryptFactProvenance({
          sourceText: "Alk. Phosph. 70 U/L",
          anchored: true,
          sourceOffset: 0,
          page: 1,
          confidence: 0.95,
        }),
      },
    });

    const { loadMarkerIndex } = await import("@/lib/labs/biomarker-resolve");
    const dto = serialiseFact(fact, await loadMarkerIndex(prisma, USER_ID));
    expect(dto.biomarkerId).toBeNull();
    expect(dto.suggestions?.[0]?.biomarkerId).toBe(alp.id);

    const { commitApprovedFact } = await import("@/lib/documents/commit");
    const ref = await commitApprovedFact(USER_ID, fact, {
      biomarkerId: alp.id,
    });
    const reading = await prisma.labResult.findUniqueOrThrow({
      where: { id: ref.recordId },
    });
    expect(reading.biomarkerId).toBe(alp.id);
    expect((await prisma.biomarkerAlias.findFirstOrThrow({})).name).toBe(
      "Alk. Phosph.",
    );

    const again = serialiseFact(fact, await loadMarkerIndex(prisma, USER_ID));
    expect(again).toMatchObject({ biomarkerId: alp.id, matchKind: "alias" });
  });
});
