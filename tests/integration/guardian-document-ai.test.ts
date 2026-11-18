/**
 * #1403 — a guardian finishes what an upload starts, under the PROFILE's AI.
 *
 * The vault's AI actions and the review that confirms their values are the
 * owner's and a managed profile's guardian's. What decides whether a model is
 * called is the profile's own capability: its modules, its consent receipts,
 * and the provider a managed record resolves to — the operator's, never the
 * guardian's personal key. Driven over the real routes and real Postgres,
 * with the model calls replaced by spies:
 *
 *   1. a guardian's suggest reaches the operator's provider, not their own;
 *   2. the guardian's own consent receipt does not open the profile: without
 *      the profile's receipt the read is refused and nothing is sent;
 *   3. the operator's switch closes it for the guardian as for anybody;
 *   4. the guardian confirms staged lab values: the lab rows land on the
 *      profile and the audit row names the guardian;
 *   5. an adult's MANAGE delegate is refused every one of these verbs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: vi.fn(async () => "job-1") }),
}));

// Every place a model would be called, replaced by a spy.
vi.mock("@/lib/documents/assist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/assist")>()),
  runDocumentAssist: vi.fn(async () => ({
    title: "Discharge letter",
    kind: null,
    documentDate: null,
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

// The credential loader: every stored provider key a request opens passes
// through it. Wrapped, not replaced, so the read still resolves; what is kept
// is a fingerprint of each key opened, never the key.
const openedKeys = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/ai/stored-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/stored-key")>();
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    openStoredKey: vi.fn((encrypted: string) => {
      const opened = actual.openStoredKey(encrypted);
      if (opened !== null) {
        openedKeys.push(createHash("sha256").update(opened).digest("hex"));
      }
      return opened;
    }),
  };
});

import { createHash } from "node:crypto";

import { runDocumentAssist } from "@/lib/documents/assist";
import {
  runDocumentSummary,
  transcribeDocument,
} from "@/lib/documents/describe";

const SPIES = [runDocumentAssist, runDocumentSummary, transcribeDocument];

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

let counter = 0;

/** A person on their own Anthropic key with the full AI receipt. */
/** A key's fingerprint, the only form a key is compared in here. */
function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const OPERATOR_KEY = "sk-operator-integration-test";
const GUARDIAN_KEY = "sk-ant-guardian-own-key";
const PROFILE_KEY = "sk-ant-profile-own-key";

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `gai-${suffix}`,
      email: `gai-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      aiAnthropicKeyEncrypted: encrypt(GUARDIAN_KEY),
      modulePreferencesJson: { inboundDocuments: true, labs: true },
    },
  });
  await grantConsent(user.id, "ai_full");
  return user;
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

/** The operator's own provider: what a managed profile's reads go to. */
async function operatorProvider() {
  await setSwitches({
    adminAiKeyEncrypted: encrypt(OPERATOR_KEY),
    adminAiModel: "gpt-4o",
  });
}

async function signIn(userId: string) {
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function guardianInside() {
  const guardian = await makeUser("guardian");
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Managed record",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  await getPrismaClient().user.update({
    where: { id: profile.id },
    data: { modulePreferencesJson: { inboundDocuments: true, labs: true } },
  });
  const session = await signIn(guardian.id);
  await switchSessionTo(session.id, profile.id);
  return { guardian, profile };
}

async function adultManagerInside() {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access: "MANAGE",
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
  const session = await signIn(delegate.id);
  await switchSessionTo(session.id, owner.id);
  return { owner, delegate };
}

async function storeDocument(userId: string) {
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { content, codec } = encryptDocumentContent(PNG);
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      kind: "LAB_RESULT",
      filename: "labs.png",
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      status: "EXTRACTED",
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
}

async function stageLabFact(userId: string, documentId: string) {
  const { encryptFactData, encryptFactProvenance } =
    await import("@/lib/documents/store");
  return getPrismaClient().extractedFact.create({
    data: {
      documentId,
      userId,
      factType: "OBSERVATION",
      status: "PENDING",
      confidence: 0.95,
      needsReview: false,
      dataEncrypted: encryptFactData({
        label: "Glucose",
        code: null,
        codeSystem: null,
        value: 95,
        valueText: null,
        unit: "mg/dL",
        referenceLow: null,
        referenceHigh: null,
        referenceText: null,
        effectiveDate: "2026-11-01",
      }),
      provenanceEncrypted: encryptFactProvenance({
        sourceText: "Glucose 95 mg/dL",
        anchored: true,
        sourceOffset: 0,
        page: 0,
        confidence: 0.95,
      }),
    },
  });
}

interface Envelope {
  data: unknown;
  error: string | null;
  meta?: Record<string, unknown>;
}

type Ctx = { params: Promise<Record<string, string>> };
type Handler = (r: Request, c?: Ctx) => Promise<Response>;
const ctx = (params: Record<string, string>): Ctx => ({
  params: Promise.resolve(params),
});

function post(url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

async function call(
  modulePath: string,
  verb: "GET" | "POST" | "PATCH",
  request: Request,
  params: Record<string, string> = {},
): Promise<{ status: number; body: Envelope }> {
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const res = await (mod[verb] as Handler)(request, ctx(params));
  const text = await res.text();
  let body: Envelope;
  try {
    body = JSON.parse(text) as Envelope;
  } catch {
    body = { data: text, error: null };
  }
  return { status: res.status, body };
}

const SUGGEST = "@/app/api/documents/inbound/[id]/suggest/route";

async function suggest(documentId: string) {
  // The vision path: the stored original is the input, no browser OCR.
  return call(
    SUGGEST,
    "POST",
    post(`/api/documents/inbound/${documentId}/suggest`),
    { id: documentId },
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
  for (const spy of SPIES) vi.mocked(spy).mockClear();
  openedKeys.length = 0;
});

describe("a guardian's document AI runs under the profile's capability", () => {
  it("opens the operator's key, never the guardian's or the profile's own", async () => {
    // Three keys within reach: the operator's, the guardian's personal key,
    // and a personal key on the profile's own row. A managed record's reads
    // go to the operator; resolving the guardian's credentials, or treating
    // the profile like an owner on its own key, would open one of the others.
    await operatorProvider();
    const { profile } = await guardianInside();
    await getPrismaClient().user.update({
      where: { id: profile.id },
      data: {
        aiProvider: "ANTHROPIC",
        aiModel: "claude-sonnet-4-6",
        aiAnthropicKeyEncrypted: encrypt(PROFILE_KEY),
      },
    });
    await grantConsent(profile.id, "ai_extraction");
    const document = await storeDocument(profile.id);

    const { status } = await suggest(document.id);

    expect(status).toBe(200);
    expect(runDocumentAssist).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDocumentAssist).mock.calls[0]![0].providerType).toBe(
      "admin-openai",
    );
    // The loader saw the operator's key, and only that one.
    expect(openedKeys.length).toBeGreaterThan(0);
    expect(new Set(openedKeys)).toEqual(new Set([fingerprint(OPERATOR_KEY)]));
    expect(openedKeys).not.toContain(fingerprint(GUARDIAN_KEY));
    expect(openedKeys).not.toContain(fingerprint(PROFILE_KEY));
  });

  it("is refused without the profile's own receipt, whatever the guardian consented to", async () => {
    await operatorProvider();
    const { profile } = await guardianInside();
    const document = await storeDocument(profile.id);

    const { status, body } = await suggest(document.id);

    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe("consent.ai.required");
    for (const spy of SPIES) expect(spy).not.toHaveBeenCalled();
  });

  it("is refused when the profile has no provider, even with the guardian's key at hand", async () => {
    // No operator key: a managed profile's reads have nowhere to go, and the
    // guardian's own Anthropic key is not a fallback.
    const { profile } = await guardianInside();
    await grantConsent(profile.id, "ai_extraction");
    const document = await storeDocument(profile.id);

    const { status } = await suggest(document.id);

    expect(status).toBe(422);
    for (const spy of SPIES) expect(spy).not.toHaveBeenCalled();
  });

  it("is refused when the operator switched reading documents off", async () => {
    await operatorProvider();
    await setSwitches({ assistantDocumentAiEnabled: false });
    const { profile } = await guardianInside();
    await grantConsent(profile.id, "ai_extraction");
    const document = await storeDocument(profile.id);

    const { status, body } = await suggest(document.id);

    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe("assistant.disabled.documentAi");
    for (const spy of SPIES) expect(spy).not.toHaveBeenCalled();
  });

  it("answers the AI transport probe for the profile", async () => {
    await operatorProvider();
    const { profile } = await guardianInside();
    await grantConsent(profile.id, "ai_extraction");

    const { status, body } = await call(
      "@/app/api/documents/inbound/capability/route",
      "GET",
      new Request("http://localhost/api/documents/inbound/capability"),
    );

    expect(status).toBe(200);
    expect((body.data as { available: boolean }).available).toBe(true);
  });
});

describe("a guardian confirms staged values into the profile", () => {
  it("lands the lab result on the profile, with the guardian as the actor", async () => {
    const { guardian, profile } = await guardianInside();
    const document = await storeDocument(profile.id);
    const fact = await stageLabFact(profile.id, document.id);
    const prisma = getPrismaClient();

    // A correction first, then the confirmation.
    const edited = await call(
      "@/app/api/documents/inbound/[id]/facts/[factId]/route",
      "PATCH",
      new Request(
        `http://localhost/api/documents/inbound/${document.id}/facts/${fact.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            factType: "OBSERVATION",
            label: "Glucose",
            value: 96,
            unit: "mg/dL",
            effectiveDate: "2026-11-01",
          }),
        },
      ),
      { id: document.id, factId: fact.id },
    );
    expect(edited.status).toBe(200);

    const confirmed = await call(
      "@/app/api/documents/inbound/[id]/confirm/route",
      "POST",
      post(`/api/documents/inbound/${document.id}/confirm`, {
        decisions: [{ factId: fact.id, action: "approve" }],
      }),
      { id: document.id },
    );
    expect(confirmed.status).toBe(200);
    const result = confirmed.body.data as {
      approved: { recordType: string; recordId: string }[];
      failed: unknown[];
    };
    expect(result.failed).toEqual([]);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.recordType).toBe("labResult");

    const lab = await prisma.labResult.findUniqueOrThrow({
      where: { id: result.approved[0]!.recordId },
      select: { userId: true },
    });
    expect(lab.userId).toBe(profile.id);
    expect(
      await prisma.labResult.count({ where: { userId: guardian.id } }),
    ).toBe(0);

    for (const action of [
      "documents.inbound.factEdit",
      "documents.inbound.confirm",
    ]) {
      const rows = await prisma.auditLog.findMany({
        where: { action },
        select: { userId: true, actorUserId: true },
      });
      expect(rows, action).toHaveLength(1);
      expect(rows[0]!.userId, action).toBe(profile.id);
      expect(rows[0]!.actorUserId, action).toBe(guardian.id);
    }
  });
});

describe("an adult's MANAGE delegate", () => {
  it("is refused every document AI verb and the review", async () => {
    await operatorProvider();
    const { owner } = await adultManagerInside();
    await grantConsent(owner.id, "ai_extraction");
    const document = await storeDocument(owner.id);
    const fact = await stageLabFact(owner.id, document.id);
    const id = document.id;

    const refused: [string, Promise<{ status: number }>][] = [
      ["suggest", suggest(id)],
      [
        "extract",
        call(
          "@/app/api/documents/inbound/[id]/extract/route",
          "POST",
          post(`/api/documents/inbound/${id}/extract`),
          { id },
        ),
      ],
      [
        "summary",
        call(
          "@/app/api/documents/inbound/[id]/summary/route",
          "POST",
          post(`/api/documents/inbound/${id}/summary`),
          { id },
        ),
      ],
      [
        "index",
        call(
          "@/app/api/documents/inbound/[id]/index/route",
          "POST",
          post(`/api/documents/inbound/${id}/index`),
          { id },
        ),
      ],
      [
        "chat",
        call(
          "@/app/api/documents/inbound/[id]/chat/route",
          "POST",
          post(`/api/documents/inbound/${id}/chat`, { message: "What is it?" }),
          { id },
        ),
      ],
      [
        "chat history",
        call(
          "@/app/api/documents/inbound/[id]/chat/route",
          "GET",
          new Request(`http://localhost/api/documents/inbound/${id}/chat`),
          { id },
        ),
      ],
      [
        "reindex",
        call(
          "@/app/api/documents/inbound/reindex/route",
          "POST",
          post("/api/documents/inbound/reindex"),
        ),
      ],
      [
        "capability",
        call(
          "@/app/api/documents/inbound/capability/route",
          "GET",
          new Request("http://localhost/api/documents/inbound/capability"),
        ),
      ],
      [
        "confirm",
        call(
          "@/app/api/documents/inbound/[id]/confirm/route",
          "POST",
          post(`/api/documents/inbound/${id}/confirm`, {
            decisions: [{ factId: fact.id, action: "approve" }],
          }),
          { id },
        ),
      ],
      [
        "ai run",
        call(
          "@/app/api/ai-runs/[id]/route",
          "GET",
          new Request("http://localhost/api/ai-runs/run-1"),
          { id: "run-1" },
        ),
      ],
    ];
    for (const [verb, pending] of refused) {
      expect((await pending).status, verb).toBe(403);
    }

    for (const spy of SPIES) expect(spy).not.toHaveBeenCalled();
    const prisma = getPrismaClient();
    expect(await prisma.labResult.count({ where: { userId: owner.id } })).toBe(
      0,
    );
    const staged = await prisma.extractedFact.findUniqueOrThrow({
      where: { id: fact.id },
      select: { status: true },
    });
    expect(staged.status).toBe("PENDING");
  });
});
