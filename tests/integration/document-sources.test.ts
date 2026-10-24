/**
 * The document picker (#1038) against a real Postgres, the real auth resolver
 * and the real routes. Only the network is replaced: `safeFetch` answers from
 * an in-memory Paperless-ngx, so every assertion about what was fetched (and
 * what was not) is a count on that fake.
 *
 *   1. With `DOCUMENT_SOURCE_ORIGINS` unset the picker is off.
 *   2. Saving refuses an unlisted origin and a refused token, stores nothing
 *      then, and otherwise stores the token encrypted and never returns it.
 *   3. Only the owner's browser session reaches the routes: a `["*"]` Bearer
 *      and a delegate acting on the owner's record are refused.
 *   4. Search reports what the vault holds per source key; import stores
 *      through the upload's ingest path with provenance; a re-import is a
 *      duplicate and a document deleted in HealthLog stays deleted, both
 *      without a download.
 *   5. An import links to the record it was picked for, and a foreign record
 *      is refused before anything is fetched.
 *   6. An origin the operator removed cuts the stored connection off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-document-sources-32-bytes-min-0987654321abcd";

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

// ── The fake Paperless-ngx behind `safeFetch` ──────────────────────────────

const ORIGIN = "http://paperless.lan:8000";
/** A second Paperless-ngx the operator also listed; same ids, other documents. */
const ORIGIN_B = "https://paperless-b.example.com";
const TOKEN = "paperless-token-0123456789-secret";

const PDF = (tag: string) =>
  Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

const DOCS = [
  {
    id: 41,
    title: "Blood test",
    created: "2024-03-04",
    tags: [7],
    original_file_name: "blood.pdf",
    bytes: PDF("blood"),
  },
  {
    id: 42,
    title: "Discharge letter",
    created: "2023-11-20",
    tags: [],
    original_file_name: "discharge.pdf",
    bytes: PDF("discharge"),
  },
];

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; opts: Record<string, unknown> }>,
  acceptToken: "",
  /** Delay a download so two imports of one key overlap. */
  downloadDelayMs: 0,
  /** Answer downloads with this status instead of the file. */
  downloadStatus: 200,
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: vi.fn(
      async (
        target: string,
        init: RequestInit,
        opts: Record<string, unknown>,
      ) => {
        fake.calls.push({ url: String(target), opts });
        const url = new URL(String(target));
        if (url.origin !== opts.operatorApprovedPrivateOrigin) {
          throw new actual.SafeFetchError("not approved", "private_host");
        }
        const auth = (init.headers as Record<string, string>).Authorization;
        if (auth !== `Token ${fake.acceptToken}`) {
          return new Response("{}", { status: 401 });
        }
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        const path = url.pathname;
        if (path === "/api/tags/") {
          return json({ results: [{ id: 7, name: "Health" }], next: null });
        }
        if (path === "/api/documents/") {
          // Tag 99: a server that ignores the tag filter, with the only match
          // on its second page.
          if (url.searchParams.get("tags__id__all") === "99") {
            const page2 = url.searchParams.get("page") === "2";
            return json({
              next: page2 ? null : "next",
              results: page2
                ? [
                    {
                      id: 41,
                      title: "Blood test",
                      created: "2024-03-04",
                      tags: [99],
                    },
                  ]
                : [
                    {
                      id: 42,
                      title: "Discharge letter",
                      created: "2023-11-20",
                      tags: [],
                    },
                  ],
            });
          }
          const q = (
            url.searchParams.get("title__icontains") ?? ""
          ).toLowerCase();
          return json({
            next: null,
            results: DOCS.filter((d) => d.title.toLowerCase().includes(q)).map(
              ({ bytes: _bytes, ...doc }) => doc,
            ),
          });
        }
        const download = /^\/api\/documents\/(\d+)\/download\/$/.exec(path);
        if (download) {
          const doc = DOCS.find((d) => String(d.id) === download[1]);
          if (fake.downloadDelayMs > 0) {
            await new Promise((r) => setTimeout(r, fake.downloadDelayMs));
          }
          if (fake.downloadStatus !== 200) {
            return new Response("", { status: fake.downloadStatus });
          }
          // Each instance holds different bytes under the same id.
          return doc
            ? new Response(
                new Uint8Array(
                  Buffer.concat([doc.bytes, Buffer.from(`% ${url.origin}\n`)]),
                ),
              )
            : new Response("", { status: 404 });
        }
        const detail = /^\/api\/documents\/(\d+)\/$/.exec(path);
        if (detail) {
          const doc = DOCS.find((d) => String(d.id) === detail[1]);
          if (!doc) return new Response("{}", { status: 404 });
          const { bytes: _bytes, ...meta } = doc;
          return json(meta);
        }
        return new Response("{}", { status: 404 });
      },
    ),
  };
});

import { decrypt } from "@/lib/crypto";
import { hashToken } from "@/lib/auth/hmac";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";

// ── Helpers ────────────────────────────────────────────────────────────────

let userId = "";
let sessionId = "";

async function makeUser(name: string) {
  return getPrismaClient().user.create({
    data: {
      username: name,
      email: `${name}@example.test`,
      role: "USER",
      timezone: "UTC",
      modulePreferencesJson: { inboundDocuments: true },
    },
  });
}

async function signIn(id: string) {
  return getPrismaClient().session.create({
    data: { userId: id, expiresAt: new Date(Date.now() + 600_000) },
  });
}

async function seedOwner() {
  const user = await makeUser("owner");
  const session = await signIn(user.id);
  userId = user.id;
  sessionId = session.id;
  asCookie(sessionId);
}

function asCookie(id: string) {
  headerJar.clear();
  cookieJar.set("healthlog_session", id);
}

type Params = { params: Promise<{ system: string }> };
const paperless: Params = {
  params: Promise.resolve({ system: "paperless" }),
};
type Handler = (r: NextRequest, c: Params) => Promise<Response>;

function jsonRequest(url: string, method: string, body?: unknown) {
  const headers: Record<string, string> = {};
  const auth = headerJar.get("authorization");
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`https://health.example${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  } as never);
}

async function status(): Promise<Response> {
  const { GET } = await import("@/app/api/documents/sources/route");
  return (GET as unknown as (r: NextRequest) => Promise<Response>)(
    jsonRequest("/api/documents/sources", "GET"),
  );
}

async function save(body: unknown): Promise<Response> {
  const { PUT } = await import("@/app/api/documents/sources/[system]/route");
  return (PUT as unknown as Handler)(
    jsonRequest("/api/documents/sources/paperless", "PUT", body),
    paperless,
  );
}

async function disconnect(): Promise<Response> {
  const { DELETE } = await import("@/app/api/documents/sources/[system]/route");
  return (DELETE as unknown as Handler)(
    jsonRequest("/api/documents/sources/paperless", "DELETE"),
    paperless,
  );
}

async function search(query = ""): Promise<Response> {
  const { GET } =
    await import("@/app/api/documents/sources/[system]/search/route");
  return (GET as unknown as Handler)(
    jsonRequest(`/api/documents/sources/paperless/search?${query}`, "GET"),
    paperless,
  );
}

async function importDoc(body: unknown): Promise<Response> {
  const { POST } =
    await import("@/app/api/documents/sources/[system]/import/route");
  return (POST as unknown as Handler)(
    jsonRequest("/api/documents/sources/paperless/import", "POST", body),
    paperless,
  );
}

async function connect() {
  fake.acceptToken = TOKEN;
  const res = await save({ baseUrl: `${ORIGIN}/`, token: TOKEN });
  expect(res.status).toBe(200);
  return res;
}

function downloads(): number {
  return fake.calls.filter((c) => c.url.includes("/download/")).length;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  fake.calls.length = 0;
  fake.acceptToken = TOKEN;
  fake.downloadDelayMs = 0;
  fake.downloadStatus = 200;
  process.env.DOCUMENT_SOURCE_ORIGINS = `${ORIGIN},${ORIGIN_B}`;
});

afterEach(() => {
  delete process.env.DOCUMENT_SOURCE_ORIGINS;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("the operator's list switches the picker on", () => {
  it("is off without DOCUMENT_SOURCE_ORIGINS, and nothing is dialled", async () => {
    delete process.env.DOCUMENT_SOURCE_ORIGINS;
    await seedOwner();
    const off = await status();
    expect(off.status).toBe(200);
    expect((await off.json()).data).toEqual({
      available: false,
      allowedOrigins: [],
      connections: [],
    });
    const refused = await save({ baseUrl: ORIGIN, token: TOKEN });
    expect(refused.status).toBe(404);
    expect((await refused.json()).meta.errorCode).toBe(
      "documents.sources.unavailable",
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("saving a connection", () => {
  it("refuses an origin the operator did not list, public or private, without dialling", async () => {
    await seedOwner();
    for (const baseUrl of [
      "http://10.0.0.9:8000",
      "https://paperless.example.org",
      "http://paperless.lan:8001",
    ]) {
      const res = await save({ baseUrl, token: TOKEN });
      expect(res.status, baseUrl).toBe(422);
      expect((await res.json()).meta.errorCode).toBe(
        "documents.sources.originNotAllowed",
      );
    }
    expect(fake.calls).toHaveLength(0);
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });

  it("refuses a token the source rejects and stores nothing", async () => {
    await seedOwner();
    fake.acceptToken = "the-real-one";
    const res = await save({ baseUrl: ORIGIN, token: TOKEN });
    expect(res.status).toBe(502);
    expect((await res.json()).meta).toMatchObject({
      errorCode: "documents.sources.authRefused",
      upstreamStatus: 401,
    });
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });

  it("stores the token encrypted and never returns it", async () => {
    await seedOwner();
    const saved = await connect();
    const savedText = await saved.text();
    expect(savedText).not.toContain(TOKEN);
    expect(JSON.parse(savedText).data).toMatchObject({
      system: "PAPERLESS",
      baseUrl: ORIGIN,
      hasToken: true,
      originAllowed: true,
    });

    const row =
      await getPrismaClient().documentSourceConnection.findFirstOrThrow();
    expect(row.userId).toBe(userId);
    expect(row.tokenEncrypted).not.toContain(TOKEN);
    expect(decrypt(row.tokenEncrypted)).toBe(TOKEN);

    const read = await (await status()).text();
    expect(read).not.toContain(TOKEN);
    expect(JSON.parse(read).data.allowedOrigins).toEqual([ORIGIN, ORIGIN_B]);

    // A save without a token keeps the stored one.
    const again = await save({ baseUrl: ORIGIN });
    expect(again.status).toBe(200);
    const kept =
      await getPrismaClient().documentSourceConnection.findFirstOrThrow();
    expect(decrypt(kept.tokenEncrypted)).toBe(TOKEN);

    expect((await disconnect()).status).toBe(200);
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });
});

describe("only the owner's browser session", () => {
  it("refuses a wildcard Bearer token", async () => {
    await seedOwner();
    await connect();
    const raw = "hlk_document-sources-wildcard-token-000";
    await getPrismaClient().apiToken.create({
      data: {
        userId,
        name: "native",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });
    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${raw}`);
    fake.calls.length = 0;
    for (const res of [
      await status(),
      await search("q=blood"),
      await importDoc({ sourceId: "41" }),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).meta.errorCode).toBe(
        "documents.sources.browserOnly",
      );
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a delegate acting on the owner's record", async () => {
    await seedOwner();
    await connect();
    const delegate = await makeUser("delegate");
    const invited = await inviteGrant({
      grantorId: userId,
      granteeId: delegate.id,
      access: "WRITE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    const switched = await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: userId },
    });
    asCookie(session.id);
    headerJar.set("x-healthlog-record-epoch", String(switched.recordEpoch));
    headerJar.set("x-healthlog-record-scope", userId);
    fake.calls.length = 0;

    for (const res of [
      await status(),
      await search("q=blood"),
      await importDoc({ sourceId: "41" }),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(fake.calls).toHaveLength(0);
    expect(await getPrismaClient().inboundDocument.count()).toBe(0);
  });
});

describe("search and import", () => {
  it("imports through the ingest path; a re-import is a duplicate and a deleted one stays deleted", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();

    const first = await search("q=blood");
    expect(first.status).toBe(200);
    expect((await first.json()).data).toEqual({
      page: 1,
      hasMore: false,
      results: [
        {
          sourceId: "41",
          title: "Blood test",
          date: "2024-03-04",
          tags: ["Health"],
          sizeBytes: null,
          state: "new",
          documentId: null,
        },
      ],
    });

    const imported = await importDoc({ sourceId: "41" });
    expect(imported.status).toBe(201);
    const receipt = (await imported.json()).data;
    expect(receipt).toMatchObject({ outcome: "imported", linked: false });
    const stored = await prisma.inboundDocument.findUniqueOrThrow({
      where: { id: receipt.documentId },
      omit: { contentEncrypted: true },
    });
    expect(stored).toMatchObject({
      userId,
      title: "Blood test",
      filename: "blood.pdf",
      sourceSystem: "PAPERLESS",
      sourceId: "41",
      mimeType: "application/pdf",
      aiReadDeferred: false,
      kind: "OTHER",
    });
    expect(stored.documentDate?.toISOString().slice(0, 10)).toBe("2024-03-04");
    expect(downloads()).toBe(1);

    const listed = (await (await search("q=blood")).json()).data.results[0];
    expect(listed).toMatchObject({
      state: "imported",
      documentId: receipt.documentId,
    });

    const again = await importDoc({ sourceId: "41" });
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({
      outcome: "duplicate",
      documentId: receipt.documentId,
      linked: false,
    });
    expect(downloads()).toBe(1);

    await prisma.inboundDocument.update({
      where: { id: receipt.documentId },
      data: { deletedAt: new Date() },
    });
    // Deleted but still in Recently deleted: the search names the document.
    expect(
      (await (await search("q=blood")).json()).data.results[0],
    ).toMatchObject({ state: "deleted", documentId: receipt.documentId });
    const revived = await importDoc({ sourceId: "41" });
    expect(revived.status).toBe(200);
    expect((await revived.json()).data.outcome).toBe("deleted");
    expect(downloads()).toBe(1);
    expect(await prisma.inboundDocument.count()).toBe(1);
  });

  it("brings a deleted document back only when asked: restored from Recently deleted, or imported again after the purge", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();

    const first = await importDoc({ sourceId: "41" });
    const id = (await first.json()).data.documentId as string;
    await prisma.inboundDocument.update({
      where: { id },
      data: { deletedAt: new Date(), status: "DISCARDED" },
    });

    // Still in Recently deleted: `revive` restores the same document, and
    // nothing is downloaded.
    const restored = await importDoc({ sourceId: "41", revive: true });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data).toEqual({
      outcome: "restored",
      documentId: id,
      linked: false,
    });
    expect(downloads()).toBe(1);
    expect(
      (await prisma.inboundDocument.findUniqueOrThrow({ where: { id } }))
        .deletedAt,
    ).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { userId, action: "documents.inbound.restore" },
      }),
    ).toBe(1);

    // Deleted again and purged: the key is in the ledger, and an import that
    // does not ask is still answered "deleted".
    await prisma.inboundDocument.update({
      where: { id },
      data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    const { purgeExpiredDocumentTombstones } =
      await import("@/lib/jobs/document-purge");
    expect(await purgeExpiredDocumentTombstones(prisma as never)).toBe(1);
    expect(
      (await (await search("q=blood")).json()).data.results[0],
    ).toMatchObject({ state: "deleted", documentId: null });
    const left = await importDoc({ sourceId: "41" });
    expect((await left.json()).data).toEqual({
      outcome: "deleted",
      documentId: null,
      linked: false,
    });
    expect(downloads()).toBe(1);

    // Asked: fetched and stored again, and the ledger forgets the key.
    const again = await importDoc({ sourceId: "41", revive: true });
    expect(again.status).toBe(201);
    const back = (await again.json()).data;
    expect(back).toMatchObject({ outcome: "imported", linked: false });
    expect(back.documentId).not.toBe(id);
    expect(downloads()).toBe(2);
    expect(await prisma.documentImportKey.count({ where: { userId } })).toBe(0);
    expect(
      (await (await search("q=blood")).json()).data.results[0],
    ).toMatchObject({ state: "imported", documentId: back.documentId });
  });

  it("keeps the deletion when a revived import cannot fetch the file", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();
    await prisma.documentImportKey.create({
      data: {
        userId,
        sourceSystem: "PAPERLESS",
        sourceId: "42",
        sourceInstance: ORIGIN,
      },
    });
    fake.downloadStatus = 500;
    const failed = await importDoc({ sourceId: "42", revive: true });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.documentImportKey.count({ where: { userId } })).toBe(1);
    expect(await prisma.inboundDocument.count()).toBe(0);
  });

  it("answers a file already uploaded by hand as a duplicate and remembers the key", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();

    // The same bytes, uploaded through the vault without a source key.
    const form = new FormData();
    form.append(
      "file",
      new Blob([
        new Uint8Array(
          Buffer.concat([DOCS[1].bytes, Buffer.from(`% ${ORIGIN}\n`)]),
        ),
      ]),
      "x.pdf",
    );
    const { POST } = await import("@/app/api/documents/inbound/route");
    const uploaded = await (
      POST as unknown as (r: Request) => Promise<Response>
    )(
      new Request("http://localhost/api/documents/inbound", {
        method: "POST",
        body: form,
      }),
    );
    expect(uploaded.status).toBe(201);
    const uploadedId = (await uploaded.json()).data.id;

    const picked = await importDoc({ sourceId: "42" });
    expect(picked.status).toBe(200);
    expect((await picked.json()).data).toMatchObject({
      outcome: "duplicate",
      documentId: uploadedId,
    });
    expect(await prisma.inboundDocument.count()).toBe(1);
    expect(
      await prisma.documentSourceAlias.count({
        where: {
          documentId: uploadedId,
          sourceSystem: "PAPERLESS",
          sourceInstance: ORIGIN,
          sourceId: "42",
        },
      }),
    ).toBe(1);
  });

  it("links to the visit it was picked for, and refuses someone else's before fetching", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();
    const visit = await prisma.encounter.create({
      data: { userId, occurredAt: new Date("2024-03-04T10:00:00Z") },
    });
    const stranger = await makeUser("stranger");
    const foreign = await prisma.encounter.create({
      data: { userId: stranger.id, occurredAt: new Date() },
    });

    const refused = await importDoc({
      sourceId: "41",
      link: { kind: "encounter", id: foreign.id },
    });
    expect(refused.status).toBe(404);
    expect((await refused.json()).meta.errorCode).toBe(
      "documents.sources.linkTargetNotFound",
    );
    expect(downloads()).toBe(0);

    const linked = await importDoc({
      sourceId: "41",
      link: { kind: "encounter", id: visit.id },
    });
    expect(linked.status).toBe(201);
    const data = (await linked.json()).data;
    expect(data.linked).toBe(true);
    expect(
      await prisma.encounterDocumentLink.count({
        where: { encounterId: visit.id, documentId: data.documentId },
      }),
    ).toBe(1);
  });

  it("cuts a stored connection off once the operator removes its origin", async () => {
    await seedOwner();
    await connect();
    fake.calls.length = 0;
    process.env.DOCUMENT_SOURCE_ORIGINS = "https://other.example.com";

    const res = await search("q=blood");
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toBe(
      "documents.sources.originNotAllowed",
    );
    const imported = await importDoc({ sourceId: "41" });
    expect(imported.status).toBe(422);
    expect(fake.calls).toHaveLength(0);

    const read = (await (await status()).json()).data;
    expect(read.connections[0]).toMatchObject({ originAllowed: false });
    // Still removable.
    expect((await disconnect()).status).toBe(200);
  });
});

describe("review follow-ups", () => {
  it("keeps a document deleted in HealthLog deleted when the same bytes arrive under another source key", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();
    const first = await importDoc({ sourceId: "41" });
    const id = (await first.json()).data.documentId as string;
    await prisma.inboundDocument.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // The same file, uploaded by another importer under its own key (a
    // document token or the script sending from another system).
    const form = new FormData();
    form.append(
      "file",
      new Blob([
        new Uint8Array(
          Buffer.concat([DOCS[0].bytes, Buffer.from(`% ${ORIGIN}\n`)]),
        ),
      ]),
      "x.pdf",
    );
    form.append("sourceSystem", "PAPRA");
    form.append("sourceId", "doc_same_bytes");
    const { POST } = await import("@/app/api/documents/inbound/route");
    const res = await (POST as unknown as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/documents/inbound", {
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ deleted: true });
    expect(await prisma.inboundDocument.count()).toBe(1);
    // The new key is remembered on the deleted document, so the purge
    // carries it into the ledger.
    expect(
      await prisma.documentSourceAlias.count({
        where: { documentId: id, sourceId: "doc_same_bytes" },
      }),
    ).toBe(1);

    // A person uploading the same file by hand, without a key, is a
    // deliberate new copy and is stored.
    const manual = new FormData();
    manual.append(
      "file",
      new Blob([
        new Uint8Array(
          Buffer.concat([DOCS[0].bytes, Buffer.from(`% ${ORIGIN}\n`)]),
        ),
      ]),
      "x.pdf",
    );
    const byHand = await (POST as unknown as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/documents/inbound", {
        method: "POST",
        body: manual,
      }),
    );
    expect(byHand.status).toBe(201);
  });

  it("never sends the stored token to a new origin", async () => {
    await seedOwner();
    await connect();
    fake.calls.length = 0;
    const moved = await save({ baseUrl: ORIGIN_B });
    expect(moved.status).toBe(422);
    expect((await moved.json()).meta.errorCode).toBe(
      "documents.sources.tokenRequired",
    );
    expect(fake.calls).toHaveLength(0);
    // A new path on the same origin keeps the token.
    const samePlace = await save({ baseUrl: `${ORIGIN}/` });
    expect(samePlace.status).toBe(200);
    expect(fake.calls.every((c) => c.url.startsWith(ORIGIN))).toBe(true);
  });

  it("keeps the same id on two instances apart, and lets a key without an instance match any", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();

    const first = await importDoc({ sourceId: "41" });
    expect(first.status).toBe(201);
    const a = (await first.json()).data.documentId as string;
    expect(
      (await prisma.inboundDocument.findUniqueOrThrow({ where: { id: a } }))
        .sourceInstance,
    ).toBe(ORIGIN);

    // Switch the connection to the other Paperless-ngx.
    expect((await save({ baseUrl: ORIGIN_B, token: TOKEN })).status).toBe(200);
    const listed = (await (await search("q=blood")).json()).data.results[0];
    expect(listed).toMatchObject({ sourceId: "41", state: "new" });
    const second = await importDoc({ sourceId: "41" });
    expect(second.status).toBe(201);
    const b = (await second.json()).data.documentId as string;
    expect(b).not.toBe(a);
    expect(
      (await prisma.inboundDocument.findUniqueOrThrow({ where: { id: b } }))
        .sourceInstance,
    ).toBe(ORIGIN_B);

    // A v1.39.2 import of #42 carries no instance: it answers for any
    // instance of its system, so the picker neither re-imports it nor
    // forgets a deletion of it.
    await prisma.inboundDocument.create({
      data: {
        userId,
        kind: "OTHER",
        mimeType: "application/pdf",
        byteSize: 1,
        contentEncrypted: Buffer.from("x"),
        contentSha256: "legacy-sha",
        status: "STORED",
        sourceSystem: "PAPERLESS",
        sourceId: "42",
        deletedAt: new Date(),
      },
    });
    const legacy = (await (await search("q=discharge")).json()).data.results[0];
    expect(legacy).toMatchObject({ sourceId: "42", state: "deleted" });
    const refused = await importDoc({ sourceId: "42" });
    expect((await refused.json()).data.outcome).toBe("deleted");
  });

  it("refuses an id that could leave the document path, before dialling", async () => {
    await seedOwner();
    await connect();
    fake.calls.length = 0;
    for (const sourceId of ["..", ".", "41/../../admin", "abc", "41?x=1"]) {
      const res = await importDoc({ sourceId });
      expect(res.status, sourceId).toBe(422);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("downloads a key once when two imports of it overlap", async () => {
    await seedOwner();
    await connect();
    fake.downloadDelayMs = 300;
    const [one, two] = await Promise.all([
      importDoc({ sourceId: "41" }),
      importDoc({ sourceId: "41" }),
    ]);
    const outcomes = [
      (await one.json()).data.outcome,
      (await two.json()).data.outcome,
    ].sort();
    expect(outcomes).toEqual(["duplicate", "imported"]);
    expect(downloads()).toBe(1);
    expect(await getPrismaClient().inboundDocument.count()).toBe(1);
  });

  it("does not charge the upload allowance for a fetch that failed", async () => {
    await seedOwner();
    await connect();
    fake.downloadStatus = 500;
    const res = await importDoc({ sourceId: "41" });
    expect(res.status).toBe(502);
    expect(
      await getPrismaClient().rateLimit.count({
        where: { key: `documents-upload:${userId}` },
      }),
    ).toBe(0);
  });

  it("reads past a page the local re-check emptied", async () => {
    await seedOwner();
    await connect();
    const res = await search("tag=99");
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.page).toBe(2);
    expect(data.results.map((r: { sourceId: string }) => r.sourceId)).toEqual([
      "41",
    ]);
  });

  it("shows and deletes a connection with the module off and the list gone", async () => {
    await seedOwner();
    await connect();
    delete process.env.DOCUMENT_SOURCE_ORIGINS;
    await getPrismaClient().user.update({
      where: { id: userId },
      data: { modulePreferencesJson: { inboundDocuments: false } },
    });
    const read = (await (await status()).json()).data;
    expect(read.available).toBe(false);
    expect(read.connections).toHaveLength(1);
    expect(read.connections[0].originAllowed).toBe(false);
    expect((await disconnect()).status).toBe(200);
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });
});
