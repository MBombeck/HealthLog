/**
 * Document vault P2 — content-search index end-to-end against a real Postgres.
 *
 * Pins what the unit mocks cannot:
 *   1. Migration 0228 applied clean (the table + GIN index exist) — implied by
 *      any successful upsert/search below.
 *   2. The TEXT-mode index route persists ONLY ciphertext + opaque HMAC tokens
 *      (A4): the stored `text_encrypted` never contains the plaintext body and
 *      `search_tokens` are 16-char hex tags, not words.
 *   3. Content search: a whole word that appears ONLY in the body (not the
 *      title/filename) finds the document through the GIN array-overlap union;
 *      a word that appears nowhere does not; the list still omits the blob.
 *   4. `hasContentIndex` + the usage `contentIndex` gauge reflect the index.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

async function seedVaultUser(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { inboundDocuments: true },
      // TEXT-mode indexing rides the existing local-OCR opt-in (no provider).
      labsLocalOcrEnabled: true,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

function uploadRequest(
  bytes: Buffer,
  filename: string,
  title?: string,
): Request {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const formData = new FormData();
  formData.append("file", new Blob([payload]), filename);
  if (title) formData.append("title", title);
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: formData,
  });
}

type RouteCtx = { params: Promise<{ id: string }> };
const ctx = (id: string): RouteCtx => ({ params: Promise.resolve({ id }) });

async function routes() {
  const list = await import("@/app/api/documents/inbound/route");
  const byId = await import("@/app/api/documents/inbound/[id]/route");
  const index = await import("@/app/api/documents/inbound/[id]/index/route");
  const usage = await import("@/app/api/documents/inbound/usage/route");
  return {
    post: list.POST as unknown as (r: Request) => Promise<Response>,
    get: list.GET as unknown as (r: Request) => Promise<Response>,
    getById: byId.GET as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    patchById: byId.PATCH as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    postIndex: index.POST as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    getUsage: usage.GET as unknown as (r: Request) => Promise<Response>,
  };
}

function textIndexRequest(id: string, text: string): Request {
  return new Request(`http://localhost/api/documents/inbound/${id}/index`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "text", text }),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("document vault — content index (text mode)", () => {
  it("persists only ciphertext + opaque tokens and finds a body-only word", async () => {
    await seedVaultUser("vault-index");
    const { post, get, getById, postIndex, getUsage } = await routes();

    // Title/filename deliberately share NO word with the indexed body.
    const up = await post(uploadRequest(PNG_1X1, "scan.png", "Arztbrief"));
    expect(up.status).toBe(201);
    const { data: doc } = await up.json();

    const bodyWord = "leukozyten";
    const idx = await postIndex(
      textIndexRequest(
        doc.id,
        `Befund: ${bodyWord} erhoeht, Kontrolle empfohlen`,
      ),
      ctx(doc.id),
    );
    expect(idx.status).toBe(200);
    const idxBody = await idx.json();
    expect(idxBody.data.indexed).toBe(true);
    expect(idxBody.data.tokenCount).toBeGreaterThan(0);

    // A4 — at rest: ciphertext text (never the plaintext body) + opaque tags.
    const row = await getPrismaClient().documentContentIndex.findFirstOrThrow();
    expect(row.source).toBe("text-ocr");
    expect(Buffer.from(row.textEncrypted).toString("utf8")).not.toContain(
      bodyWord,
    );
    expect(row.searchTokens.length).toBeGreaterThan(0);
    for (const token of row.searchTokens) {
      expect(token).toMatch(/^[0-9a-f]{16}$/);
      expect(token).not.toContain(bodyWord);
    }

    // Content search: the body-only word finds the document …
    const hit = await get(
      new Request(`http://localhost/api/documents/inbound?q=${bodyWord}`),
    );
    expect(hit.status).toBe(200);
    const hitBody = await hit.json();
    expect(hitBody.data.documents.map((d: { id: string }) => d.id)).toContain(
      doc.id,
    );
    // … the list still never leaks the blob …
    expect("contentEncrypted" in hitBody.data.documents[0]).toBe(false);
    expect(hitBody.data.documents[0].hasContentIndex).toBe(true);

    // … and a word that appears nowhere does not.
    const miss = await get(
      new Request("http://localhost/api/documents/inbound?q=zznonexistentzz"),
    );
    const missBody = await miss.json();
    expect(missBody.data.documents).toHaveLength(0);

    // Detail + usage reflect the index.
    const detail = await getById(
      new Request(`http://localhost/api/documents/inbound/${doc.id}`),
      ctx(doc.id),
    );
    expect((await detail.json()).data.hasContentIndex).toBe(true);

    const usage = await getUsage(
      new Request("http://localhost/api/documents/inbound/usage"),
    );
    const usageBody = await usage.json();
    expect(usageBody.data.contentIndex).toMatchObject({
      indexedCount: 1,
      totalCount: 1,
    });
  });

  it("threads contentIndexSource through list + detail and preserves it across a metadata PATCH", async () => {
    await seedVaultUser("vault-provenance");
    const { post, get, getById, patchById, postIndex } = await routes();

    const up = await post(uploadRequest(PNG_1X1, "scan.png", "Vorher"));
    const { data: doc } = await up.json();

    await postIndex(
      textIndexRequest(doc.id, "kreatinin natrium kalium werte"),
      ctx(doc.id),
    );

    // List surfaces the real provenance (text-ocr here — no provider).
    const listed = await get(
      new Request("http://localhost/api/documents/inbound"),
    );
    const listRow = (await listed.json()).data.documents.find(
      (d: { id: string }) => d.id === doc.id,
    );
    expect(listRow.hasContentIndex).toBe(true);
    expect(listRow.contentIndexSource).toBe("text-ocr");

    // Detail agrees.
    const detail = await getById(
      new Request(`http://localhost/api/documents/inbound/${doc.id}`),
      ctx(doc.id),
    );
    expect((await detail.json()).data.contentIndexSource).toBe("text-ocr");

    // Regression (the UI wave flagged this): a metadata PATCH must return the
    // index provenance from the freshly-read index row, not a stale null.
    const patched = await patchById(
      new Request(`http://localhost/api/documents/inbound/${doc.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Nachher" }),
      }),
      ctx(doc.id),
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()).data;
    expect(patchedBody.title).toBe("Nachher");
    expect(patchedBody.hasContentIndex).toBe(true);
    expect(patchedBody.contentIndexSource).toBe("text-ocr");
  });

  it("re-indexing the same document is idempotent (upsert in place)", async () => {
    await seedVaultUser("vault-reindex");
    const { post, postIndex } = await routes();

    const up = await post(uploadRequest(PNG_1X1, "scan.png"));
    const { data: doc } = await up.json();

    await postIndex(
      textIndexRequest(doc.id, "erste fassung glukose"),
      ctx(doc.id),
    );
    await postIndex(
      textIndexRequest(doc.id, "zweite fassung cholesterin"),
      ctx(doc.id),
    );

    const rows = await getPrismaClient().documentContentIndex.findMany({
      where: { documentId: doc.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("422s TEXT mode when local OCR is not enabled", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "vault-no-ocr",
        email: "vault-no-ocr@example.test",
        role: "USER",
        timezone: "Europe/Berlin",
        modulePreferencesJson: { inboundDocuments: true },
        labsLocalOcrEnabled: false,
      },
    });
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { post, postIndex } = await routes();
    const up = await post(uploadRequest(PNG_1X1, "scan.png"));
    const { data: doc } = await up.json();

    const idx = await postIndex(
      textIndexRequest(doc.id, "irgendein text"),
      ctx(doc.id),
    );
    expect(idx.status).toBe(422);
    const body = await idx.json();
    expect(body.meta?.errorCode).toBe("documents.inbound.localOcrDisabled");
  });
});
