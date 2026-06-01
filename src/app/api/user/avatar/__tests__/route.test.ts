import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST, DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";

// `apiHandler` types as `NextRequest → Promise<Response>`; the test
// fixtures hand in a plain `Request` which is structurally compatible
// for everything the handler reads, so we narrow the call type the
// same way `disable-coach/__tests__/route.test.ts` does.
const post = POST as (r: Request) => Promise<Response>;
const del = DELETE as (r: Request) => Promise<Response>;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

/**
 * Minimal valid PNG: 1x1 white pixel. The Vitest `node` env has a
 * polyfilled `File` + `Blob` + `FormData` so we can build a multipart
 * body without an extra library.
 */
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==";

function pngBuffer(): Buffer {
  return Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
}

function mkUpload(body: Buffer, filename = "avatar.png", type = "image/png") {
  const formData = new FormData();
  // Copy into a plain Uint8Array — Node's `Buffer<ArrayBufferLike>`
  // is not structurally assignable to `BlobPart` because of the
  // ArrayBufferLike vs. ArrayBuffer mismatch on the `.buffer` type.
  const blobBytes = new Uint8Array(body.byteLength);
  blobBytes.set(body);
  const blob = new Blob([blobBytes], { type });
  formData.append("file", blob, filename);
  return new Request("http://localhost/api/user/avatar", {
    method: "POST",
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default rate-limit pass-through; per-test overrides drop in below.
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  });
});

describe("POST /api/user/avatar", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await post(mkUpload(pngBuffer()));
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("stores a valid PNG and returns the cache-busting URL", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await post(mkUpload(pngBuffer()));
    expect(res.status).toBe(201);
    const env = (await res.json()) as {
      data: { avatarUrl: string; contentType: string; updatedAt: string };
    };
    expect(env.data.contentType).toBe("image/png");
    expect(env.data.avatarUrl).toMatch(/^\/api\/user\/avatar\/user-1\?v=\d+$/);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          avatarContentType: "image/png",
        }),
      }),
    );

    expect(auditLog).toHaveBeenCalledWith(
      "user.avatar.upload",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          contentType: "image/png",
        }),
      }),
    );
  });

  it("rejects a body larger than 2 MiB with 413", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // 2 MiB + 1 byte. The PNG signature at the front keeps the
    // detector happy, but the size check trips first.
    const tooBig = Buffer.concat([pngBuffer(), Buffer.alloc(2 * 1024 * 1024)]);

    const res = await post(mkUpload(tooBig));
    expect(res.status).toBe(413);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an oversize chunked upload with no Content-Length at the stream level (413)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    // Build a multipart body as a streamed ReadableStream with NO
    // Content-Length header — the shape a `Transfer-Encoding: chunked`
    // upload takes. The bounded stream reader must trip before the body
    // is fully buffered.
    const boundary = "----healthlogtest";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const oversize = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
    const parts = [head, oversize, tail];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) {
          controller.enqueue(new Uint8Array(p));
        }
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/user/avatar", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: stream,
      // Node's fetch requires `duplex: "half"` for a streamed body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const res = await post(req);
    expect(res.status).toBe(413);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unsupported MIME with 415 (magic-byte sniff)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Plain text content — no JPEG/PNG/WebP magic.
    const notAnImage = Buffer.from("hello, world — definitely not an image");

    const res = await post(
      mkUpload(notAnImage, "avatar.png", "image/png"),
    );
    expect(res.status).toBe(415);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a missing 'file' field with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const formData = new FormData();
    formData.append("other", "ignored");
    const req = new Request("http://localhost/api/user/avatar", {
      method: "POST",
      body: formData,
    });

    const res = await post(req);
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("trips the per-user rate-limit with 429", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const res = await post(mkUpload(pngBuffer()));
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/user/avatar", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await del(
      new Request("http://localhost/api/user/avatar", { method: "DELETE" }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("clears the row and returns 204", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      avatarContentType: "image/png",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await del(
      new Request("http://localhost/api/user/avatar", { method: "DELETE" }),
    );
    expect(res.status).toBe(204);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        avatarBytes: null,
        avatarContentType: null,
        avatarUpdatedAt: null,
      },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.avatar.delete",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("skips the audit row when the avatar was already empty", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      avatarContentType: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await del(
      new Request("http://localhost/api/user/avatar", { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
    expect(auditLog).not.toHaveBeenCalled();
  });
});
