/**
 * Document import (#1038) against a real Postgres, the real resolver and the
 * real upload route — no mocked Prisma, no mocked `requireAuth`.
 *
 *   1. A `documents:write` token minted from a cookie session uploads and gets
 *      a receipt; a re-send is a duplicate; after the owner deletes the
 *      document a re-send is answered "deleted" and stores nothing; after the
 *      purge the ledger keeps answering that.
 *   2. The source key's unique index covers tombstones at the database level.
 *   3. The token's own bucket 429s with Retry-After without touching the
 *      owner's; the quota answers 413 with its figures.
 *   4. The token reaches no other route: every other vault leg, the mint, and
 *      the measurement write refuse it.
 *   5. With the vault module off the token gets 403 `module.disabled`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-documents-import-32-bytes-min-0987654321abcd";

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

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);
const pdf = (tag: string) =>
  Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

let userId = "";
let sessionId = "";
let token = "";

async function seedUser(modules: Record<string, boolean>) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "importer",
      email: "importer@example.test",
      role: "USER",
      timezone: "UTC",
      modulePreferencesJson: modules,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  userId = user.id;
  sessionId = session.id;
}

function asCookie() {
  headerJar.clear();
  cookieJar.set("healthlog_session", sessionId);
}

function asToken() {
  cookieJar.clear();
  headerJar.set("authorization", `Bearer ${token}`);
}

async function mintDocumentToken(): Promise<string> {
  asCookie();
  const { POST } = await import("@/app/api/tokens/documents/route");
  const res = await POST(
    new NextRequest("https://health.example/api/tokens/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Paperless workflow" }),
    } as never),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.token as string;
}

function upload(
  bytes: Buffer,
  fields: Record<string, string> = {},
  filename = "letter.pdf",
): Request {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const form = new FormData();
  form.append("file", new Blob([payload]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers: Record<string, string> = {};
  const auth = headerJar.get("authorization");
  if (auth) headers.authorization = auth;
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: form,
    headers,
  });
}

async function post(r: Request): Promise<Response> {
  const route = await import("@/app/api/documents/inbound/route");
  return (route.POST as unknown as (r: Request) => Promise<Response>)(r);
}

type Ctx = { params: Promise<{ id: string }> };
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  delete process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR;
});

afterEach(() => {
  delete process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR;
});

describe("document import through a documents:write token", () => {
  it("201 → 200 duplicate → delete → 200 deleted, no new row → purge → still deleted", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    const prisma = getPrismaClient();

    // The mint wrote exactly one narrow scope.
    const row = await prisma.apiToken.findFirstOrThrow({ where: { userId } });
    expect(row.permissions).toEqual(["documents:write"]);

    const fields = {
      title: "Befund Kardiologie",
      documentDate: "2019-03-05",
      sourceSystem: "PAPERLESS",
      sourceId: "412",
      aiRead: "defer",
    };

    asToken();
    const first = await post(upload(pdf("a"), fields));
    expect(first.status).toBe(201);
    const receipt = await first.json();
    // A receipt, not the row: no title, filename, kind or links.
    expect(Object.keys(receipt.data).sort()).toEqual(["duplicate", "id"]);
    expect(receipt.data.duplicate).toBe(false);
    const id = receipt.data.id as string;

    const stored = await prisma.inboundDocument.findUniqueOrThrow({
      where: { id },
      omit: { contentEncrypted: true },
    });
    expect(stored).toMatchObject({
      userId,
      title: "Befund Kardiologie",
      sourceSystem: "PAPERLESS",
      sourceId: "412",
      summaryState: "NONE",
    });
    expect(stored.documentDate?.toISOString().slice(0, 10)).toBe("2019-03-05");

    // Re-send: same source key → duplicate, even with different bytes.
    const again = await post(upload(pdf("a-rescanned"), fields));
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({ id, duplicate: true });

    // The owner sees where it came from.
    asCookie();
    const byId = await import("@/app/api/documents/inbound/[id]/route");
    const detail = await (
      byId.GET as unknown as (r: Request, c: Ctx) => Promise<Response>
    )(new Request(`http://localhost/api/documents/inbound/${id}`), ctx(id));
    expect(detail.status).toBe(200);
    expect((await detail.json()).data).toMatchObject({
      sourceSystem: "PAPERLESS",
      sourceId: "412",
    });

    // The owner deletes it (tombstone).
    const del = await (
      byId.DELETE as unknown as (r: Request, c: Ctx) => Promise<Response>
    )(
      new Request(`http://localhost/api/documents/inbound/${id}`, {
        method: "DELETE",
      }),
      ctx(id),
    );
    expect(del.status).toBe(200);

    // A re-run of the importer does not bring it back.
    asToken();
    const afterDelete = await post(upload(pdf("a"), fields));
    expect(afterDelete.status).toBe(200);
    const deletedBody = await afterDelete.json();
    expect(deletedBody.data).toEqual({ id, duplicate: true, deleted: true });
    expect(deletedBody.meta).toEqual({ duplicate: true, deleted: true });
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(1);

    // Past the grace window the purge takes the row and keeps the key.
    const { purgeExpiredDocumentTombstones } =
      await import("@/lib/jobs/document-purge");
    const purged = await purgeExpiredDocumentTombstones(
      prisma as never,
      new Date(Date.now() + 31 * 86_400_000),
    );
    expect(purged).toBe(1);
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(0);
    expect(
      await prisma.documentImportKey.findMany({
        where: { userId },
        select: { sourceSystem: true, sourceId: true },
      }),
    ).toEqual([{ sourceSystem: "PAPERLESS", sourceId: "412" }]);

    const afterPurge = await post(upload(pdf("a"), fields));
    expect(afterPurge.status).toBe(200);
    expect((await afterPurge.json()).data).toEqual({
      id: null,
      duplicate: true,
      deleted: true,
    });
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(0);

    // A different source key is a new document.
    const other = await post(upload(pdf("b"), { ...fields, sourceId: "413" }));
    expect(other.status).toBe(201);
  });

  it("the source-key index holds tombstones at the database level", async () => {
    await seedUser({ inboundDocuments: true });
    const prisma = getPrismaClient();
    const base = {
      userId,
      mimeType: "application/pdf",
      byteSize: 1,
      contentEncrypted: new Uint8Array([1]),
      sourceSystem: "PAPRA",
      sourceId: "doc_1",
    };
    await prisma.inboundDocument.create({
      data: { ...base, deletedAt: new Date() },
    });
    await expect(
      prisma.inboundDocument.create({ data: base }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Rows without a source key are not constrained by it.
    await prisma.inboundDocument.create({
      data: { ...base, sourceSystem: null, sourceId: null },
    });
    await prisma.inboundDocument.create({
      data: { ...base, sourceSystem: null, sourceId: null },
    });
  });

  it("429s the token on its own bucket with Retry-After, and the owner's uploads still pass", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "1";

    asToken();
    expect((await post(upload(pdf("one")))).status).toBe(201);
    const limited = await post(upload(pdf("two")));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited.json()).meta.errorCode).toBe(
      "documents.inbound.rateLimited",
    );

    asCookie();
    const own = await post(upload(pdf("three")));
    expect(own.status).toBe(201);
    // The cookie caller still gets the full row.
    expect((await own.json()).data.title).toBeNull();
  });

  it("413s past the quota without the figures, storing nothing", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    await getPrismaClient().user.update({
      where: { id: userId },
      data: { documentQuotaBytes: BigInt(10) },
    });
    asToken();
    const res = await post(upload(PNG_1X1, {}, "x.png"));
    expect(res.status).toBe(413);
    const body = await res.json();
    // The figures are the owner's; the token hears only that it is full.
    expect(body.meta.reason).toBe("quotaExceeded");
    expect(body.meta).not.toHaveProperty("quotaBytes");
    expect(body.meta).not.toHaveProperty("usedBytes");
    expect(
      await getPrismaClient().inboundDocument.count({ where: { userId } }),
    ).toBe(0);
  });

  it("403 module.disabled while the vault is off", async () => {
    await seedUser({ inboundDocuments: false });
    token = await mintDocumentToken();
    asToken();
    const res = await post(upload(pdf("x")));
    expect(res.status).toBe(403);
    expect((await res.json()).meta.errorCode).toBe("module.disabled");
  });
});

describe("source keys that reach a document by its bytes (#1038)", () => {
  it("a key answered with an existing document stays deleted after delete and purge", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    const prisma = getPrismaClient();

    // Stored by hand first, no key.
    asCookie();
    const manual = await post(upload(pdf("same")));
    expect(manual.status).toBe(201);
    const id = (await manual.json()).data.id as string;

    // The import sends the same bytes under two keys: both answered with it.
    asToken();
    for (const sourceId of ["K1", "K2"]) {
      const res = await post(
        upload(pdf("same"), { sourceSystem: "PAPRA", sourceId }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ id, duplicate: true });
    }
    expect(
      await prisma.documentSourceAlias.count({ where: { documentId: id } }),
    ).toBe(2);

    // Deleted: both keys answer "deleted", even with different bytes.
    asCookie();
    const byId = await import("@/app/api/documents/inbound/[id]/route");
    await (byId.DELETE as unknown as (r: Request, c: Ctx) => Promise<Response>)(
      new Request(`http://localhost/api/documents/inbound/${id}`, {
        method: "DELETE",
      }),
      ctx(id),
    );
    asToken();
    const tomb = await post(
      upload(pdf("rescan"), { sourceSystem: "PAPRA", sourceId: "K2" }),
    );
    expect((await tomb.json()).data).toEqual({
      id,
      duplicate: true,
      deleted: true,
    });

    // Purged: the aliases move to the ledger with the row.
    const { purgeExpiredDocumentTombstones } =
      await import("@/lib/jobs/document-purge");
    await purgeExpiredDocumentTombstones(
      prisma as never,
      new Date(Date.now() + 31 * 86_400_000),
    );
    expect(await prisma.documentSourceAlias.count()).toBe(0);
    expect(
      (
        await prisma.documentImportKey.findMany({
          where: { userId },
          select: { sourceId: true },
          orderBy: { sourceId: "asc" },
        })
      ).map((k) => k.sourceId),
    ).toEqual(["K1", "K2"]);
    for (const sourceId of ["K1", "K2"]) {
      const res = await post(
        upload(pdf("same"), { sourceSystem: "PAPRA", sourceId }),
      );
      expect((await res.json()).data).toEqual({
        id: null,
        duplicate: true,
        deleted: true,
      });
    }
    expect(await prisma.inboundDocument.count({ where: { userId } })).toBe(0);
  });
});

describe("re-sends cost no allowance and no body read (#1038)", () => {
  it("answers a query-string key before the body and the bucket, and the lookup agrees", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "1";
    asToken();

    const key = "?sourceSystem=PAPERLESS&sourceId=77";
    const first = await post(
      new Request(`http://localhost/api/documents/inbound${key}`, {
        method: "POST",
        body: (() => {
          const f = new FormData();
          f.append("file", new Blob([new Uint8Array(pdf("x"))]), "x.pdf");
          return f;
        })(),
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(first.status).toBe(201);

    // The one slot is spent; re-sends still answer, with no body at all.
    for (let i = 0; i < 3; i++) {
      const again = await post(
        new Request(`http://localhost/api/documents/inbound${key}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(again.status).toBe(200);
      expect((await again.json()).data.duplicate).toBe(true);
    }

    const lookup = await import("@/app/api/documents/inbound/source/route");
    const get = (q: string) =>
      (lookup.GET as unknown as (r: Request) => Promise<Response>)(
        new NextRequest(`http://localhost/api/documents/inbound/source${q}`, {
          headers: { authorization: `Bearer ${token}` },
        } as never),
      );
    const known = await get(key);
    expect(known.status).toBe(200);
    expect((await known.json()).data).toMatchObject({
      known: true,
      deleted: false,
    });
    const unknown = await get("?sourceSystem=PAPERLESS&sourceId=78");
    expect((await unknown.json()).data).toEqual({
      known: false,
      id: null,
      deleted: false,
    });
    expect((await get("?sourceSystem=PAPERLESS")).status).toBe(422);

    // A new document still meets the spent bucket.
    const blocked = await post(upload(pdf("new")));
    expect(blocked.status).toBe(429);
  });

  it("a duplicate by bytes hands its slot back", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    process.env.DOCUMENT_UPLOAD_LIMIT_PER_HOUR = "2";
    asToken();
    expect((await post(upload(pdf("one")))).status).toBe(201);
    // Charged and handed back each time; without the refund the second of
    // these would already meet a spent bucket.
    expect((await post(upload(pdf("one")))).status).toBe(200);
    expect((await post(upload(pdf("one")))).status).toBe(200);
    expect((await post(upload(pdf("two")))).status).toBe(201);
    expect((await post(upload(pdf("three")))).status).toBe(429);
  });
});

describe("aiRead=defer is kept on the row (#1038)", () => {
  it("marks the upload and leaves others alone", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    asToken();
    const deferred = await post(upload(pdf("d"), { aiRead: "defer" }));
    const plain = await post(upload(pdf("p")));
    const rows = await getPrismaClient().inboundDocument.findMany({
      where: { userId },
      select: { id: true, aiReadDeferred: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.aiReadDeferred]));
    expect(byId.get((await deferred.json()).data.id)).toBe(true);
    expect(byId.get((await plain.json()).data.id)).toBe(false);
  });
});

describe("a documents:write token reaches nothing else", () => {
  it("is refused by every other vault leg, the mints and the measurement write", async () => {
    await seedUser({ inboundDocuments: true });
    token = await mintDocumentToken();
    asToken();
    const created = await post(upload(pdf("seed")));
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id as string;

    const auth = { authorization: `Bearer ${token}` };
    const json = (body: unknown) => ({
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const u = (path: string) => `http://localhost${path}`;
    type Call = [string, () => Promise<Response>];
    type Mod = Record<string, unknown>;
    const withId = async (
      route: Mod,
      mod: string,
      method: string,
      init: RequestInit = { headers: auth },
    ): Promise<Response> =>
      (route[method] as (r: Request, c: Ctx) => Promise<Response>)(
        new NextRequest(u(`/api/documents/inbound/${id}${mod}`), {
          method,
          ...init,
        } as never),
        ctx(id),
      );
    const noId = async (
      route: Mod,
      mod: string,
      method: string,
      init: RequestInit = { headers: auth },
    ): Promise<Response> =>
      (route[method] as (r: Request) => Promise<Response>)(
        new NextRequest(u(`/api/documents/inbound${mod}`), {
          method,
          ...init,
        } as never),
      );
    const r = {
      list: await import("@/app/api/documents/inbound/route"),
      usage: await import("@/app/api/documents/inbound/usage/route"),
      capability: await import("@/app/api/documents/inbound/capability/route"),
      reindex: await import("@/app/api/documents/inbound/reindex/route"),
      bulk: await import("@/app/api/documents/inbound/bulk/route"),
      byId: await import("@/app/api/documents/inbound/[id]/route"),
      original: await import("@/app/api/documents/inbound/[id]/original/route"),
      thumbnail:
        await import("@/app/api/documents/inbound/[id]/thumbnail/route"),
      restore: await import("@/app/api/documents/inbound/[id]/restore/route"),
      extract: await import("@/app/api/documents/inbound/[id]/extract/route"),
      index: await import("@/app/api/documents/inbound/[id]/index/route"),
      summary: await import("@/app/api/documents/inbound/[id]/summary/route"),
      suggest: await import("@/app/api/documents/inbound/[id]/suggest/route"),
      chat: await import("@/app/api/documents/inbound/[id]/chat/route"),
      confirm: await import("@/app/api/documents/inbound/[id]/confirm/route"),
    } as unknown as Record<string, Mod>;

    const calls: Call[] = [
      ["GET list", () => noId(r.list, "", "GET")],
      ["GET usage", () => noId(r.usage, "/usage", "GET")],
      ["GET capability", () => noId(r.capability, "/capability", "GET")],
      ["POST reindex", () => noId(r.reindex, "/reindex", "POST")],
      [
        "POST bulk",
        () =>
          noId(r.bulk, "/bulk", "POST", json({ action: "delete", ids: [id] })),
      ],
      ["GET detail", () => withId(r.byId, "", "GET")],
      ["PATCH detail", () => withId(r.byId, "", "PATCH", json({ title: "x" }))],
      ["DELETE detail", () => withId(r.byId, "", "DELETE")],
      ["GET original", () => withId(r.original, "/original", "GET")],
      ["GET thumbnail", () => withId(r.thumbnail, "/thumbnail", "GET")],
      ["POST restore", () => withId(r.restore, "/restore", "POST")],
      ["POST extract", () => withId(r.extract, "/extract", "POST")],
      ["POST index", () => withId(r.index, "/index", "POST")],
      ["POST summary", () => withId(r.summary, "/summary", "POST")],
      ["POST suggest", () => withId(r.suggest, "/suggest", "POST")],
      ["GET chat", () => withId(r.chat, "/chat", "GET")],
      [
        "POST confirm",
        () => withId(r.confirm, "/confirm", "POST", json({ decisions: [] })),
      ],
      [
        "POST documents mint",
        async () => {
          const { POST } = await import("@/app/api/tokens/documents/route");
          return POST(
            new NextRequest(u("/api/tokens/documents"), {
              method: "POST",
              ...json({ name: "second" }),
            } as never),
          );
        },
      ],
      [
        "POST measurements",
        async () => {
          const { POST } = await import("@/app/api/measurements/route");
          return (POST as unknown as (r: Request) => Promise<Response>)(
            new NextRequest(u("/api/measurements"), {
              method: "POST",
              ...json({ type: "WEIGHT", value: 80, measuredAt: new Date() }),
            } as never),
          );
        },
      ],
    ];

    const outcomes: Record<string, number> = {};
    for (const [name, call] of calls) {
      outcomes[name] = (await call()).status;
    }
    // Every leg refuses: 403 on a scope decision, 401 on the cookie-only mint.
    for (const [name, status] of Object.entries(outcomes)) {
      expect({ name, refused: status === 401 || status === 403 }).toEqual({
        name,
        refused: true,
      });
    }
    expect(outcomes["POST documents mint"]).toBe(401);

    // And none of them changed the document.
    const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
      where: { id },
      omit: { contentEncrypted: true },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.title).toBeNull();
  });
});
