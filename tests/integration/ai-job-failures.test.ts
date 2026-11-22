/**
 * #1404 — a background AI job that fails leaves its reason where the person
 * looks, against a real Postgres.
 *
 * What only this file can prove:
 *   1. Migration 0553 applied clean (the reporter's writes land).
 *   2. The automatic document summary, run through its queue handler with the
 *      provider unreachable, records `provider_unreachable` on the document:
 *      the detail read serves it in `aiFailures`, and `GET /api/ai/job-failures`
 *      lists it with the document id. The provider's error text (here
 *      carrying a key-shaped string) is in neither, nor in the row.
 *   3. A later success removes the reason.
 *   4. With no provider at all, the read the person switched on says so
 *      (`no_provider`); the same refusal for work nobody asked for and no chain
 *      bound is not recorded.
 *   5. A capability bound to a named chain whose provider is not set up is
 *      recorded as `chain_no_provider` for a background job nobody started.
 *   6. Another account's failures are not listed.
 */
import { Buffer } from "node:buffer";

import type { Job } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: vi.fn(async () => "job-1") }),
}));

import { AnthropicClient } from "@/lib/ai/anthropic-client";
import type { DocumentSummaryPayload } from "@/lib/jobs/document-summary";
import { handleDocumentSummary } from "@/lib/jobs/reminder/document-handlers";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

/** What a client error looks like when the host refuses the connection. */
const SECRET_SHAPED = "sk-ant-api03-leakedkeyleakedkeyleakedkey";
function unreachable(): Error {
  return Object.assign(
    new Error(`connect ECONNREFUSED while calling with ${SECRET_SHAPED}`),
    {
      upstream: "anthropic",
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    },
  );
}

let counter = 0;
async function makeUser(provider: boolean) {
  const suffix = `f-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `fail-${suffix}`,
      email: `fail-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      documentsAutoAiRead: true,
      modulePreferencesJson: { inboundDocuments: true },
      ...(provider
        ? {
            aiProvider: "ANTHROPIC",
            aiModel: "claude-sonnet-4-6",
            aiAnthropicKeyEncrypted: encrypt("sk-ant-integration-test"),
          }
        : {}),
    },
  });
}

async function grantConsent(userId: string) {
  await getPrismaClient().consentReceipt.create({
    data: { userId, kind: "ai_full", artefact: "test", signedAt: new Date() },
  });
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
      summaryState: "PENDING",
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function runSummary(userId: string, documentId: string) {
  await handleDocumentSummary([
    { id: "j", data: { userId, documentId } } as Job<DocumentSummaryPayload>,
  ]);
}

interface Envelope<T> {
  data: T;
  error: string | null;
}

async function detail(documentId: string) {
  const { GET } = await import("@/app/api/documents/inbound/[id]/route");
  const { NextRequest } = await import("next/server");
  const res = await GET(
    new NextRequest(`http://localhost/api/documents/inbound/${documentId}`),
    { params: Promise.resolve({ id: documentId }) } as never,
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: JSON.parse(text) as Envelope<{
      summaryState: string;
      aiFailures: Array<Record<string, unknown>>;
    }>,
  };
}

async function list() {
  const { GET } = await import("@/app/api/ai/job-failures/route");
  const res = await GET();
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: JSON.parse(text) as Envelope<{
      failures: Array<Record<string, unknown>>;
    }>,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a background AI job that fails", () => {
  it("leaves the reason on the document and in the settings list, and a success clears it", async () => {
    const user = await makeUser(true);
    await grantConsent(user.id);
    const document = await storeDocument(user.id);
    const call = vi
      .spyOn(AnthropicClient.prototype, "generateCompletion")
      .mockRejectedValue(unreachable());

    await runSummary(user.id, document.id);
    expect(call).toHaveBeenCalled();

    const row = await getPrismaClient().aiJobFailure.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row).toMatchObject({
      job: "documentSummary",
      subjectId: document.id,
      code: "provider_unreachable",
      providerType: "anthropic",
      failCount: 1,
    });
    expect(JSON.stringify(row)).not.toContain(SECRET_SHAPED);

    await signIn(user.id);
    const read = await detail(document.id);
    expect(read.status).toBe(200);
    expect(read.body.data.summaryState).toBe("UNAVAILABLE");
    expect(read.body.data.aiFailures).toEqual([
      expect.objectContaining({
        job: "documentSummary",
        code: "provider_unreachable",
        documentId: document.id,
        providerType: "anthropic",
        failCount: 1,
      }),
    ]);
    expect(read.text).not.toContain(SECRET_SHAPED);

    const listed = await list();
    expect(listed.status).toBe(200);
    expect(listed.body.data.failures).toEqual([
      expect.objectContaining({
        job: "documentSummary",
        code: "provider_unreachable",
        documentId: document.id,
      }),
    ]);
    expect(listed.text).not.toContain(SECRET_SHAPED);

    // A second failure counts up rather than adding a row.
    await runSummary(user.id, document.id);
    expect(
      await getPrismaClient().aiJobFailure.findMany({
        where: { userId: user.id },
        select: { failCount: true },
      }),
    ).toEqual([{ failCount: 2 }]);

    // The provider answers again: the reason goes.
    call.mockResolvedValue({
      content: "A one-page letter from a clinic.",
      tokensUsed: 40,
    } as never);
    await runSummary(user.id, document.id);
    expect(
      await getPrismaClient().aiJobFailure.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
    expect((await detail(document.id)).body.data.aiFailures).toEqual([]);
  });

  it("says no provider is set up for the read the person switched on", async () => {
    const user = await makeUser(false);
    const document = await storeDocument(user.id);

    await runSummary(user.id, document.id);

    await signIn(user.id);
    const read = await detail(document.id);
    expect(read.body.data.aiFailures).toEqual([
      expect.objectContaining({
        job: "documentSummary",
        code: "no_provider",
        providerType: null,
      }),
    ]);
  });

  it("records no missing provider for work nobody asked for, and a missing chain provider when one is bound", async () => {
    const { trackAiJob } = await import("@/lib/ai/job-failure/report");
    const { aiCapabilityForJob } = await import("@/lib/ai/capabilities/gate");
    const user = await makeUser(false);
    const job = () =>
      trackAiJob({ userId: user.id, job: "statusText" }, () =>
        aiCapabilityForJob(user.id, "statusText"),
      );

    expect((await job()).reason).toBe("no_provider");
    expect(
      await getPrismaClient().aiJobFailure.count({
        where: { userId: user.id },
      }),
    ).toBe(0);

    // Bound to a chain whose one provider has no key.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: {
        aiNamedChains: {
          chains: [{ id: "local-only", name: "Local", entries: ["local"] }],
          defaultChainId: null,
          attachments: { statusText: "local-only" },
        },
      },
    });
    expect((await job()).reason).toBe("no_provider");
    const row = await getPrismaClient().aiJobFailure.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row).toMatchObject({
      job: "statusText",
      subjectId: "",
      code: "chain_no_provider",
    });
  });

  it("lists only the caller's own failures", async () => {
    const owner = await makeUser(false);
    const other = await makeUser(false);
    await getPrismaClient().aiJobFailure.create({
      data: { userId: owner.id, job: "briefing", code: "provider_timeout" },
    });

    await signIn(other.id);
    expect((await list()).body.data.failures).toEqual([]);

    cookieJar.clear();
    await signIn(owner.id);
    expect((await list()).body.data.failures).toEqual([
      expect.objectContaining({ job: "briefing", code: "provider_timeout" }),
    ]);
  });
});
