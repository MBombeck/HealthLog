import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Document vault: store-only upload + browsable list.
 *
 * Pins the vault upload contract: a file persists as a STORED row with the
 * binary codec + plaintext sha256 and NO provider / consent / budget call on
 * the path, the policy-layer error contract (413 fileTooLarge / quotaExceeded
 * with limits in `meta`, 415 unsupportedType), the duplicate short-circuit
 * (200 + `meta.duplicate`, no second row), and — hardening — that the list
 * query NEVER selects the encrypted blob column.
 */

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { txQueryRaw, txCreate, txCreateMany } = vi.hoisted(() => ({
  txQueryRaw: vi.fn(),
  txCreate: vi.fn(),
  txCreateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    $queryRaw: txQueryRaw,
    inboundDocument: { create: txCreate },
    documentConditionLink: { createMany: txCreateMany },
  };
  return {
    prisma: {
      inboundDocument: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      extractedFact: {
        groupBy: vi.fn(),
      },
      documentConditionLink: {
        findMany: vi.fn(),
      },
      documentContentIndex: {
        findMany: vi.fn(),
      },
      documentThumbnail: {
        findMany: vi.fn(),
      },
      illnessEpisode: {
        findMany: vi.fn(),
      },
      appSettings: {
        findUnique: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    },
  };
});

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));

vi.mock("@/lib/jobs/document-index", () => ({
  enqueueDocumentIndex: vi.fn().mockResolvedValue({ enqueued: true }),
}));

vi.mock("@/lib/jobs/document-thumbnail", () => ({
  enqueueDocumentThumbnail: vi.fn().mockResolvedValue({ enqueued: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 3_600_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { createHash } from "node:crypto";

import { POST, GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { enqueueDocumentIndex } from "@/lib/jobs/document-index";
import {
  acquireDocumentUploadSlot,
  DOCUMENT_UPLOAD_GLOBAL_CONCURRENCY,
  DOCUMENT_UPLOAD_PER_USER_CONCURRENCY,
} from "@/lib/documents/upload-policy";

const post = POST as unknown as (r: Request) => Promise<Response>;
const get = GET as unknown as (r: Request) => Promise<Response>;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
const PNG_SHA256 = createHash("sha256").update(PNG_BYTES).digest("hex");

function mkUpload(
  fields: Record<string, string | string[]> = {},
  bytes: Buffer = PNG_BYTES,
  filename = "x.png",
) {
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const formData = new FormData();
  formData.append("file", new Blob([blobBytes]), filename);
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      formData.append(k, item);
    }
  }
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: formData,
  });
}

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    userId: "user-1",
    kind: "OTHER",
    title: null,
    filename: "x.png",
    mimeType: "image/png",
    byteSize: 70,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: null,
    errorReason: null,
    contentSha256: PNG_SHA256,
    contentCodec: "binary2",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(prisma.extractedFact.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.documentConditionLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.documentThumbnail.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.documentContentIndex.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(null as never);
  // No settings row / no user override → policy defaults (25 MiB / 1 GiB).
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
  txQueryRaw.mockResolvedValue([{ used: BigInt(0) }]);
  txCreate.mockResolvedValue(docRow() as never);
  txCreateMany.mockResolvedValue({ count: 0 } as never);
});

describe("POST /api/documents/inbound (vault upload)", () => {
  it("stores a file binary-codec encrypted with its plaintext sha256", async () => {
    txCreate.mockResolvedValue(
      docRow({ kind: "LAB_RESULT", title: "Blood panel" }) as never,
    );

    const res = await post(
      mkUpload({ title: "Blood panel", kind: "LAB_RESULT" }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.status).toBe("STORED");
    expect(body.data.kind).toBe("LAB_RESULT");
    expect(body.data.title).toBe("Blood panel");
    expect(body.data.servingClass).toBe("inline");
    expect(body.data.conditionLinks).toEqual([]);

    // The row is created with status STORED, no provider, userId from the
    // session, the ACTIVE binary codec, and the plaintext sha256.
    const arg = txCreate.mock.calls[0]![0]!;
    expect(arg.data.status).toBe("STORED");
    expect(arg.data.userId).toBe("user-1");
    expect(arg.data.kind).toBe("LAB_RESULT");
    expect(arg.data.contentCodec).toBe("binary2");
    expect(arg.data.contentSha256).toBe(PNG_SHA256);
    expect("providerType" in arg.data).toBe(false);
    // The persisted blob is ciphertext, never the plaintext bytes.
    const stored = Buffer.from(arg.data.contentEncrypted as Uint8Array);
    expect(stored.equals(PNG_BYTES)).toBe(false);
    // The create never round-trips the blob back out.
    expect(arg.omit).toEqual({ contentEncrypted: true });

    // A fresh store auto-enqueues the per-document index job (owner + id).
    expect(enqueueDocumentIndex).toHaveBeenCalledWith("user-1", "doc-1");
  });

  it("rejects an unidentifiable payload with 415 + reason unsupportedType", async () => {
    const res = await post(
      mkUpload({}, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), "x.bin"),
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.meta.reason).toBe("unsupportedType");
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("rejects an over-cap file with 413 + the configured limit", async () => {
    // Admin capped uploads below the PNG's 70 bytes (clamped ≥ 1 in the
    // resolver); the file itself trips the per-file check.
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      documentMaxFileBytes: 16,
      documentQuotaBytes: BigInt(1_073_741_824),
    } as never);

    const res = await post(mkUpload());
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.meta.reason).toBe("fileTooLarge");
    expect(body.meta.maxFileBytes).toBe(16);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("rejects an upload past the quota with 413 + quota figures", async () => {
    // Per-user override of 100 bytes; 60 already used; the 70-byte PNG tips it.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentQuotaBytes: BigInt(100),
    } as never);
    txQueryRaw.mockResolvedValue([{ used: BigInt(60) }]);

    const res = await post(mkUpload());
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.meta.reason).toBe("quotaExceeded");
    expect(body.meta.quotaBytes).toBe(100);
    expect(body.meta.usedBytes).toBe(60);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("returns the existing live row with meta.duplicate on a re-upload", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      docRow({ id: "doc-existing" }) as never,
    );

    const res = await post(mkUpload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.duplicate).toBe(true);
    expect(body.data.id).toBe("doc-existing");
    // The duplicate lookup is scoped to the caller's LIVE rows by sha256.
    const where = vi.mocked(prisma.inboundDocument.findFirst).mock.calls[0]![0]!
      .where!;
    expect(where.userId).toBe("user-1");
    expect(where.contentSha256).toBe(PNG_SHA256);
    expect(where.deletedAt).toBeNull();
    expect(txCreate).not.toHaveBeenCalled();
    // A duplicate short-circuits before the store — no index job is enqueued.
    expect(enqueueDocumentIndex).not.toHaveBeenCalled();
  });

  it("pre-links the caller's episodes and refuses a foreign episode id", async () => {
    // Owned episode → link rows land in the same transaction.
    vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([
      { id: "ep-1" },
    ] as never);
    let res = await post(mkUpload({ episodeIds: ["ep-1"] }));
    expect(res.status).toBe(201);
    expect(txCreateMany).toHaveBeenCalledWith({
      data: [{ documentId: "doc-1", episodeId: "ep-1", userId: "user-1" }],
    });

    // Foreign/unknown episode id → 404-shaped refusal, nothing persisted.
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: true,
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
    res = await post(mkUpload({ episodeIds: ["ep-foreign"] }));
    expect(res.status).toBe(404);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("rejects before reading the body when the user's upload slots are full", async () => {
    const releases = Array.from(
      { length: DOCUMENT_UPLOAD_PER_USER_CONCURRENCY },
      () => acquireDocumentUploadSlot("user-1"),
    );
    let bodyRead = false;
    const unreadBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyRead = true;
          controller.error(new Error("body must not be read"));
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("http://localhost/api/documents/inbound", {
      method: "POST",
      body: unreadBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    try {
      const res = await post(request);
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({
        meta: { reason: "uploadBusy" },
      });
      expect(bodyRead).toBe(false);
      expect(txCreate).not.toHaveBeenCalled();
    } finally {
      for (const release of releases) release!();
    }
  });

  it("rejects before reading the body when process-wide upload slots are full", async () => {
    const releases = Array.from(
      { length: DOCUMENT_UPLOAD_GLOBAL_CONCURRENCY },
      (_, index) => acquireDocumentUploadSlot(`other-user-${index}`),
    );
    try {
      const res = await post(mkUpload());
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({
        meta: { reason: "uploadBusy" },
      });
      expect(txCreate).not.toHaveBeenCalled();
    } finally {
      for (const release of releases) release!();
    }
  });

  it("releases an upload slot after an invalid multipart body", async () => {
    const invalid = new Request("http://localhost/api/documents/inbound", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=incomplete" },
      body: "--incomplete\r\n",
    });
    const invalidResponse = await post(invalid);
    expect(invalidResponse.status).toBe(400);

    const held = acquireDocumentUploadSlot("user-1");
    expect(held).not.toBeNull();
    try {
      const validResponse = await post(mkUpload());
      expect(validResponse.status).toBe(201);
    } finally {
      held!();
    }
  });

  it("does not make another whole-body Blob copy before multipart parsing", async () => {
    const request = mkUpload();
    const NativeBlob = globalThis.Blob;
    let blobConstructions = 0;
    class CountingBlob extends NativeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        blobConstructions += 1;
        super(parts, options);
      }
    }
    globalThis.Blob = CountingBlob;
    try {
      const res = await post(request);
      expect(res.status).toBe(201);
      expect(blobConstructions).toBe(0);
    } finally {
      globalThis.Blob = NativeBlob;
    }
  });
});

describe("GET /api/documents/inbound (list)", () => {
  it("never selects the encrypted blob column (omit hardening)", async () => {
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([] as never);

    const res = await get(
      new Request("http://localhost/api/documents/inbound"),
    );
    expect(res.status).toBe(200);

    const arg = vi.mocked(prisma.inboundDocument.findMany).mock.calls[0]![0]!;
    expect(arg.omit).toEqual({ contentEncrypted: true });
    expect(arg.select).toBeUndefined();
    expect(arg.include).toBeUndefined();
  });

  it("applies q + multi-kind + episode filters and returns grouped counts", async () => {
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      docRow({ id: "d1" }),
      docRow({ id: "d2" }),
    ] as never);
    vi.mocked(prisma.extractedFact.groupBy).mockResolvedValue([
      { documentId: "d2", status: "PENDING", _count: { _all: 1 } },
      { documentId: "d2", status: "APPROVED", _count: { _all: 1 } },
      { documentId: "d2", status: "REJECTED", _count: { _all: 3 } },
    ] as never);
    vi.mocked(prisma.documentConditionLink.findMany).mockResolvedValue([
      {
        documentId: "d1",
        episodeId: "ep-1",
        episode: { label: "Knie" },
      },
    ] as never);

    const res = await get(
      new Request(
        "http://localhost/api/documents/inbound?q=panel&kind=LAB_RESULT&kind=IMAGING&episodeId=ep-1&sort=createdAt&order=desc&limit=10",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();

    // d1 carries its condition link; d2 has 1 pending + 1 approved +
    // 3 rejected → factCount 2 (rejected excluded), pendingCount 1.
    const [d1, d2] = body.data.documents;
    expect(d1.conditionLinks).toEqual([{ episodeId: "ep-1", name: "Knie" }]);
    expect(d1.factCount).toBe(0);
    expect(d2.factCount).toBe(2);
    expect(d2.pendingCount).toBe(1);

    const arg = vi.mocked(prisma.inboundDocument.findMany).mock.calls[0]![0]!;
    const where = arg.where!;
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
    expect(where.kind).toEqual({ in: ["LAB_RESULT", "IMAGING"] });
    expect(where.conditionLinks).toEqual({ some: { episodeId: "ep-1" } });
    // Title/filename substring branches, unioned with the blind content-token
    // overlap (the third branch carries the HMAC'd query tokens for "panel").
    expect(where.OR).toEqual([
      { title: { contains: "panel", mode: "insensitive" } },
      { filename: { contains: "panel", mode: "insensitive" } },
      {
        contentIndex: { is: { searchTokens: { hasSome: expect.any(Array) } } },
      },
    ]);
    // limit+1 fetched for the has-more probe.
    expect(arg.take).toBe(11);
  });

  it("maps the year filter to a UTC calendar-year documentDate range", async () => {
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([] as never);
    const res = await get(
      new Request("http://localhost/api/documents/inbound?year=2025"),
    );
    expect(res.status).toBe(200);
    const where = vi.mocked(prisma.inboundDocument.findMany).mock.calls[0]![0]!
      .where!;
    expect(where.documentDate).toEqual({
      gte: new Date(Date.UTC(2025, 0, 1)),
      lt: new Date(Date.UTC(2026, 0, 1)),
    });
  });

  it("emits nextCursor when a full page+1 is returned", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => docRow({ id: `d${i}` }));
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue(rows as never);

    const res = await get(
      new Request("http://localhost/api/documents/inbound?limit=2"),
    );
    const body = await res.json();
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.nextCursor).toBe("d1");
  });

  it("422s on a bad sort value", async () => {
    const res = await get(
      new Request("http://localhost/api/documents/inbound?sort=nope"),
    );
    expect(res.status).toBe(422);
  });
});
