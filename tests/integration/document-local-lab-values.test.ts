/**
 * A scanned lab report read on the server with no AI at all, against a real
 * Postgres: uploaded through the upload route, indexed by the index job
 * (OCR in the reader's child process, real tesseract), its values staged by
 * rule for the review, and confirmed through the confirm route into lab
 * results. Then the person's own request for a model-free read
 * (`POST /api/documents/inbound/{id}/lab-values`) on a text-layer report, and
 * its refusal once a value from it is confirmed.
 *
 * No AI provider is configured for the account and the operator's AI switch
 * is off: the path must not need either. Every value is synthetic.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { jsPDF } from "jspdf";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
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

const require = createRequire(import.meta.url);
let langDir: string;

beforeAll(async () => {
  // The build stages the language data into `public/tesseract/lang`; the
  // suite stages its own copy.
  langDir = mkdtempSync(join(tmpdir(), "hl-int-ocr-lang-"));
  for (const lang of ["deu", "eng"]) {
    const manifest = require.resolve(`@tesseract.js-data/${lang}/package.json`);
    copyFileSync(
      join(dirname(manifest), "4.0.0_best_int", `${lang}.traineddata.gz`),
      join(langDir, `${lang}.traineddata.gz`),
    );
  }
  const { __resetServerOcrStatusForTests } =
    await import("@/lib/documents/server-ocr");
  __resetServerOcrStatusForTests(langDir);
});

afterAll(async () => {
  const { __resetServerOcrStatusForTests } =
    await import("@/lib/documents/server-ocr");
  __resetServerOcrStatusForTests();
  rmSync(langDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUser() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "local-lab-values",
      email: "local-lab-values@example.test",
      role: "USER",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { inboundDocuments: true, labs: true },
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

type RouteCtx = { params: Promise<{ id: string }> };
const ctx = (id: string): RouteCtx => ({ params: Promise.resolve({ id }) });

async function upload(bytes: Buffer, filename: string): Promise<string> {
  const { POST } = await import("@/app/api/documents/inbound/route");
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const form = new FormData();
  form.append("file", new Blob([payload]), filename);
  form.append("kind", "LAB_RESULT");
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/documents/inbound", {
      method: "POST",
      body: form,
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

async function detail(id: string) {
  const { GET } = await import("@/app/api/documents/inbound/[id]/route");
  const res = await (
    GET as unknown as (r: Request, c: RouteCtx) => Promise<Response>
  )(new Request(`http://localhost/api/documents/inbound/${id}`), ctx(id));
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

async function readLabValuesRoute(id: string): Promise<Response> {
  const { POST } =
    await import("@/app/api/documents/inbound/[id]/lab-values/route");
  return (POST as unknown as (r: Request, c: RouteCtx) => Promise<Response>)(
    new Request(`http://localhost/api/documents/inbound/${id}/lab-values`, {
      method: "POST",
    }),
    ctx(id),
  );
}

async function confirm(id: string, factIds: string[]) {
  const { POST } =
    await import("@/app/api/documents/inbound/[id]/confirm/route");
  const res = await (
    POST as unknown as (r: Request, c: RouteCtx) => Promise<Response>
  )(
    new Request(`http://localhost/api/documents/inbound/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisions: factIds.map((factId) => ({ factId, action: "approve" })),
      }),
    }),
    ctx(id),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

interface FactDto {
  id: string;
  factType: string;
  status: string;
  needsReview: boolean;
  data: { label: string; value: number | null; unit: string | null };
}

describe("a scanned lab report with no AI", () => {
  it("is read by OCR, staged by rule, and confirmed into lab results", async () => {
    const user = await seedUser();
    const { syntheticLabScanPdf } =
      await import("@/lib/documents/__tests__/synthetic-scan");
    const id = await upload(syntheticLabScanPdf(), "befund-scan.pdf");

    const { runDocumentIndex } = await import("@/lib/jobs/document-index");
    await runDocumentIndex({ userId: user.id, documentId: id });

    const prisma = getPrismaClient();
    const index = await prisma.documentContentIndex.findFirstOrThrow({
      where: { documentId: id },
      select: { source: true, providerType: true },
    });
    expect(index).toEqual({ source: "local-ocr", providerType: null });

    const doc = await detail(id);
    expect(doc.status).toBe("EXTRACTED");
    expect(doc.providerType).toBe("local-parser");
    expect(doc.reportDate).toBe("2026-11-03");
    const facts = doc.facts as FactDto[];
    const byLabel = new Map(
      facts.map((f) => [f.data.label.normalize("NFC"), f]),
    );
    expect(byLabel.get("Natrium")?.data).toMatchObject({
      value: 141,
      unit: "mmol/l",
    });
    expect(byLabel.get("Kalium")?.data).toMatchObject({
      value: 4.2,
      unit: "mmol/l",
    });
    expect(facts.every((f) => f.status === "PENDING")).toBe(true);

    const decidable = facts.filter((f) => !f.needsReview).map((f) => f.id);
    expect(decidable.length).toBeGreaterThanOrEqual(3);
    const result = await confirm(id, decidable);
    expect(result.failed).toEqual([]);
    const sodium = await prisma.labResult.findFirstOrThrow({
      where: { userId: user.id, value: 141 },
      select: { source: true, takenAt: true },
    });
    expect(sodium.source).toBe("DOCUMENT");
    expect(sodium.takenAt.toISOString()).toBe("2026-11-03T12:00:00.000Z");
  }, 180_000);
});

describe("POST /api/documents/inbound/{id}/lab-values", () => {
  function textLayerReport(): Buffer {
    const doc = new jsPDF();
    [
      "Laboratory report",
      "Collected: 2026-10-14",
      "Glucose 92 mg/dL 65-99",
      "Ferritin 80 ng/mL 30-400",
      "Cholesterol, Total 212 H mg/dL 100-199",
    ].forEach((line, i) => doc.text(line, 10, 15 + i * 10));
    return Buffer.from(doc.output("arraybuffer"));
  }

  it("stages the values of a text-layer report on request, then refuses once one is confirmed", async () => {
    const user = await seedUser();
    const id = await upload(textLayerReport(), "report.pdf");
    // Indexed from the text layer, and not staged on upload: the person
    // asks for the read.
    const { indexDocumentContent } =
      await import("@/lib/documents/index-document");
    const outcome = await indexDocumentContent(user.id, id);
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });

    const res = await readLabValuesRoute(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.providerType).toBe("local-parser");
    const facts = body.data.facts as FactDto[];
    expect(facts.map((f) => f.data.label)).toEqual([
      "Glucose",
      "Ferritin",
      "Cholesterol, Total",
    ]);

    // Asked again: the earlier staged rows are replaced, not doubled.
    const again = await (await readLabValuesRoute(id)).json();
    expect(again.data.facts).toHaveLength(3);

    await confirm(id, [again.data.facts[0].id]);
    const refused = await readLabValuesRoute(id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).meta.errorCode).toBe(
      "documents.inbound.alreadyPartlyConfirmed",
    );
  }, 120_000);

  it("answers 422 for a document with no stored text", async () => {
    await seedUser();
    const { syntheticLabScanJpeg } =
      await import("@/lib/documents/__tests__/synthetic-scan");
    const id = await upload(syntheticLabScanJpeg(), "photo.jpg");
    const res = await readLabValuesRoute(id);
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toBe(
      "documents.inbound.notIndexed",
    );
  });
});
