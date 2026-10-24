/**
 * Recently deleted (#1275) against a real Postgres and the real routes.
 *
 *   1. The list holds the caller's deleted documents only: not live ones, not
 *      someone else's; the usage read counts them.
 *   2. list → restore → the document is back in the vault list and gone from
 *      Recently deleted.
 *   3. list → delete now → the row is gone, its import source keys (its own
 *      and an alias) are in the ledger, and an importer re-sending it is still
 *      answered "deleted"; a live or foreign document cannot be purged.
 *   4. A restore removes any ledger entry for the document's keys.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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

const pdf = (tag: string) =>
  Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

type Ctx = { params: Promise<{ id: string }> };
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
type Handler = (r: Request, c: Ctx) => Promise<Response>;

async function seedUser(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "UTC",
      modulePreferencesJson: { inboundDocuments: true },
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  return { user, sessionId: session.id };
}

function asSession(sessionId: string) {
  headerJar.clear();
  cookieJar.clear();
  cookieJar.set("healthlog_session", sessionId);
}

function upload(bytes: Buffer, fields: Record<string, string> = {}): Request {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const form = new FormData();
  form.append("file", new Blob([payload]), "letter.pdf");
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

async function routes() {
  const list = await import("@/app/api/documents/inbound/route");
  const byId = await import("@/app/api/documents/inbound/[id]/route");
  const restore =
    await import("@/app/api/documents/inbound/[id]/restore/route");
  const purge = await import("@/app/api/documents/inbound/[id]/purge/route");
  const deleted = await import("@/app/api/documents/inbound/deleted/route");
  const usage = await import("@/app/api/documents/inbound/usage/route");
  return {
    upload: (r: Request) =>
      (list.POST as unknown as (r: Request) => Promise<Response>)(r),
    vault: async () => {
      const res = await (
        list.GET as unknown as (r: Request) => Promise<Response>
      )(new Request("http://localhost/api/documents/inbound"));
      expect(res.status).toBe(200);
      const body = await res.json();
      return (body.data.documents as Array<{ id: string }>).map((d) => d.id);
    },
    remove: (id: string) =>
      (byId.DELETE as unknown as Handler)(
        new Request(`http://localhost/api/documents/inbound/${id}`, {
          method: "DELETE",
        }),
        ctx(id),
      ),
    restore: (id: string) =>
      (restore.POST as unknown as Handler)(
        new NextRequest(
          `http://localhost/api/documents/inbound/${id}/restore`,
          { method: "POST" },
        ),
        ctx(id),
      ),
    purge: (id: string) =>
      (purge.POST as unknown as Handler)(
        new NextRequest(`http://localhost/api/documents/inbound/${id}/purge`, {
          method: "POST",
        }),
        ctx(id),
      ),
    deleted: () =>
      (deleted.GET as unknown as (r: Request) => Promise<Response>)(
        new Request("http://localhost/api/documents/inbound/deleted"),
      ),
    usage: async () => {
      const res = await (
        usage.GET as unknown as (r: Request) => Promise<Response>
      )(new Request("http://localhost/api/documents/inbound/usage"));
      return (await res.json()).data as { deletedCount: number };
    },
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("Recently deleted — the list", () => {
  it("holds the caller's deleted documents only, newest deletion first, with the purge date", async () => {
    const r = await routes();
    const other = await seedUser("someone-else");
    asSession(other.sessionId);
    const foreign = (await (await r.upload(upload(pdf("theirs")))).json()).data
      .id as string;
    expect((await r.remove(foreign)).status).toBe(200);

    const { sessionId } = await seedUser("owner");
    asSession(sessionId);
    const live = (await (await r.upload(upload(pdf("live")))).json()).data
      .id as string;
    const first = (
      await (
        await r.upload(
          upload(pdf("first"), {
            title: "Discharge letter",
            kind: "DISCHARGE_LETTER",
            documentDate: "2024-05-02",
            sourceSystem: "PAPERLESS",
            sourceId: "77",
          }),
        )
      ).json()
    ).data.id as string;
    const second = (await (await r.upload(upload(pdf("second")))).json()).data
      .id as string;
    expect((await r.remove(first)).status).toBe(200);
    expect((await r.remove(second)).status).toBe(200);

    const res = await r.deleted();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ truncated: false, limit: 200 });
    expect(body.data.graceDays).toBe(30);
    const rows = body.data.documents as Array<Record<string, unknown>>;
    expect(rows.map((d) => d.id)).toEqual([second, first]);
    expect(rows.map((d) => d.id)).not.toContain(live);
    expect(rows.map((d) => d.id)).not.toContain(foreign);
    const letter = rows[1];
    expect(letter).toMatchObject({
      title: "Discharge letter",
      kind: "DISCHARGE_LETTER",
      documentDate: "2024-05-02",
      sourceSystem: "PAPERLESS",
      mimeType: "application/pdf",
    });
    expect(
      new Date(letter.purgeAt as string).getTime() -
        new Date(letter.deletedAt as string).getTime(),
    ).toBe(30 * 86_400_000);
    // No content, no source id: metadata to recognise the document by.
    expect(letter).not.toHaveProperty("contentEncrypted");
    expect(letter).not.toHaveProperty("sourceId");

    expect((await r.usage()).deletedCount).toBe(2);
  });

  it("list → restore → the document is back in the vault and out of the list", async () => {
    const r = await routes();
    const { sessionId } = await seedUser("restorer");
    asSession(sessionId);
    const id = (await (await r.upload(upload(pdf("back")))).json()).data
      .id as string;
    await r.remove(id);
    expect(await r.vault()).toEqual([]);
    const listed = (await (await r.deleted()).json()).data.documents;
    expect(listed.map((d: { id: string }) => d.id)).toEqual([id]);

    expect((await r.restore(id)).status).toBe(200);
    expect(await r.vault()).toEqual([id]);
    expect((await (await r.deleted()).json()).data.documents).toEqual([]);
    expect((await r.usage()).deletedCount).toBe(0);
  });
});

describe("Recently deleted — delete now", () => {
  it("list → delete now → gone, with its import keys carried into the ledger", async () => {
    const prisma = getPrismaClient();
    const r = await routes();
    const { user, sessionId } = await seedUser("purger");
    asSession(sessionId);
    const fields = {
      sourceSystem: "PAPERLESS",
      sourceId: "412",
      sourceInstance: "https://paperless.example",
    };
    const id = (await (await r.upload(upload(pdf("a"), fields))).json()).data
      .id as string;
    // The same bytes under a second key: answered with the stored document,
    // and the key is remembered on it as an alias.
    const alias = await r.upload(
      upload(pdf("a"), { ...fields, sourceId: "9" }),
    );
    expect((await alias.json()).meta).toMatchObject({ duplicate: true });

    // A live document cannot be purged in one step.
    const live = await r.purge(id);
    expect(live.status).toBe(409);
    expect((await live.json()).meta.errorCode).toBe(
      "documents.inbound.notDeleted",
    );

    await r.remove(id);
    const listed = (await (await r.deleted()).json()).data.documents;
    expect(listed.map((d: { id: string }) => d.id)).toEqual([id]);

    const purged = await r.purge(id);
    expect(purged.status).toBe(200);
    expect((await purged.json()).data).toEqual({ id, purged: true });

    expect(await prisma.inboundDocument.count({ where: { id } })).toBe(0);
    expect(await prisma.documentSourceAlias.count()).toBe(0);
    expect((await (await r.deleted()).json()).data.documents).toEqual([]);
    expect(
      await prisma.documentImportKey.findMany({
        where: { userId: user.id },
        select: { sourceSystem: true, sourceId: true, sourceInstance: true },
        orderBy: { sourceId: "asc" },
      }),
    ).toEqual([
      {
        sourceSystem: "PAPERLESS",
        sourceId: "412",
        sourceInstance: "https://paperless.example",
      },
      {
        sourceSystem: "PAPERLESS",
        sourceId: "9",
        sourceInstance: "https://paperless.example",
      },
    ]);
    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: "documents.inbound.purge" },
    });
    expect(audit).not.toBeNull();

    // An importer re-sending either key is still answered "deleted", and
    // nothing is stored.
    for (const sourceId of ["412", "9"]) {
      const again = await r.upload(upload(pdf("a"), { ...fields, sourceId }));
      expect(again.status).toBe(200);
      expect((await again.json()).meta).toEqual({
        duplicate: true,
        deleted: true,
      });
    }
    expect(await prisma.inboundDocument.count()).toBe(0);

    // Restoring it now is over.
    const gone = await r.restore(id);
    expect(gone.status).toBe(409);
    expect((await gone.json()).meta.reason).toBe("purged");
  });

  it("answers 404 for someone else's deleted document and leaves it alone", async () => {
    const prisma = getPrismaClient();
    const r = await routes();
    const owner = await seedUser("owner-b");
    asSession(owner.sessionId);
    const id = (await (await r.upload(upload(pdf("mine")))).json()).data
      .id as string;
    await r.remove(id);

    const intruder = await seedUser("intruder");
    asSession(intruder.sessionId);
    const res = await r.purge(id);
    expect(res.status).toBe(404);
    expect(await prisma.inboundDocument.count({ where: { id } })).toBe(1);
    expect((await (await r.deleted()).json()).data.documents).toEqual([]);
  });
});

describe("Recently deleted — restore and the import ledger", () => {
  it("a restore removes the ledger entries for the document's own and alias keys", async () => {
    const prisma = getPrismaClient();
    const r = await routes();
    const { user, sessionId } = await seedUser("ledger");
    asSession(sessionId);
    const fields = { sourceSystem: "PAPRA", sourceId: "doc_1" };
    const id = (await (await r.upload(upload(pdf("k"), fields))).json()).data
      .id as string;
    await r.upload(upload(pdf("k"), { ...fields, sourceId: "doc_2" }));
    await r.remove(id);

    // A ledger entry for each key, as a purge elsewhere (or an older run)
    // would have left; one for an unrelated key stays.
    await prisma.documentImportKey.createMany({
      data: [
        { userId: user.id, sourceSystem: "PAPRA", sourceId: "doc_1" },
        { userId: user.id, sourceSystem: "PAPRA", sourceId: "doc_2" },
        { userId: user.id, sourceSystem: "PAPRA", sourceId: "unrelated" },
      ],
    });

    expect((await r.restore(id)).status).toBe(200);
    expect(
      (
        await prisma.documentImportKey.findMany({
          where: { userId: user.id },
          select: { sourceId: true },
        })
      ).map((k) => k.sourceId),
    ).toEqual(["unrelated"]);
  });
});
