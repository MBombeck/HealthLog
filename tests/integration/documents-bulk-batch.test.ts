/**
 * `POST /api/documents/inbound/bulk` against a real Postgres: the statement
 * budget of a full 100-id request, and the per-id results of a partial
 * failure.
 *
 * The route used to send one write (or three, for a link) per id, one after
 * the other. On an idle database that went unnoticed; under load a 100-id
 * request took over twenty seconds. Each action now runs over the whole set
 * in a fixed number of statements. The budget pins that: the count for 100
 * ids must equal the count for 10, and stay at or under the number below.
 * Lower a budget in the change that earns it; raising one is a reviewed
 * change with its reason beside the number.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { countStatements, summariseStatements } from "./query-counter";
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

type BulkAction =
  | "setKind"
  | "linkEpisode"
  | "unlinkEpisode"
  | "linkEncounter"
  | "unlinkEncounter"
  | "delete"
  | "restore";

/**
 * Statements per request, whatever the number of ids. Each covers the
 * request's fixed part (session, module gate, rate limit, sharing scope, the
 * owned-id sweep, the audit row) plus the action's own statements.
 */
const BUDGET: Record<BulkAction, number> = {
  // Nine fixed statements, then one update (one per id before).
  setKind: 10,
  // The service re-reads the target and the live documents, then one insert
  // (three statements per id before).
  linkEpisode: 13,
  // The episode check, then one delete.
  unlinkEpisode: 11,
  linkEncounter: 13,
  unlinkEncounter: 11,
  // One guarded update (one per id before).
  delete: 10,
  // The tombstones, the live duplicates of their bytes, their facts, and one
  // transaction (one update per restored status, the import keys, the ledger
  // cleanup); five or more per id before.
  restore: 17,
};

interface BulkResult {
  id: string;
  ok: boolean;
  error: string | null;
}

async function seedUser(username: string): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { inboundDocuments: true },
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

/** `count` documents with distinct bytes; ids are `${prefix}-001` onward. */
async function seedDocs(
  userId: string,
  prefix: string,
  count: number,
  extra: { deletedAt?: Date; sha?: (i: number) => string } = {},
): Promise<string[]> {
  const ids = Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`,
  );
  await getPrismaClient().inboundDocument.createMany({
    data: ids.map((id, i) => ({
      id,
      userId,
      filename: `${id}.pdf`,
      mimeType: "application/pdf",
      byteSize: 4,
      contentEncrypted: Buffer.from(id),
      contentCodec: "binary2",
      contentSha256: extra.sha
        ? extra.sha(i)
        : createHash("sha256").update(id).digest("hex"),
      deletedAt: extra.deletedAt ?? null,
      status: extra.deletedAt ? "DISCARDED" : "STORED",
    })),
  });
  return ids;
}

async function postBulk(body: Record<string, unknown>): Promise<{
  status: number;
  results: BulkResult[];
}> {
  const { POST } = await import("@/app/api/documents/inbound/bulk/route");
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/documents/inbound/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as { data: { results: BulkResult[] } };
  return { status: res.status, results: json.data?.results ?? [] };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("documents bulk — statement budget", () => {
  async function fixture(prefix: string) {
    const prisma = getPrismaClient();
    const userId = await seedUser(`bulk-budget-${prefix}`);
    const episode = await prisma.illnessEpisode.create({
      data: {
        userId,
        label: "Knee",
        type: "OTHER",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const encounter = await prisma.encounter.create({
      data: { userId, occurredAt: new Date("2026-02-01T09:00:00.000Z") },
    });
    const small = await seedDocs(userId, `${prefix}s`, 10);
    const large = await seedDocs(userId, `${prefix}l`, 100);
    return {
      userId,
      episodeId: episode.id,
      encounterId: encounter.id,
      small,
      large,
    };
  }

  /** Counts one request; the results must all be ok. */
  async function measure(body: Record<string, unknown>, size: number) {
    const m = await countStatements(() => postBulk(body));
    expect(m.result.status).toBe(200);
    expect(m.result.results).toHaveLength(size);
    expect(
      m.result.results.filter((r) => !r.ok),
      `${String(body.action)} failures`,
    ).toEqual([]);
    return m;
  }

  it("holds every action to a fixed count from 10 to 100 ids", async () => {
    const { small, large, episodeId, encounterId } = await fixture("b");
    const prisma = getPrismaClient();
    // Warm the process-level caches a running server already holds.
    await postBulk({ ids: [small[0]], action: "setKind", kind: "OTHER" });

    const steps: Array<{ action: BulkAction; extra: Record<string, string> }> =
      [
        { action: "setKind", extra: { kind: "LAB_RESULT" } },
        { action: "linkEpisode", extra: { episodeId } },
        { action: "unlinkEpisode", extra: { episodeId } },
        { action: "linkEncounter", extra: { encounterId } },
        { action: "unlinkEncounter", extra: { encounterId } },
        { action: "delete", extra: {} },
        { action: "restore", extra: {} },
      ];

    for (const { action, extra } of steps) {
      const few = await measure({ ids: small, action, ...extra }, 10);
      const many = await measure({ ids: large, action, ...extra }, 100);
      expect(
        many.count,
        `${action}: 100 ids sent ${many.count} statements, 10 ids sent ${few.count}\n` +
          summariseStatements(many.statements),
      ).toBe(few.count);
      expect(
        many.count,
        `${action} over its budget of ${BUDGET[action]}\n` +
          summariseStatements(many.statements),
      ).toBeLessThanOrEqual(BUDGET[action]);
    }

    // The writes landed, scoped to the record.
    expect(
      await prisma.inboundDocument.count({
        where: { id: { in: large }, kind: "LAB_RESULT", deletedAt: null },
      }),
    ).toBe(100);
    expect(await prisma.documentConditionLink.count()).toBe(0);
    expect(await prisma.encounterDocumentLink.count()).toBe(0);
  });
});

describe("documents bulk — per-id results", () => {
  it("reports each failure on its own id and applies the rest", async () => {
    const prisma = getPrismaClient();
    const otherId = await seedUser("bulk-other");
    const [foreign] = await seedDocs(otherId, "foreign", 1);
    const userId = await seedUser("bulk-partial");
    const ids = await seedDocs(userId, "pf", 5);
    await prisma.inboundDocument.update({
      where: { id: ids[2] },
      data: { deletedAt: new Date(), status: "DISCARDED" },
    });

    const setKind = await postBulk({
      ids: [...ids, foreign, "does-not-exist"],
      action: "setKind",
      kind: "REFERRAL",
    });
    expect(setKind.status).toBe(200);
    expect(setKind.results).toEqual([
      { id: ids[0], ok: true, error: null },
      { id: ids[1], ok: true, error: null },
      { id: ids[2], ok: false, error: "notFound" },
      { id: ids[3], ok: true, error: null },
      { id: ids[4], ok: true, error: null },
      { id: foreign, ok: false, error: "notFound" },
      { id: "does-not-exist", ok: false, error: "notFound" },
    ]);
    // 1 of 5 could not be updated; the foreign row is untouched.
    expect(
      await prisma.inboundDocument.count({
        where: { userId, kind: "REFERRAL" },
      }),
    ).toBe(4);
    expect(
      (
        await prisma.inboundDocument.findUniqueOrThrow({
          where: { id: foreign },
        })
      ).kind,
    ).toBe("OTHER");

    // Link: the tombstoned and the foreign id fail, the rest file.
    const episode = await prisma.illnessEpisode.create({
      data: {
        userId,
        label: "Knee",
        type: "OTHER",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const link = await postBulk({
      ids: [ids[0], ids[2], foreign],
      action: "linkEpisode",
      episodeId: episode.id,
    });
    expect(link.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(
      await prisma.documentConditionLink.findMany({
        select: { documentId: true, userId: true },
      }),
    ).toEqual([{ documentId: ids[0], userId }]);

    // Delete: an already-deleted id is a no-op success; foreign stays live.
    const del = await postBulk({
      ids: [ids[0], ids[2], foreign],
      action: "delete",
    });
    expect(del.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(
      (
        await prisma.inboundDocument.findUniqueOrThrow({
          where: { id: foreign },
        })
      ).deletedAt,
    ).toBeNull();
  });

  it("restores per id: a duplicate of live bytes and a second copy in the batch conflict", async () => {
    const prisma = getPrismaClient();
    const userId = await seedUser("bulk-restore");
    const sha = (tag: string) => tag.padEnd(64, "0");
    // A live document holding bytes A; two tombstones holding bytes B; one
    // tombstone holding bytes A; one plain tombstone with a pending fact and
    // an import key in the ledger.
    const [liveA] = await seedDocs(userId, "live", 1, { sha: () => sha("a") });
    const deletedAt = new Date();
    const [b1, b2] = await seedDocs(userId, "dupb", 2, {
      deletedAt,
      sha: () => sha("b"),
    });
    const [a2] = await seedDocs(userId, "dupa", 1, {
      deletedAt,
      sha: () => sha("a"),
    });
    const [plain] = await seedDocs(userId, "plain", 1, { deletedAt });
    await prisma.inboundDocument.update({
      where: { id: plain },
      data: { sourceSystem: "paperless", sourceId: "42" },
    });
    await prisma.documentImportKey.create({
      data: { userId, sourceSystem: "paperless", sourceId: "42" },
    });
    await prisma.extractedFact.create({
      data: {
        documentId: plain,
        userId,
        factType: "OBSERVATION",
        dataEncrypted: Buffer.from("x"),
        provenanceEncrypted: Buffer.from("y"),
      },
    });

    const restore = await postBulk({
      ids: [b1, b2, a2, plain, liveA, "does-not-exist"],
      action: "restore",
    });
    expect(restore.status).toBe(200);
    expect(restore.results).toEqual([
      { id: b1, ok: true, error: null },
      { id: b2, ok: false, error: "conflict" },
      { id: a2, ok: false, error: "conflict" },
      { id: plain, ok: true, error: null },
      { id: liveA, ok: true, error: null },
      { id: "does-not-exist", ok: false, error: "notFound" },
    ]);
    const rows = await prisma.inboundDocument.findMany({
      where: { id: { in: [b1, b2, a2, plain] } },
      select: { id: true, deletedAt: true, status: true },
      orderBy: { id: "asc" },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(b1)?.deletedAt).toBeNull();
    expect(byId.get(b1)?.status).toBe("STORED");
    expect(byId.get(b2)?.deletedAt).not.toBeNull();
    expect(byId.get(a2)?.deletedAt).not.toBeNull();
    expect(byId.get(plain)?.deletedAt).toBeNull();
    expect(byId.get(plain)?.status).toBe("EXTRACTED");
    expect(await prisma.documentImportKey.count()).toBe(0);
  });
});
