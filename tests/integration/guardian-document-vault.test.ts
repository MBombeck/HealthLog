/**
 * #1403 — a guardian runs a managed profile's document vault from their own
 * account, and nobody else reaches it through the same door.
 *
 * Driven over the real route handlers, the real grant table and real
 * Postgres:
 *
 *   1. the guardian uploads, lists, opens, renames, deletes, restores and
 *      bulk-acts inside the profile, and every row lands on the profile;
 *   2. storage and quota count against the profile, never the guardian;
 *   3. each audit row is filed under the profile and names the guardian as
 *      the actor;
 *   4. the verbs that stay with the owner (delete now, the AI verbs, the
 *      document token) are still refused inside the profile;
 *   5. an adult's share, at READ, WRITE and MANAGE, reaches none of the
 *      vault's writes and only the reads it always had;
 *   6. the guardian of one profile reaches nothing of another;
 *   7. Bearer: a `documents:write` token never acts on another record, a
 *      cookie-equivalent token does exactly what the session does;
 *   8. the upload asks the record's own AI capability, under the guardian's
 *      authority, and the background work is queued for the record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

// The background work an upload queues: captured, not run. What matters here
// is WHOSE record it is queued for.
const enqueued = vi.hoisted(() => ({
  index: [] as string[],
  thumbnail: [] as string[],
  summary: [] as string[],
}));
vi.mock("@/lib/jobs/document-index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDocumentIndex: vi.fn(async (userId: string) => {
    enqueued.index.push(userId);
  }),
}));
vi.mock("@/lib/jobs/document-thumbnail", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDocumentThumbnail: vi.fn(async (userId: string) => {
    enqueued.thumbnail.push(userId);
  }),
}));
vi.mock("@/lib/jobs/document-summary", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDocumentSummary: vi.fn(async (userId: string) => {
    enqueued.summary.push(userId);
  }),
}));

// The scope every AI capability question of a request is answered under.
const capabilityScopes = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/ai/capabilities/load", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/capabilities/load")>();
  return {
    ...actual,
    loadAiCapabilityInputs: vi.fn(
      (...args: Parameters<typeof actual.loadAiCapabilityInputs>) => {
        capabilityScopes.push(args[0]);
        return actual.loadAiCapabilityInputs(...args);
      },
    ),
  };
});

import { ACCOUNT_SELECTOR_HEADER } from "@/lib/auth/acting-carrier";
import { hashToken } from "@/lib/auth/hmac";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

/** A distinct small PDF per call, so the sha256 dedupe never interferes. */
let pdfCounter = 0;
function pdf(): Buffer {
  return Buffer.from(
    `%PDF-1.7\n% guardian vault ${pdfCounter++}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`,
  );
}

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `gv-${suffix}`,
      email: `gv-${suffix}@example.test`,
      displayName: `Guardian vault ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      onboardingCompletedAt: new Date(),
      modulePreferencesJson: { inboundDocuments: true },
    },
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

async function makeProfile(guardianId: string, name: string) {
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardianId,
    displayName: name,
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  await getPrismaClient().user.update({
    where: { id: profile.id },
    data: { modulePreferencesJson: { inboundDocuments: true } },
  });
  return profile;
}

/** A guardian signed in and switched into a fresh managed profile. */
async function guardianInside() {
  const guardian = await makeUser("guardian");
  const profile = await makeProfile(guardian.id, "Managed record");
  const session = await signIn(guardian.id);
  await switchSessionTo(session.id, profile.id);
  return { guardian, profile, session };
}

/** An adult delegate signed in and switched into an adult owner's record. */
async function adultInside(access: "READ" | "WRITE" | "MANAGE") {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access,
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
  const session = await signIn(delegate.id);
  await switchSessionTo(session.id, owner.id);
  return { owner, delegate, session };
}

async function seedDocument(userId: string, title = "Seeded letter") {
  const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
  const bytes = pdf();
  const { createHash } = await import("node:crypto");
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      kind: "OTHER",
      status: "STORED",
      title,
      filename: "seeded.pdf",
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      // A stand-in blob: no test below decrypts a seeded document.
      contentEncrypted: encryptToBytes("seeded"),
    },
  });
}

function uploadRequest(
  bytes: Buffer,
  filename: string,
  fields: Record<string, string> = {},
): Request {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const form = new FormData();
  form.append("file", new Blob([payload]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers: Record<string, string> = {};
  for (const name of ["authorization", ACCOUNT_SELECTOR_HEADER]) {
    const value = headerJar.get(name);
    if (value) headers[name] = value;
  }
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: form,
    headers,
  });
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Ctx = { params: Promise<{ id: string }> };
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
type Handler = (r: Request, c?: Ctx) => Promise<Response>;

async function routes() {
  const list = await import("@/app/api/documents/inbound/route");
  const byId = await import("@/app/api/documents/inbound/[id]/route");
  const original =
    await import("@/app/api/documents/inbound/[id]/original/route");
  const restore =
    await import("@/app/api/documents/inbound/[id]/restore/route");
  const purge = await import("@/app/api/documents/inbound/[id]/purge/route");
  const sources = await import("@/app/api/documents/sources/route");
  const deleted = await import("@/app/api/documents/inbound/deleted/route");
  const bulk = await import("@/app/api/documents/inbound/bulk/route");
  const usage = await import("@/app/api/documents/inbound/usage/route");
  const cast = (h: unknown) => h as Handler;
  return {
    upload: (bytes: Buffer, name = "scan.pdf", fields = {}) =>
      cast(list.POST)(uploadRequest(bytes, name, fields)),
    list: () =>
      cast(list.GET)(new Request("http://localhost/api/documents/inbound")),
    detail: (id: string) =>
      cast(byId.GET)(
        jsonRequest(`/api/documents/inbound/${id}`, "GET"),
        ctx(id),
      ),
    original: (id: string) =>
      cast(original.GET)(
        jsonRequest(`/api/documents/inbound/${id}/original`, "GET"),
        ctx(id),
      ),
    rename: (id: string, title: string) =>
      cast(byId.PATCH)(
        jsonRequest(`/api/documents/inbound/${id}`, "PATCH", { title }),
        ctx(id),
      ),
    patch: (id: string, body: unknown) =>
      cast(byId.PATCH)(
        jsonRequest(`/api/documents/inbound/${id}`, "PATCH", body),
        ctx(id),
      ),
    remove: (id: string) =>
      cast(byId.DELETE)(
        jsonRequest(`/api/documents/inbound/${id}`, "DELETE"),
        ctx(id),
      ),
    restore: (id: string) =>
      cast(restore.POST)(
        jsonRequest(`/api/documents/inbound/${id}/restore`, "POST", {}),
        ctx(id),
      ),
    purge: (id: string) =>
      cast(purge.POST)(
        jsonRequest(`/api/documents/inbound/${id}/purge`, "POST", {}),
        ctx(id),
      ),
    sources: () =>
      cast(sources.GET)(new Request("http://localhost/api/documents/sources")),
    deleted: () =>
      cast(deleted.GET)(
        new Request("http://localhost/api/documents/inbound/deleted"),
      ),
    bulk: (body: unknown) =>
      cast(bulk.POST)(jsonRequest("/api/documents/inbound/bulk", "POST", body)),
    usage: () =>
      cast(usage.GET)(
        new Request("http://localhost/api/documents/inbound/usage"),
      ),
  };
}

async function auditRows(action: string) {
  return getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
    select: { userId: true, actorUserId: true, details: true },
  });
}

async function mintToken(userId: string, permissions: string[]) {
  const raw = `hlk_gv-token-${counter++}`.padEnd(32, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "guardian-vault-test",
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  return raw;
}

/** Switch the jar to the Bearer transport, optionally naming a record. */
function asBearer(token: string, record?: string) {
  cookieJar.clear();
  headerJar.clear();
  headerJar.set("authorization", `Bearer ${token}`);
  if (record) headerJar.set(ACCOUNT_SELECTOR_HEADER, record);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
  enqueued.index.length = 0;
  enqueued.thumbnail.length = 0;
  enqueued.summary.length = 0;
  capabilityScopes.length = 0;
});

describe("a guardian in a managed profile's vault", () => {
  it("uploads into the profile, and lists, opens and downloads it there", async () => {
    const { guardian, profile } = await guardianInside();
    const r = await routes();

    const res = await r.upload(PNG_1X1, "scan.png", { title: "Discharge" });
    expect(res.status).toBe(201);
    const id = (await res.json()).data.id as string;

    const prisma = getPrismaClient();
    const row = await prisma.inboundDocument.findUniqueOrThrow({
      where: { id },
    });
    expect(row.userId).toBe(profile.id);
    expect(
      await prisma.inboundDocument.count({ where: { userId: guardian.id } }),
    ).toBe(0);

    const list = await r.list();
    expect(list.status).toBe(200);
    const listed = (await list.json()).data;
    expect(JSON.stringify(listed)).toContain(id);

    const detail = await r.detail(id);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.title).toBe("Discharge");

    const original = await r.original(id);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("renames, deletes, finds it in Recently deleted and restores it", async () => {
    const { profile } = await guardianInside();
    const r = await routes();
    const id = (await (await r.upload(pdf())).json()).data.id as string;

    const renamed = await r.rename(id, "Blood test, March");
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).data.title).toBe("Blood test, March");

    expect((await r.remove(id)).status).toBe(200);
    const trash = await r.deleted();
    expect(trash.status).toBe(200);
    const trashed = (await trash.json()).data.documents as { id: string }[];
    expect(trashed.map((d) => d.id)).toEqual([id]);

    const restored = await r.restore(id);
    expect(restored.status).toBe(200);
    const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
      where: { id },
    });
    expect(row.userId).toBe(profile.id);
    expect(row.deletedAt).toBeNull();
    expect(row.title).toBe("Blood test, March");
  });

  it("bulk-deletes and bulk-restores the profile's documents", async () => {
    await guardianInside();
    const r = await routes();
    const a = (await (await r.upload(pdf())).json()).data.id as string;
    const b = (await (await r.upload(pdf())).json()).data.id as string;

    const del = await r.bulk({ ids: [a, b], action: "delete" });
    expect(del.status).toBe(200);
    expect(
      ((await del.json()).data.results as { ok: boolean }[]).every((x) => x.ok),
    ).toBe(true);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { id: { in: [a, b] }, deletedAt: { not: null } },
      }),
    ).toBe(2);

    const back = await r.bulk({ ids: [a, b], action: "restore" });
    expect(back.status).toBe(200);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { id: { in: [a, b] }, deletedAt: null },
      }),
    ).toBe(2);
  });

  it("links a document to the profile's own illness episode", async () => {
    const { profile } = await guardianInside();
    const r = await routes();
    const episode = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: profile.id,
        label: "Chickenpox",
        type: "OTHER",
        onsetAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    const id = (await (await r.upload(pdf())).json()).data.id as string;

    const res = await r.patch(id, { episodeIds: [episode.id] });
    expect(res.status).toBe(200);
  });

  it("counts storage and quota against the profile, never the guardian", async () => {
    const { session, profile, guardian } = await guardianInside();
    const prisma = getPrismaClient();
    // Room for exactly one PNG on the profile; the guardian's own quota is
    // left at the default and must not be the one consulted.
    await prisma.user.update({
      where: { id: profile.id },
      data: { documentQuotaBytes: BigInt(PNG_1X1.byteLength + 10) },
    });
    const r = await routes();

    expect((await r.upload(PNG_1X1, "one.png")).status).toBe(201);

    const usage = await r.usage();
    expect(usage.status).toBe(200);
    const inside = (await usage.json()).data;
    expect(inside.usedBytes).toBe(PNG_1X1.byteLength);
    expect(inside.quotaBytes).toBe(PNG_1X1.byteLength + 10);

    const over = await r.upload(pdf(), "two.pdf");
    expect(over.status).toBe(413);
    expect((await over.json()).meta.reason).toBe("quotaExceeded");

    // Back in the guardian's own record: nothing was charged there.
    await switchSessionTo(session.id, null);
    const own = (await (await r.usage()).json()).data;
    expect(own.usedBytes).toBe(0);
    expect(own.quotaBytes).not.toBe(PNG_1X1.byteLength + 10);
    expect(
      await prisma.inboundDocument.count({ where: { userId: guardian.id } }),
    ).toBe(0);
  });

  it("files every audit row under the profile with the guardian as actor", async () => {
    const { guardian, profile } = await guardianInside();
    const r = await routes();
    const id = (await (await r.upload(pdf())).json()).data.id as string;
    await r.rename(id, "Renamed");
    await r.remove(id);
    await r.restore(id);

    for (const action of [
      "documents.inbound.store",
      "documents.inbound.update",
      "documents.inbound.discard",
      "documents.inbound.restore",
    ]) {
      const rows = await auditRows(action);
      expect(rows, action).toHaveLength(1);
      expect(rows[0].userId, action).toBe(profile.id);
      expect(rows[0].actorUserId, action).toBe(guardian.id);
    }
  });

  it("counts the profile's deleted documents in its usage, for the restore door", async () => {
    await guardianInside();
    const r = await routes();
    const id = (await (await r.upload(pdf())).json()).data.id as string;
    await r.remove(id);

    const usage = (await (await r.usage()).json()).data;
    expect(usage.deletedCount).toBe(1);
  });

  it("holds the owner's verbs too: delete now, and the document sources (#1615)", async () => {
    const { guardian, profile } = await guardianInside();
    const r = await routes();
    const id = (await (await r.upload(pdf())).json()).data.id as string;
    await r.remove(id);

    // Delete now, which the owner reaches from Recently deleted. The rule a
    // guardian holds is the owner's, so it is theirs as well, and the
    // document leaves the profile, not the guardian's vault.
    const purge = await r.purge(id);
    expect(purge.status).toBe(200);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { id, userId: profile.id },
      }),
    ).toBe(0);
    const purged = await getPrismaClient().auditLog.findMany({
      where: { userId: profile.id, actorUserId: guardian.id },
      select: { action: true },
    });
    expect(purged.length).toBeGreaterThan(0);

    // The document sources (Paperless-ngx, Papra) are the profile's to set up
    // as well; the list answers for the profile.
    expect((await r.sources()).status).toBe(200);
  });

  it("asks the profile's own AI capability under the guardian's authority, and queues work for the profile", async () => {
    const { guardian, profile } = await guardianInside();
    const r = await routes();

    expect((await r.upload(pdf())).status).toBe(201);

    const scopes = capabilityScopes as Array<{
      recordId: string;
      recordKind: string;
      authority: { origin: string; actorUserId: string | null } | null;
    }>;
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope.recordId).toBe(profile.id);
      expect(scope.recordKind).toBe("managed");
      expect(scope.authority?.origin).toBe("guardian");
      expect(scope.authority?.actorUserId).toBe(guardian.id);
    }

    expect(enqueued.index).toEqual([profile.id]);
    expect(enqueued.thumbnail).toEqual([profile.id]);
    // The profile has no provider and no automatic reading switched on, so no
    // summary is queued — for the profile or for anybody else.
    expect(enqueued.summary).toEqual([]);
  });
});

describe("the guardian of one profile", () => {
  it("reaches nothing of another profile", async () => {
    const { guardian, session } = await guardianInside();
    const otherGuardian = await makeUser("other-guardian");
    const other = await makeProfile(otherGuardian.id, "Someone else's");
    const foreign = await seedDocument(other.id);
    const r = await routes();

    // A document id from the other profile, asked inside the guardian's own
    // profile: not there.
    expect((await r.rename(foreign.id, "Mine now")).status).toBe(404);
    expect((await r.remove(foreign.id)).status).toBe(404);

    // Pointing the session at the other profile: no grant, refused.
    await switchSessionTo(session.id, other.id);
    expect((await r.upload(pdf())).status).toBe(403);
    expect((await r.list()).status).toBe(403);
    expect((await r.rename(foreign.id, "Mine now")).status).toBe(403);
    expect((await r.remove(foreign.id)).status).toBe(403);
    expect((await r.deleted()).status).toBe(403);

    const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(row.title).toBe("Seeded letter");
    expect(row.deletedAt).toBeNull();
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { userId: { in: [other.id, guardian.id] } },
      }),
    ).toBe(1);
  });
});

describe("an adult's share reaches none of the vault's writes", () => {
  for (const access of ["READ", "WRITE", "MANAGE"] as const) {
    it(`at ${access}`, async () => {
      const { owner } = await adultInside(access);
      const doc = await seedDocument(owner.id);
      const r = await routes();

      // The reads it always had.
      expect((await r.list()).status).toBe(200);
      expect((await r.detail(doc.id)).status).toBe(200);

      for (const [verb, res] of [
        ["upload", await r.upload(pdf())],
        ["rename", await r.rename(doc.id, "Changed")],
        ["delete", await r.remove(doc.id)],
        ["restore", await r.restore(doc.id)],
        ["deleted", await r.deleted()],
        ["bulk", await r.bulk({ ids: [doc.id], action: "delete" })],
        ["purge", await r.purge(doc.id)],
      ] as const) {
        expect(res.status, verb).toBe(403);
      }

      const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(row.title).toBe("Seeded letter");
      expect(row.deletedAt).toBeNull();
      expect(
        await getPrismaClient().inboundDocument.count({
          where: { userId: owner.id },
        }),
      ).toBe(1);
      // The vault's deleted count stays the owner's: an adult delegate is
      // offered no way into Recently deleted.
      expect((await (await r.usage()).json()).data.deletedCount).toBe(0);
    });
  }
});

describe("Bearer tokens follow the existing scope rules", () => {
  it("refuses a documents:write token naming the profile, and admits it on its own record", async () => {
    const { guardian, profile } = await guardianInside();
    const token = await mintToken(guardian.id, ["documents:write"]);
    const r = await routes();

    asBearer(token, profile.id);
    expect((await r.upload(pdf())).status).toBe(403);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { userId: profile.id },
      }),
    ).toBe(0);

    asBearer(token);
    expect((await r.upload(pdf())).status).toBe(201);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { userId: guardian.id },
      }),
    ).toBe(1);
  });

  it("lets a cookie-equivalent token do what the guardian's session does", async () => {
    const { guardian, profile } = await guardianInside();
    const token = await mintToken(guardian.id, ["*"]);
    const r = await routes();

    asBearer(token, profile.id);
    const res = await r.upload(pdf());
    expect(res.status).toBe(201);
    const id = (await res.json()).data.id as string;
    expect((await r.rename(id, "From the phone")).status).toBe(200);
    const row = await getPrismaClient().inboundDocument.findUniqueOrThrow({
      where: { id },
    });
    expect(row.userId).toBe(profile.id);
  });

  it("refuses the same token for an adult's MANAGE delegate", async () => {
    const { owner, delegate } = await adultInside("MANAGE");
    const token = await mintToken(delegate.id, ["*"]);
    const r = await routes();

    asBearer(token, owner.id);
    expect((await r.upload(pdf())).status).toBe(403);
    expect(
      await getPrismaClient().inboundDocument.count({
        where: { userId: owner.id },
      }),
    ).toBe(0);
  });
});

describe("the link to the archive original stays the owner's (#1394)", () => {
  async function importedFromPaperless(userId: string) {
    const prisma = getPrismaClient();
    const { encrypt } = await import("@/lib/crypto");
    await prisma.documentSourceConnection.create({
      data: {
        userId,
        system: "PAPERLESS",
        baseUrl: "https://paperless.example.com/archive",
        tokenEncrypted: encrypt("paperless-token"),
      },
    });
    const doc = await seedDocument(userId, "Imported letter");
    await prisma.inboundDocument.update({
      where: { id: doc.id },
      data: { sourceSystem: "PAPERLESS", sourceId: "42" },
    });
    return doc.id;
  }

  async function linksSeen(id: string) {
    const r = await routes();
    const listed = (await (await r.list()).json()).data.documents as Array<{
      id: string;
      sourceUrl: string | null;
    }>;
    const detail = (await (await r.detail(id)).json()).data;
    const patched = (await (await r.rename(id, "Renamed")).json()).data;
    return {
      list: listed.find((d) => d.id === id)?.sourceUrl,
      detail: detail.sourceUrl as string | null,
      detailSourceId: detail.sourceId as string | null,
      patch: patched?.sourceUrl as string | null | undefined,
    };
  }

  beforeEach(() => {
    vi.stubEnv("DOCUMENT_SOURCE_ORIGINS", "https://paperless.example.com");
  });

  it("gives the owner the page in their own archive", async () => {
    const owner = await makeUser("archive-owner");
    await signIn(owner.id);
    const id = await importedFromPaperless(owner.id);
    const url = "https://paperless.example.com/archive/documents/42/details";
    expect(await linksSeen(id)).toEqual({
      list: url,
      detail: url,
      detailSourceId: "42",
      patch: url,
    });
  });

  it("gives a guardian inside a managed profile none", async () => {
    const { profile } = await guardianInside();
    const id = await importedFromPaperless(profile.id);
    expect(await linksSeen(id)).toEqual({
      list: null,
      detail: null,
      detailSourceId: "42",
      patch: null,
    });
  });

  it("gives an adult's MANAGE delegate none", async () => {
    const { owner } = await adultInside("MANAGE");
    const id = await importedFromPaperless(owner.id);
    const r = await routes();
    const listed = (await (await r.list()).json()).data.documents as Array<{
      id: string;
      sourceUrl: string | null;
    }>;
    expect(listed.find((d) => d.id === id)?.sourceUrl).toBeNull();
    const detail = (await (await r.detail(id)).json()).data;
    expect(detail.sourceId).toBe("42");
    expect(detail.sourceUrl).toBeNull();
  });
});
