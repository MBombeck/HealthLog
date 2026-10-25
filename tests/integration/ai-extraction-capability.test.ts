/**
 * The extraction group's capabilities, through the real routes and the real
 * document pick against real Postgres, with a spy standing in for every model
 * call.
 *
 * The unit suites prove each gate is asked. What only this file can prove is
 * that the answer comes off the rows it should: the operator's switches on
 * `AppSettings`, the record's module preferences, the receipts on
 * `ConsentReceipt`, and the provider built from the person's own credential.
 * Every state is checked twice: the response a client sees, and the spy that
 * says whether anything reached a model. Each file-level state has an all-open
 * twin in which the spy IS called, so a spy that could not see a call would
 * turn those red.
 *
 * The two background paths at the end run the job handlers directly. They
 * prove the wire re-check in the document pick: a job enqueued before the
 * operator turned document reading off finds no provider when it runs, so
 * nothing is sent even though the job itself asks nothing of the capability.
 *
 * Mutation checks, run against this file: replacing the `atTheWire` re-check
 * in `provider-order.ts` with "nothing withheld" turns four cases red (both
 * receipt cases on the vault route and both background cases). Deleting the
 * `requireAiCapability("documentAi"` line from the suggest route leaves all
 * seventeen green, and that is the design rather than a blind spot: the pick
 * re-checks the same capability, so the switch still answers 403 with the
 * same envelope. The route gate's own presence and order are pinned by the
 * route's unit suite instead.
 */
import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// v1.40 — a lab scan is queued for the background worker; a queue that takes
// the send lets the route answer 202, and the test then runs the worker.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: vi.fn(async () => "job-1") }),
}));

// ── The spies: every place a model would be called ─────────────────────────

vi.mock("@/lib/documents/assist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/assist")>()),
  runDocumentAssist: vi.fn(async () => ({
    title: "Letter",
    kind: null,
    documentDate: null,
  })),
}));
vi.mock("@/lib/labs/ocr-extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/labs/ocr-extract")>()),
  runOcrExtraction: vi.fn(async () => ({
    data: { rows: [], reportDate: null, providerType: "openai" },
    spentTokens: 0,
    cachedTokens: 0,
  })),
}));
vi.mock("@/lib/documents/describe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/describe")>()),
  transcribeDocument: vi.fn(async () => ({ text: "Glucose 95 mg/dL" })),
  runDocumentSummary: vi.fn(async () => ({
    summary: "A laboratory report.",
    blocked: false,
  })),
}));
vi.mock("@/lib/ai/provider-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider-runner")>()),
  runRawCompletionWithFallback: vi.fn(async () => ({
    result: {
      content: JSON.stringify({ name: "Metformin" }),
      tokensUsed: 20,
      model: "m",
    },
    workingProvider: { providerType: "anthropic" },
    fallbackHops: [],
    tokensSpent: 0,
  })),
}));

import { runDocumentAssist } from "@/lib/documents/assist";
import { runOcrExtraction } from "@/lib/labs/ocr-extract";
import {
  runDocumentSummary,
  transcribeDocument,
} from "@/lib/documents/describe";
import { runRawCompletionWithFallback } from "@/lib/ai/provider-runner";

const SPIES = [
  runDocumentAssist,
  runOcrExtraction,
  transcribeDocument,
  runDocumentSummary,
  runRawCompletionWithFallback,
] as const;

/** A 1x1 PNG, so the vision path has a real image to prepare. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

let counter = 0;

/** A person on their own Anthropic key: every extraction leaves the machine. */
async function makeUser(overrides: Record<string, unknown> = {}) {
  const suffix = `x-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `extract-${suffix}`,
      email: `extract-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      aiAnthropicKeyEncrypted: encrypt("sk-ant-integration-test"),
      labsLocalOcrEnabled: true,
      ...overrides,
    },
  });
}

async function grantConsent(userId: string, kind: string) {
  await getPrismaClient().consentReceipt.create({
    data: { userId, kind, artefact: "test", signedAt: new Date() },
  });
}

async function setSwitches(values: Record<string, unknown>) {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...values },
    update: values,
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function storeDocument(userId: string) {
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { content, codec } = encryptDocumentContent(PNG);
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      kind: "OTHER",
      filename: "letter.png",
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      status: "STORED",
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
}

interface Envelope {
  data: unknown;
  error: string | null;
  meta?: Record<string, unknown>;
}

async function suggestText(documentId: string) {
  const { POST } =
    await import("@/app/api/documents/inbound/[id]/suggest/route");
  const { NextRequest } = await import("next/server");
  const res = await POST(
    new NextRequest(
      `http://localhost/api/documents/inbound/${documentId}/suggest`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "text", text: "Discharge letter" }),
      },
    ) as never,
    { params: Promise.resolve({ id: documentId }) } as never,
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function labsScanText() {
  const { POST } = await import("@/app/api/labs/ocr/extract/route");
  const res = await POST(
    new Request("http://localhost/api/labs/ocr/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", text: "Glucose 95 mg/dL" }),
    }) as never,
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function extractMedication() {
  const { POST } = await import("@/app/api/medications/extract/route");
  const { NextRequest } = await import("next/server");
  const res = await POST(
    new NextRequest("http://localhost/api/medications/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Metformin 500 mg twice daily" }),
    }) as never,
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

function expectNoModelCall() {
  for (const spy of SPIES) {
    expect(vi.mocked(spy)).not.toHaveBeenCalled();
  }
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
  for (const spy of SPIES) vi.mocked(spy).mockClear();
});

describe("reading a stored document — POST /api/documents/inbound/[id]/suggest", () => {
  it("reads the document when every layer is open (the spy can see a call)", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_extraction");
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const { status } = await suggestText(document.id);

    expect(status).toBe(200);
    expect(runDocumentAssist).toHaveBeenCalledTimes(1);
  });

  it("refuses with the reading-documents code and sends nothing when the operator turned it off", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_full");
    await setSwitches({ assistantDocumentAiEnabled: false });
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const { status, body } = await suggestText(document.id);

    expect(status).toBe(403);
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "assistant.disabled.documentAi",
      capability: "documentAi",
      reason: "operator_disabled",
    });
    expectNoModelCall();
  });

  it("refuses under the master switch too", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_full");
    await setSwitches({ assistantEnabled: false });
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const { status, body } = await suggestText(document.id);

    expect(status).toBe(403);
    expect(body.meta?.reason).toBe("operator_disabled");
    expectNoModelCall();
  });

  it("asks for an extraction receipt before the document leaves for the person's own key", async () => {
    const user = await makeUser();
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const { status, body } = await suggestText(document.id);

    expect(status).toBe(403);
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "consent.ai.required",
      capability: "documentAi",
      reason: "consent_required",
    });
    expectNoModelCall();
  });

  it("does not take the AI-analysis receipt as consent to read documents", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_insights_only");
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const { status, body } = await suggestText(document.id);

    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe("consent.ai.required");
    expectNoModelCall();
  });

  it("keeps the vault's own code when no provider is configured", async () => {
    const user = await makeUser({
      aiProvider: null,
      aiModel: null,
      aiAnthropicKeyEncrypted: null,
    });
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const { status, body } = await suggestText(document.id);

    expect(status).toBe(422);
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "documents.inbound.providerUnsupported",
      capability: "documentAi",
      reason: "no_provider",
    });
    expectNoModelCall();
  });
});

describe("scanning a lab report — POST /api/labs/ocr/extract", () => {
  it("scans when every layer is open (the spy can see a call)", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_extraction");
    await signIn(user.id);

    const { status, body } = await labsScanText();

    // The route only queues the read; the worker is where the model is called.
    expect(status).toBe(202);
    expect(runOcrExtraction).not.toHaveBeenCalled();
    const { runDocumentAiRun } = await import("@/lib/jobs/document-ai-run");
    const { runId } = body.data as { runId: string };
    expect(await runDocumentAiRun(runId, Date.now() + 45 * 60_000)).toBe(
      "succeeded",
    );
    expect(runOcrExtraction).toHaveBeenCalledTimes(1);
  });

  it("stops under the reading-documents switch", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_full");
    await setSwitches({ assistantDocumentAiEnabled: false });
    await signIn(user.id);

    const { status, body } = await labsScanText();

    expect(status).toBe(403);
    expect(body.meta).toMatchObject({
      errorCode: "assistant.disabled.documentAi",
      capability: "labsOcr",
    });
    expectNoModelCall();
  });

  it("names the labs module when it is off for the record", async () => {
    const user = await makeUser({
      modulePreferencesJson: { labs: false },
    });
    await grantConsent(user.id, "ai_full");
    await signIn(user.id);

    const { status, body } = await labsScanText();

    expect(status).toBe(403);
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "module.disabled",
      capability: "labsOcr",
      reason: "module_disabled",
      module: "labs",
    });
    expectNoModelCall();
  });

  it("puts a lab report under the document consent rule", async () => {
    const user = await makeUser();
    // The snapshot-rule receipt that used to cover a scan no longer does: a
    // lab report is a document.
    await grantConsent(user.id, "ai_insights_only");
    await signIn(user.id);

    const { status, body } = await labsScanText();

    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe("consent.ai.required");
    expectNoModelCall();
  });
});

describe("turning medication text into a schedule — POST /api/medications/extract", () => {
  it("extracts when every layer is open (the spy can see a call)", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_extraction");
    await signIn(user.id);

    const { status } = await extractMedication();

    expect(status).toBe(200);
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("stops under the reading-documents switch, whatever the Coach switch says", async () => {
    const user = await makeUser();
    await grantConsent(user.id, "ai_full");
    await setSwitches({
      assistantDocumentAiEnabled: false,
      assistantCoachEnabled: true,
    });
    await signIn(user.id);

    const { status, body } = await extractMedication();

    expect(status).toBe(403);
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "assistant.disabled.documentAi",
      capability: "medicationExtract",
      reason: "operator_disabled",
    });
    expectNoModelCall();
  });

  it("keeps 503 for no provider and names it", async () => {
    const user = await makeUser({
      aiProvider: null,
      aiModel: null,
      aiAnthropicKeyEncrypted: null,
    });
    await signIn(user.id);

    const { status, body } = await extractMedication();

    expect(status).toBe(503);
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "ai.provider.none",
      capability: "medicationExtract",
      reason: "no_provider",
    });
    expectNoModelCall();
  });
});

describe("document auto-read mints the extraction receipt", () => {
  it("writes ai_extraction, not ai_full", async () => {
    const user = await makeUser();
    await signIn(user.id);
    const { PATCH } =
      await import("@/app/api/auth/me/documents-auto-ai-read/route");

    const res = await PATCH(
      new Request("http://localhost/api/auth/me/documents-auto-ai-read", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentsAutoAiRead: true }),
      }),
    );

    expect(res.status).toBe(200);
    const receipts = await getPrismaClient().consentReceipt.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { kind: true },
    });
    expect(receipts.map((r) => r.kind)).toEqual(["ai_extraction"]);
  });
});

describe("background reads stop at the wire", () => {
  it("indexes through the text layer, not a model, once document reading is off", async () => {
    const user = await makeUser({ documentsAutoAiRead: true });
    await grantConsent(user.id, "ai_extraction");
    const document = await storeDocument(user.id);
    const { indexDocumentContent } =
      await import("@/lib/documents/index-document");

    // Open: the provider path is taken (the spy can see a call).
    await indexDocumentContent(user.id, document.id);
    expect(transcribeDocument).toHaveBeenCalledTimes(1);

    // The operator turns document reading off; the same job runs again.
    vi.mocked(transcribeDocument).mockClear();
    await getPrismaClient().documentContentIndex.deleteMany({
      where: { documentId: document.id },
    });
    await setSwitches({ assistantDocumentAiEnabled: false });
    await indexDocumentContent(user.id, document.id);

    expectNoModelCall();
  });

  it("leaves a summary job enqueued before the switch flipped with no provider to call", async () => {
    const user = await makeUser({ documentsAutoAiRead: true });
    await grantConsent(user.id, "ai_extraction");
    const document = await storeDocument(user.id);
    await setSwitches({ assistantDocumentAiEnabled: false });
    const { runDocumentSummaryJob } =
      await import("@/lib/jobs/document-summary");

    await runDocumentSummaryJob({
      userId: user.id,
      documentId: document.id,
      enqueuedAt: new Date().toISOString(),
    });

    expectNoModelCall();
    const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: { summaryEncrypted: true },
    });
    expect(row.summaryEncrypted).toBeNull();
  });

  it("summarises the same document with the switch on (the spy can see a call)", async () => {
    const user = await makeUser({ documentsAutoAiRead: true });
    await grantConsent(user.id, "ai_extraction");
    const document = await storeDocument(user.id);
    const { runDocumentSummaryJob } =
      await import("@/lib/jobs/document-summary");

    await runDocumentSummaryJob({
      userId: user.id,
      documentId: document.id,
      enqueuedAt: new Date().toISOString(),
    });

    expect(runDocumentSummary).toHaveBeenCalledTimes(1);
  });
});
