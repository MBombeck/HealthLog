/**
 * #1311 — a stored PDF on a server whose CPU cannot run the page renderer
 * (closed here with `NATIVE_CANVAS=off`), for a provider that only takes
 * images, through the real routes against a real Postgres.
 *
 * What only this file can prove: the route, the provider pick, the stored
 * (encrypted) original, the real reader child and the content-index write
 * meet as the unit tests assume. A text-layer PDF is summarised from its text
 * and indexed as a local text read; a scan answers the honest error and
 * records why on the document.
 */
import { Buffer } from "node:buffer";

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

import { encrypt } from "@/lib/crypto";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: () => null }));
vi.mock("@/lib/documents/describe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/describe")>()),
  runDocumentSummary: vi.fn(async () => ({
    summary: "A blood count from October.",
    blocked: null,
  })),
}));
vi.mock("@/lib/documents/auto-stage-labs", () => ({
  maybeAutoStageLabFacts: vi.fn(async () => ({
    staged: false,
    reason: "not-lab",
  })),
}));

import { runDocumentSummary } from "@/lib/documents/describe";
import { __resetNativeCanvasSupportForTests } from "@/lib/documents/native-canvas-support";

const LAB_LINE = "Haemoglobin 14.2 g/dl 13.5 - 17.5";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function textLayerPdf(): Buffer {
  const doc = new jsPDF();
  doc.text(LAB_LINE, 10, 15);
  doc.text("Leukocytes 6.1 /nl 4.0 - 10.0", 10, 23);
  return Buffer.from(doc.output("arraybuffer"));
}

function scannedPdf(): Buffer {
  const doc = new jsPDF();
  doc.addImage(`data:image/png;base64,${PNG}`, "PNG", 10, 10, 180, 250);
  return Buffer.from(doc.output("arraybuffer"));
}

let counter = 0;

async function signedInUser() {
  const suffix = `u-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `pdf-${suffix}`,
      email: `pdf-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "OPENAI",
      aiModel: "gpt-4o",
      aiOpenaiKeyEncrypted: encrypt("sk-test-openai-0001"),
      modulePreferencesJson: { inboundDocuments: true, labs: true },
    },
  });
  await getPrismaClient().consentReceipt.create({
    data: {
      userId: user.id,
      kind: "ai_extraction",
      artefact: "test",
      signedAt: new Date(),
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function storePdf(userId: string, bytes: Buffer) {
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { content, codec } = encryptDocumentContent(bytes);
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      kind: "OTHER",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      status: "STORED",
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
}

async function post(documentId: string, path: "summary" | "index") {
  const route =
    path === "summary"
      ? await import("@/app/api/documents/inbound/[id]/summary/route")
      : await import("@/app/api/documents/inbound/[id]/index/route");
  const { NextRequest } = await import("next/server");
  const res = await route.POST(
    new NextRequest(
      `http://localhost/api/documents/inbound/${documentId}/${path}`,
      { method: "POST" },
    ) as never,
    { params: Promise.resolve({ id: documentId }) } as never,
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      data: unknown;
      error: string | null;
      meta?: Record<string, unknown>;
    },
  };
}

beforeAll(() => {
  process.env.NATIVE_CANVAS = "off";
  __resetNativeCanvasSupportForTests();
});
afterAll(() => {
  delete process.env.NATIVE_CANVAS;
  __resetNativeCanvasSupportForTests();
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(runDocumentSummary).mockClear();
});

describe("a PDF on a server that cannot render PDF pages", () => {
  it("summarises a text-layer PDF from its text", async () => {
    const user = await signedInUser();
    const document = await storePdf(user.id, textLayerPdf());

    const res = await post(document.id, "summary");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(runDocumentSummary).toHaveBeenCalledOnce();
    const input = vi.mocked(runDocumentSummary).mock.calls[0][0];
    expect(input.ocrText).toContain(LAB_LINE);
    expect(input.images).toBeUndefined();
    expect(input.documents).toBeUndefined();
  }, 60_000);

  it("indexes a text-layer PDF from Read with AI as a local text read", async () => {
    const user = await signedInUser();
    const document = await storePdf(user.id, textLayerPdf());

    const res = await post(document.id, "index");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const index = await getPrismaClient().documentContentIndex.findUnique({
      where: { documentId: document.id },
      select: { source: true, providerType: true },
    });
    expect(index).toEqual({ source: "local-pdf", providerType: null });
  }, 60_000);

  it("answers a scan with pdfRendererUnavailable and records why", async () => {
    const user = await signedInUser();
    const document = await storePdf(user.id, scannedPdf());

    const summary = await post(document.id, "summary");
    expect(summary.status).toBe(422);
    expect(summary.body.meta?.errorCode).toBe(
      "documents.inbound.pdfRendererUnavailable",
    );
    expect(runDocumentSummary).not.toHaveBeenCalled();

    const index = await post(document.id, "index");
    expect(index.status).toBe(422);
    expect(index.body.meta?.errorCode).toBe(
      "documents.inbound.pdfRendererUnavailable",
    );
    const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: { lastIndexOutcome: true },
    });
    expect(row.lastIndexOutcome).toBe("pdf-needs-anthropic");
  }, 60_000);
});
