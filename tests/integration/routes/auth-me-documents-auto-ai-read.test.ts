/**
 * `/api/auth/me/documents-auto-ai-read` — the opt-in to read documents with
 * AI on upload, against the real database, the real capability resolver and
 * a real pg-boss queue.
 *
 * Turning the switch on is the standing consent act, so the write mints an
 * `ai_extraction` receipt (document reading only, never the master `ai_full`
 * that would also open the Coach and the AI analysis). And because the
 * summary job is enqueued at upload time and does nothing while the switch is
 * off, a genuine off-to-on flip schedules one catch-up pass over the vault;
 * without it a person who filled the vault first saw the switch do nothing.
 * Pinned here:
 *   - the flip stores the flag, mints exactly one extraction receipt and
 *     queues exactly one catch-up, and the capability is read after the mint,
 *     so the receipt the same request wrote opens it;
 *   - re-saving on, or turning it off, queues nothing, and off mints nothing;
 *   - an active receipt that already covers document reads is not doubled;
 *   - a receipt minted concurrently by another request is a success, not a
 *     500;
 *   - with document reading closed by the operator the flag is still saved
 *     and no catch-up is queued.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";

import type { Prisma, User } from "@/generated/prisma/client";
import { GET, PATCH } from "@/app/api/auth/me/documents-auto-ai-read/route";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import { enqueueSummaryCatchUp } from "@/lib/jobs/document-summary-catchup";
import { DOCUMENT_SUMMARY_CATCHUP_QUEUE } from "@/lib/jobs/document-summary-catchup-queue";

import { anonymous, callRoute } from "../../kit/call-route";
import { makeSession, makeUser, uniqueSuffix } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/auth/me/documents-auto-ai-read";

type AutoRead = { documentsAutoAiRead: boolean };

let boss: PgBoss;

beforeAll(async () => {
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
  await boss.createQueue(DOCUMENT_SUMMARY_CATCHUP_QUEUE);
  setGlobalBoss(boss);
}, 120_000);

afterAll(async () => {
  setGlobalBoss(null);
  await boss?.stop({ graceful: false });
});

beforeEach(() => truncateAllTables(prisma));

/**
 * An account with its own provider key, so the only thing between it and
 * document reading is the consent receipt the switch mints.
 */
async function makeReader(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<User> {
  return makeUser({
    aiProvider: "ANTHROPIC",
    aiModel: "claude-sonnet-4-6",
    // Presence only: the capability probe never decrypts it.
    aiAnthropicKeyEncrypted: "v1:presence-only",
    ...overrides,
  });
}

async function catchUpJobs(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pgboss.job
    WHERE name = ${DOCUMENT_SUMMARY_CATCHUP_QUEUE}
      AND singleton_key = ${`document-summary-catchup|${userId}`}
  `;
  return rows[0]?.n ?? 0;
}

/** The catch-up is fire-and-forget; wait for its job to land on the queue. */
async function waitForCatchUp(userId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await catchUpJobs(userId)) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no catch-up job for ${userId}`);
}

/**
 * Before asserting that a write queued nothing: send a catch-up of our own
 * through the same queue and let it land, so a send the route had started
 * before returning has had the same time to land too.
 */
async function settleQueue(): Promise<void> {
  const probe = `probe-${uniqueSuffix()}`;
  await enqueueSummaryCatchUp(probe);
  await waitForCatchUp(probe);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function storedFlag(userId: string): Promise<boolean> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { documentsAutoAiRead: true },
  });
  return row.documentsAutoAiRead;
}

async function activeReceipts(userId: string): Promise<string[]> {
  const rows = await prisma.consentReceipt.findMany({
    where: { userId, revokedAt: null },
    select: { kind: true },
    orderBy: { kind: "asc" },
  });
  return rows.map((r) => r.kind);
}

async function auditDetails(userId: string): Promise<unknown[]> {
  const rows = await prisma.auditLog.findMany({
    where: { userId, action: "user.documentsAutoAiRead.update" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => JSON.parse(r.details ?? "null"));
}

function patch(user: Pick<User, "id">, documentsAutoAiRead: boolean) {
  return makeSession(user).then((auth) =>
    callRoute<AutoRead>(PATCH, {
      method: "PATCH",
      route: ROUTE,
      body: { documentsAutoAiRead },
      auth,
    }),
  );
}

describe("GET /api/auth/me/documents-auto-ai-read", () => {
  it("refuses an anonymous caller with 401", async () => {
    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      auth: anonymous,
    });
    expect(res.status).toBe(401);
    expect(res.meta?.errorCode).toBe("auth.missing");
  });

  it("answers off for a fresh account and on once it is stored", async () => {
    const fresh = await makeUser();
    const opted = await makeUser({ documentsAutoAiRead: true });
    const off = await callRoute<AutoRead>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(fresh),
    });
    const on = await callRoute<AutoRead>(GET, {
      method: "GET",
      route: ROUTE,
      auth: await makeSession(opted),
    });
    expect(off.data).toEqual({ documentsAutoAiRead: false });
    expect(on.data).toEqual({ documentsAutoAiRead: true });
  });
});

describe("PATCH /api/auth/me/documents-auto-ai-read", () => {
  it("on an off-to-on flip stores the flag, mints the extraction receipt and queues one catch-up", async () => {
    const user = await makeReader();
    // Without a receipt, document reading is closed for this account: the
    // catch-up below can only be queued because the capability is read after
    // the receipt this request mints.
    expect((await aiCapabilityForJob(user.id, "documentAi")).available).toBe(
      false,
    );

    const res = await patch(user, true);

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ documentsAutoAiRead: true });
    expect(await storedFlag(user.id)).toBe(true);
    expect(await activeReceipts(user.id)).toEqual(["ai_extraction"]);
    await waitForCatchUp(user.id);
    await settleQueue();
    expect(await catchUpJobs(user.id)).toBe(1);
    expect(await auditDetails(user.id)).toEqual([
      { previous: false, next: true, consentMinted: true },
    ]);
  });

  it("queues no second catch-up when the switch was already on", async () => {
    // Re-saving an already-on setting must not queue a second pass over the
    // same documents.
    const user = await makeReader({ documentsAutoAiRead: true });
    await prisma.consentReceipt.create({
      data: {
        userId: user.id,
        kind: "ai_extraction",
        artefact: "earlier flip",
        signedAt: new Date(),
      },
    });

    const res = await patch(user, true);

    expect(res.status).toBe(200);
    await settleQueue();
    expect(await catchUpJobs(user.id)).toBe(0);
    expect(await activeReceipts(user.id)).toEqual(["ai_extraction"]);
  });

  it("turning it off stores off, queues nothing and mints nothing", async () => {
    const user = await makeReader({ documentsAutoAiRead: true });

    const res = await patch(user, false);

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ documentsAutoAiRead: false });
    expect(await storedFlag(user.id)).toBe(false);
    await settleQueue();
    expect(await catchUpJobs(user.id)).toBe(0);
    expect(await activeReceipts(user.id)).toEqual([]);
  });

  it.each(["ai_extraction", "ai_full"])(
    "mints no second receipt when an active %s already covers document reads",
    async (kind) => {
      const user = await makeReader();
      await prisma.consentReceipt.create({
        data: {
          userId: user.id,
          kind,
          artefact: "earlier grant",
          signedAt: new Date(),
        },
      });

      const res = await patch(user, true);

      expect(res.status).toBe(200);
      expect(await activeReceipts(user.id)).toEqual([kind]);
      expect(await auditDetails(user.id)).toEqual([
        { previous: false, next: true, consentMinted: false },
      ]);
    },
  );

  it("mints a fresh receipt when the earlier one was revoked", async () => {
    const user = await makeReader();
    await prisma.consentReceipt.create({
      data: {
        userId: user.id,
        kind: "ai_extraction",
        artefact: "earlier grant",
        signedAt: new Date("2026-01-01T00:00:00Z"),
        revokedAt: new Date("2026-02-01T00:00:00Z"),
      },
    });

    const res = await patch(user, true);

    expect(res.status).toBe(200);
    expect(await activeReceipts(user.id)).toEqual(["ai_extraction"]);
  });

  it("treats a receipt minted concurrently by another request as success", async () => {
    // Another request inserts the receipt and has not committed yet: this
    // request's lookup cannot see it, its insert waits on the active-receipt
    // unique index, and fails once the other commits.
    const user = await makeReader();
    const session = await makeSession(user);
    // Wrapped in an object so the transaction does not wait on the request,
    // which itself waits on the transaction's commit.
    const { pending } = await prisma.$transaction(
      async (tx) => {
        await tx.consentReceipt.create({
          data: {
            userId: user.id,
            kind: "ai_extraction",
            artefact: "concurrent flip",
            signedAt: new Date(),
          },
        });
        const request = callRoute<AutoRead>(PATCH, {
          method: "PATCH",
          route: ROUTE,
          body: { documentsAutoAiRead: true },
          auth: session,
        });
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query ILIKE '%INSERT INTO%consent_receipts%'
          `;
          if ((waiting[0]?.n ?? 0) > 0) break;
          if (Date.now() > deadline) {
            throw new Error("the route's receipt insert never waited");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return { pending: request };
      },
      { timeout: 20_000 },
    );

    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ documentsAutoAiRead: true });
    expect(await storedFlag(user.id)).toBe(true);
    expect(await activeReceipts(user.id)).toEqual(["ai_extraction"]);
    expect(await auditDetails(user.id)).toEqual([
      { previous: false, next: true, consentMinted: false },
    ]);
  });

  it("saves the flag but queues no catch-up while the operator has document reading closed", async () => {
    // Every summary the pass would enqueue could only be refused, so the pass
    // is not queued at all.
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", assistantDocumentAiEnabled: false },
      update: { assistantDocumentAiEnabled: false },
    });
    const user = await makeReader();

    const res = await patch(user, true);

    expect(res.status).toBe(200);
    expect(await storedFlag(user.id)).toBe(true);
    await settleQueue();
    expect(await catchUpJobs(user.id)).toBe(0);
  });

  it("refuses a non-boolean flag with 422 and stores nothing", async () => {
    const user = await makeReader();
    const res = await callRoute(PATCH, {
      method: "PATCH",
      route: ROUTE,
      body: { documentsAutoAiRead: "yes" },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(422);
    expect(await storedFlag(user.id)).toBe(false);
    expect(await activeReceipts(user.id)).toEqual([]);
  });
});
