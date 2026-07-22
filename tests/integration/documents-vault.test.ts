/**
 * Document vault — end-to-end contract against a real Postgres.
 *
 * Covers the Wave-1 hardenings the unit mocks cannot pin:
 *
 *   1. Upload → binary2-encrypted row + plaintext sha256; /original
 *      round-trips the exact bytes with the class-correct headers.
 *   2. Policy error contract: 413 fileTooLarge / quotaExceeded (with limits
 *      in meta), 415 unsupportedType.
 *   3. sha256 dedupe: a same-user re-upload returns 200 + meta.duplicate and
 *      the existing row id; the partial unique index holds at the DB level.
 *   4. Idempotency-Key replay returns the cached response without a second
 *      row.
 *   5. Quota accounting is tombstone-inclusive (a soft-deleted row still
 *      counts against usage until purged).
 *   6. episodeIds pre-link + PATCH replace-set + list filters (kind[],
 *      episodeId, year) — and the list never leaks the blob.
 *   7. Restore: clears the tombstone; 409 after purge; 409 on a live
 *      duplicate of the same bytes.
 *   8. Bulk endpoint per-id semantics.
 *   9. Usage endpoint reflects overrides + tombstone-inclusive usage.
 *  10. The purge job hard-deletes only past-grace tombstones.
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
const PDF_SMALL = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

async function seedVaultUser(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      // Opt-in module: the vault is dark until the user flips it on.
      modulePreferencesJson: { inboundDocuments: true },
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
  fields: Record<string, string | string[]> = {},
  headers: Record<string, string> = {},
): Request {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const formData = new FormData();
  formData.append("file", new Blob([payload]), filename);
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) formData.append(k, item);
  }
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: formData,
    headers,
  });
}

type RouteCtx = { params: Promise<{ id: string }> };
const ctx = (id: string): RouteCtx => ({ params: Promise.resolve({ id }) });

async function routes() {
  const list = await import("@/app/api/documents/inbound/route");
  const byId = await import("@/app/api/documents/inbound/[id]/route");
  const original =
    await import("@/app/api/documents/inbound/[id]/original/route");
  const restore =
    await import("@/app/api/documents/inbound/[id]/restore/route");
  const bulk = await import("@/app/api/documents/inbound/bulk/route");
  const usage = await import("@/app/api/documents/inbound/usage/route");
  return {
    post: list.POST as unknown as (r: Request) => Promise<Response>,
    get: list.GET as unknown as (r: Request) => Promise<Response>,
    patch: byId.PATCH as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    del: byId.DELETE as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    getOriginal: original.GET as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    postRestore: restore.POST as unknown as (
      r: Request,
      c: RouteCtx,
    ) => Promise<Response>,
    postBulk: bulk.POST as unknown as (r: Request) => Promise<Response>,
    getUsage: usage.GET as unknown as (r: Request) => Promise<Response>,
  };
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("document vault — upload + serve round-trip", () => {
  it("stores binary2-encrypted with sha256 and serves the exact bytes back", async () => {
    await seedVaultUser("vault-roundtrip");
    const { post, getOriginal } = await routes();

    const res = await post(
      uploadRequest(PNG_1X1, "scan.png", { title: "Röntgen Knie" }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.servingClass).toBe("inline");

    // At rest: binary2 codec, plaintext sha256, ciphertext ≠ plaintext.
    const row = await getPrismaClient().inboundDocument.findFirstOrThrow();
    expect(row.contentCodec).toBe("binary2");
    expect(row.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(row.contentEncrypted).equals(PNG_1X1)).toBe(false);

    // Round-trip through the serve route: exact bytes + Class A posture.
    const orig = await getOriginal(
      new Request(`http://localhost/api/documents/inbound/${data.id}/original`),
      ctx(data.id),
    );
    expect(orig.status).toBe(200);
    expect(orig.headers.get("Content-Type")).toBe("image/png");
    expect(orig.headers.get("Content-Disposition")).toContain("inline");
    expect(orig.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // The response CSP is owned by the proxy's serve-route carve-out
    // (`default-src 'none'; frame-ancestors 'self'` — middleware headers win
    // over route headers), so the route itself sets none. Pinned by
    // `src/__tests__/proxy-document-serve-framing.test.ts`.
    expect(orig.headers.get("Content-Security-Policy")).toBeNull();
    const served = Buffer.from(await orig.arrayBuffer());
    expect(served.equals(PNG_1X1)).toBe(true);
  });

  it("serves a Class B upload attachment-only as octet-stream", async () => {
    await seedVaultUser("vault-classb");
    const { post, getOriginal } = await routes();

    const res = await post(
      uploadRequest(Buffer.from("Blutdruck 120/80 morgens\n"), "werte.csv"),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.mimeType).toBe("text/csv");
    expect(data.servingClass).toBe("attachment");

    const orig = await getOriginal(
      new Request(`http://localhost/api/documents/inbound/${data.id}/original`),
      ctx(data.id),
    );
    expect(orig.status).toBe(200);
    expect(orig.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(
      (orig.headers.get("Content-Disposition") ?? "").startsWith("attachment;"),
    ).toBe(true);
    expect(orig.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("document vault — policy error contract", () => {
  it("415s an unsupported type with meta.reason", async () => {
    await seedVaultUser("vault-415");
    const { post } = await routes();
    const res = await post(
      uploadRequest(Buffer.from([0x01, 0x02, 0x03, 0x04]), "blob.bin"),
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.meta.reason).toBe("unsupportedType");
  });

  it("413s over the admin-set per-file cap with the limit in meta", async () => {
    await seedVaultUser("vault-cap");
    await getPrismaClient().appSettings.upsert({
      where: { id: "singleton" },
      update: { documentMaxFileBytes: 20 },
      create: { id: "singleton", documentMaxFileBytes: 20 },
    });
    const { post } = await routes();
    const res = await post(uploadRequest(PNG_1X1, "big.png"));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.meta.reason).toBe("fileTooLarge");
    expect(body.meta.maxFileBytes).toBe(20);
    expect(await getPrismaClient().inboundDocument.count()).toBe(0);
  });

  it("413s past the quota — and tombstoned rows still count against it", async () => {
    const user = await seedVaultUser("vault-quota");
    // Quota fits exactly one PNG (70 B) but not two.
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { documentQuotaBytes: BigInt(PNG_1X1.byteLength + 10) },
    });
    const { post, del } = await routes();

    const first = await post(uploadRequest(PNG_1X1, "one.png"));
    expect(first.status).toBe(201);
    const firstId = (await first.json()).data.id as string;

    // Soft-delete the first upload: the tombstone KEEPS holding quota.
    const delRes = await del(
      new Request(`http://localhost/api/documents/inbound/${firstId}`, {
        method: "DELETE",
      }),
      ctx(firstId),
    );
    expect(delRes.status).toBe(200);

    const second = await post(uploadRequest(PDF_SMALL, "two.pdf"));
    expect(second.status).toBe(413);
    const body = await second.json();
    expect(body.meta.reason).toBe("quotaExceeded");
    expect(body.meta.usedBytes).toBe(PNG_1X1.byteLength);
    expect(body.meta.quotaBytes).toBe(PNG_1X1.byteLength + 10);
  });

  it("cannot be overshot by concurrent uploads racing the quota gate", async () => {
    // The production admission gate allows two same-user uploads in flight,
    // so seed one file, then race two DISTINCT files for the one remaining
    // quota slot. Without the per-user advisory lock both contenders read the
    // same pre-insert SUM and land, overshooting the quota.
    const user = await seedVaultUser("vault-quota-race");
    const files = Array.from({ length: 4 }, (_, i) => {
      const filler = Buffer.alloc(2048, i + 1);
      return Buffer.concat([Buffer.from("%PDF-1.7\n"), filler]);
    });
    const size = files[0].byteLength;
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { documentQuotaBytes: BigInt(size * 2 + 10) },
    });
    const { post } = await routes();

    const first = await post(uploadRequest(files[0], "race-0.pdf"));
    const contenders = await Promise.all(
      files
        .slice(1, 3)
        .map((bytes, i) => post(uploadRequest(bytes, `race-${i + 1}.pdf`))),
    );
    const last = await post(uploadRequest(files[3], "race-3.pdf"));
    const results = [first, ...contenders, last];
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 413, 413]);
    const bodies = await Promise.all(results.map((result) => result.json()));
    expect(
      bodies
        .filter((_, index) => results[index].status === 413)
        .map((body) => body.meta.reason),
    ).toEqual(["quotaExceeded", "quotaExceeded"]);

    const rows = await getPrismaClient().inboundDocument.findMany({
      where: { userId: user.id },
      select: { byteSize: true },
    });
    const stored = rows.reduce((sum, r) => sum + r.byteSize, 0);
    expect(stored).toBeLessThanOrEqual(size * 2 + 10);
  });
});

describe("document vault — dedupe + idempotency", () => {
  it("returns the existing live row + meta.duplicate on a same-bytes re-upload", async () => {
    await seedVaultUser("vault-dedupe");
    const { post } = await routes();

    const first = await post(uploadRequest(PNG_1X1, "scan.png"));
    expect(first.status).toBe(201);
    const firstId = (await first.json()).data.id as string;

    const second = await post(uploadRequest(PNG_1X1, "scan-copy.png"));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.meta.duplicate).toBe(true);
    expect(body.data.id).toBe(firstId);
    expect(await getPrismaClient().inboundDocument.count()).toBe(1);
  });

  it("collapses two racing identical uploads onto one row", async () => {
    // Same bytes fired twice in parallel: the fast-path dedupe check misses
    // (neither row exists yet), so the partial unique index must close the
    // race — one 201, one 200 + meta.duplicate pointing at the winner.
    await seedVaultUser("vault-dedupe-race");
    const { post } = await routes();

    const [a, b] = await Promise.all([
      post(uploadRequest(PNG_1X1, "race-a.png")),
      post(uploadRequest(PNG_1X1, "race-b.png")),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    const bodies = await Promise.all([a.json(), b.json()]);
    const winner = bodies.find((x) => x.meta?.duplicate !== true);
    const loser = bodies.find((x) => x.meta?.duplicate === true);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(loser!.data.id).toBe(winner!.data.id);
    expect(await getPrismaClient().inboundDocument.count()).toBe(1);
  });

  it("dedupes per user, not globally", async () => {
    await seedVaultUser("vault-user-a");
    const { post } = await routes();
    expect((await post(uploadRequest(PNG_1X1, "a.png"))).status).toBe(201);

    cookieJar.clear();
    await seedVaultUser("vault-user-b");
    expect((await post(uploadRequest(PNG_1X1, "b.png"))).status).toBe(201);
    expect(await getPrismaClient().inboundDocument.count()).toBe(2);
  });

  it("replays an Idempotency-Key without creating a second row", async () => {
    await seedVaultUser("vault-idem");
    const { post } = await routes();
    const key = "vault-upload-abc123";

    const first = await post(
      uploadRequest(PDF_SMALL, "brief.pdf", {}, { "Idempotency-Key": key }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await post(
      uploadRequest(PDF_SMALL, "brief.pdf", {}, { "Idempotency-Key": key }),
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    const replayBody = await replay.json();
    expect(replayBody.data.id).toBe(firstBody.data.id);
    expect(await getPrismaClient().inboundDocument.count()).toBe(1);
  });
});

describe("document vault — links + list filters", () => {
  it("pre-links at upload, replace-sets via PATCH, filters by kind/episode/year", async () => {
    const user = await seedVaultUser("vault-links");
    const prisma = getPrismaClient();
    const knie = await prisma.illnessEpisode.create({
      data: {
        userId: user.id,
        label: "Knie",
        type: "OTHER",
        onsetAt: new Date("2025-09-01T00:00:00.000Z"),
      },
    });
    const ruecken = await prisma.illnessEpisode.create({
      data: {
        userId: user.id,
        label: "Rücken",
        type: "OTHER",
        onsetAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    });
    const { post, get, patch } = await routes();

    const created = await post(
      uploadRequest(PDF_SMALL, "mrt-knie.pdf", {
        title: "MRT Knie",
        kind: "IMAGING",
        documentDate: "2025-10-04",
        episodeIds: [knie.id],
      }),
    );
    expect(created.status).toBe(201);
    const doc = (await created.json()).data;
    expect(doc.conditionLinks).toEqual([{ episodeId: knie.id, name: "Knie" }]);

    // Second (unlinked, different year) document for filter contrast.
    const other = await post(
      uploadRequest(PNG_1X1, "impfpass.png", {
        kind: "VACCINATION",
        documentDate: "2024-03-01",
      }),
    );
    expect(other.status).toBe(201);

    // kind[] facet (OR inside), episode filter, year filter — AND across.
    const filtered = await get(
      new Request(
        `http://localhost/api/documents/inbound?kind=IMAGING,LAB_RESULT&episodeId=${knie.id}&year=2025`,
      ),
    );
    expect(filtered.status).toBe(200);
    const page = (await filtered.json()).data;
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0].title).toBe("MRT Knie");
    // The list DTO never carries blob material.
    expect("contentEncrypted" in page.documents[0]).toBe(false);

    // Year filter alone excludes the 2025 document.
    const y2024 = await get(
      new Request("http://localhost/api/documents/inbound?year=2024"),
    );
    expect((await y2024.json()).data.documents).toHaveLength(1);
    expect(
      (
        await (
          await get(new Request("http://localhost/api/documents/inbound"))
        ).json()
      ).data.documents,
    ).toHaveLength(2);

    // PATCH replace-set: Knie → Rücken (relink), then [] (unlink-all).
    const relinked = await patch(
      jsonRequest(`http://localhost/api/documents/inbound/${doc.id}`, "PATCH", {
        episodeIds: [ruecken.id],
      }),
      ctx(doc.id),
    );
    expect(relinked.status).toBe(200);
    expect((await relinked.json()).data.conditionLinks).toEqual([
      { episodeId: ruecken.id, name: "Rücken" },
    ]);

    const unlinked = await patch(
      jsonRequest(`http://localhost/api/documents/inbound/${doc.id}`, "PATCH", {
        episodeIds: [],
      }),
      ctx(doc.id),
    );
    expect((await unlinked.json()).data.conditionLinks).toEqual([]);

    // Foreign episode id → 404-shaped refusal.
    cookieJar.clear();
    const stranger = await seedVaultUser("vault-links-stranger");
    void stranger;
    const foreign = await patch(
      jsonRequest(`http://localhost/api/documents/inbound/${doc.id}`, "PATCH", {
        episodeIds: [knie.id],
      }),
      ctx(doc.id),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("document vault — delete / restore / purge", () => {
  it("restore clears the tombstone; purge-then-restore 409s; duplicate restore 409s", async () => {
    await seedVaultUser("vault-restore");
    const prisma = getPrismaClient();
    const { post, del, postRestore } = await routes();

    const created = await post(uploadRequest(PNG_1X1, "scan.png"));
    const docId = (await created.json()).data.id as string;

    await del(
      new Request(`http://localhost/api/documents/inbound/${docId}`, {
        method: "DELETE",
      }),
      ctx(docId),
    );
    expect(
      (await prisma.inboundDocument.findFirstOrThrow()).deletedAt,
    ).not.toBeNull();

    // Restore inside the grace window succeeds and the row is live again.
    const restored = await postRestore(
      new Request(`http://localhost/api/documents/inbound/${docId}/restore`, {
        method: "POST",
      }),
      ctx(docId),
    );
    expect(restored.status).toBe(200);
    const row = await prisma.inboundDocument.findFirstOrThrow();
    expect(row.deletedAt).toBeNull();
    expect(row.status).toBe("STORED");

    // Tombstone again, upload the same bytes fresh (allowed — the partial
    // index only guards LIVE rows), then the tombstone's restore conflicts.
    await del(
      new Request(`http://localhost/api/documents/inbound/${docId}`, {
        method: "DELETE",
      }),
      ctx(docId),
    );
    const reupload = await post(uploadRequest(PNG_1X1, "scan-again.png"));
    expect(reupload.status).toBe(201);

    const conflicted = await postRestore(
      new Request(`http://localhost/api/documents/inbound/${docId}/restore`, {
        method: "POST",
      }),
      ctx(docId),
    );
    expect(conflicted.status).toBe(409);
    expect((await conflicted.json()).meta.reason).toBe("duplicateExists");

    // Hard-purge the tombstone → restore now answers 409 (undo window over).
    await prisma.inboundDocument.delete({ where: { id: docId } });
    const gone = await postRestore(
      new Request(`http://localhost/api/documents/inbound/${docId}/restore`, {
        method: "POST",
      }),
      ctx(docId),
    );
    expect(gone.status).toBe(409);
    expect((await gone.json()).meta.reason).toBe("purged");
  });

  it("the purge job hard-deletes only past-grace tombstones", async () => {
    const user = await seedVaultUser("vault-purge");
    const prisma = getPrismaClient();
    const { post, del } = await routes();
    const { purgeExpiredDocumentTombstones } =
      await import("@/lib/jobs/document-purge");

    const a = (await (await post(uploadRequest(PNG_1X1, "old.png"))).json())
      .data.id as string;
    const b = (await (await post(uploadRequest(PDF_SMALL, "fresh.pdf"))).json())
      .data.id as string;
    const c = (
      await (
        await post(uploadRequest(Buffer.from("text file\n"), "live.txt"))
      ).json()
    ).data.id as string;

    // a: tombstoned 31 days ago (past grace). b: tombstoned now. c: live.
    for (const id of [a, b]) {
      await del(
        new Request(`http://localhost/api/documents/inbound/${id}`, {
          method: "DELETE",
        }),
        ctx(id),
      );
    }
    await prisma.inboundDocument.update({
      where: { id: a },
      data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) },
    });

    const purged = await purgeExpiredDocumentTombstones(prisma);
    expect(purged).toBe(1);

    const remaining = await prisma.inboundDocument.findMany({
      where: { userId: user.id },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(remaining.map((r) => r.id).sort()).toEqual([b, c].sort());
  });
});

describe("document vault — bulk + usage", () => {
  it("bulk applies per-id with partial-failure results", async () => {
    const user = await seedVaultUser("vault-bulk");
    const prisma = getPrismaClient();
    const episode = await prisma.illnessEpisode.create({
      data: {
        userId: user.id,
        label: "Knie",
        type: "OTHER",
        onsetAt: new Date("2025-09-01T00:00:00.000Z"),
      },
    });
    const { post, postBulk } = await routes();

    const id1 = (await (await post(uploadRequest(PNG_1X1, "a.png"))).json())
      .data.id as string;
    const id2 = (await (await post(uploadRequest(PDF_SMALL, "b.pdf"))).json())
      .data.id as string;

    // setKind over one real + one unknown id → per-id ok/notFound.
    const setKind = await postBulk(
      jsonRequest("http://localhost/api/documents/inbound/bulk", "POST", {
        ids: [id1, "does-not-exist"],
        action: "setKind",
        kind: "LAB_RESULT",
      }),
    );
    expect(setKind.status).toBe(200);
    const { results } = (await setKind.json()).data;
    expect(results).toEqual([
      { id: id1, ok: true, error: null },
      { id: "does-not-exist", ok: false, error: "notFound" },
    ]);
    expect(
      (await prisma.inboundDocument.findUniqueOrThrow({ where: { id: id1 } }))
        .kind,
    ).toBe("LAB_RESULT");

    // linkEpisode + delete + restore round-trip through bulk.
    const link = await postBulk(
      jsonRequest("http://localhost/api/documents/inbound/bulk", "POST", {
        ids: [id1, id2],
        action: "linkEpisode",
        episodeId: episode.id,
      }),
    );
    expect(
      (await link.json()).data.results.every((r: { ok: boolean }) => r.ok),
    ).toBe(true);
    expect(await prisma.documentConditionLink.count()).toBe(2);

    const bulkDelete = await postBulk(
      jsonRequest("http://localhost/api/documents/inbound/bulk", "POST", {
        ids: [id1, id2],
        action: "delete",
      }),
    );
    expect(bulkDelete.status).toBe(200);
    expect(
      await prisma.inboundDocument.count({ where: { deletedAt: null } }),
    ).toBe(0);

    const bulkRestore = await postBulk(
      jsonRequest("http://localhost/api/documents/inbound/bulk", "POST", {
        ids: [id1, id2],
        action: "restore",
      }),
    );
    expect(bulkRestore.status).toBe(200);
    expect(
      await prisma.inboundDocument.count({ where: { deletedAt: null } }),
    ).toBe(2);

    // Cap: 101 ids → 422 (schema bound).
    const over = await postBulk(
      jsonRequest("http://localhost/api/documents/inbound/bulk", "POST", {
        ids: Array.from({ length: 101 }, (_, i) => `id-${i}`),
        action: "delete",
      }),
    );
    expect(over.status).toBe(422);
  });

  it("usage reflects the override + tombstone-inclusive accounting", async () => {
    const user = await seedVaultUser("vault-usage");
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: user.id },
      data: { documentQuotaBytes: BigInt(123_456_789) },
    });
    const { post, del, getUsage } = await routes();

    const id = (await (await post(uploadRequest(PNG_1X1, "a.png"))).json()).data
      .id as string;
    await del(
      new Request(`http://localhost/api/documents/inbound/${id}`, {
        method: "DELETE",
      }),
      ctx(id),
    );

    // Condition chips source: an episode linked to a LIVE document surfaces
    // in `linkedEpisodes`; an episode whose only link sits on the tombstoned
    // row does not.
    const liveEpisode = await prisma.illnessEpisode.create({
      data: {
        userId: user.id,
        label: "Knie",
        type: "INJURY",
        onsetAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const deadEpisode = await prisma.illnessEpisode.create({
      data: {
        userId: user.id,
        label: "Erkältung",
        type: "INFECTION",
        onsetAt: new Date("2026-02-01T00:00:00Z"),
      },
    });
    await post(
      uploadRequest(PDF_SMALL, "knie.pdf", { episodeIds: [liveEpisode.id] }),
    );
    await prisma.documentConditionLink.create({
      data: { documentId: id, episodeId: deadEpisode.id, userId: user.id },
    });

    const res = await getUsage(
      new Request("http://localhost/api/documents/inbound/usage"),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    // Tombstoned bytes still count until the purge reclaims them.
    expect(data.usedBytes).toBe(PNG_1X1.byteLength + PDF_SMALL.byteLength);
    expect(data.quotaBytes).toBe(123_456_789);
    expect(data.maxFileBytes).toBe(26_214_400);
    expect(data.acceptedExtensions).toContain(".pdf");
    expect(data.acceptedExtensions).not.toContain(".heic");
    expect(data.linkedEpisodes).toEqual([
      { episodeId: liveEpisode.id, name: "Knie" },
    ]);
  });
});
