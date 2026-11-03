import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";

/**
 * `GET /api/documents/inbound/[id]/thumbnail`.
 *
 * The route decrypts and serves the small JPEG preview. Load-bearing behaviour
 * under test: it is owner-scoped (the query narrows on the session userId, so
 * another user's document is a 404), a document with no thumbnail row is a 404,
 * a hit serves image/jpeg + nosniff + private no-store, and it fails closed on
 * a decrypt error.
 */

// A reversible crypto stub so encryptThumbnail / decryptThumbnail round-trip
// through the shared string codec without real keys. The thumbnail helpers go
// through the bytes-codec (encryptToBytes / decryptFromBytes), which wraps
// encrypt() / decrypt() — stub those.
const decryptMock = vi.fn((s: string) => s.replace(/^v1\./, ""));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `v1.${s}`,
  decrypt: (s: string) => decryptMock(s),
  encryptBytes: (b: Buffer) => b,
  decryptBytes: (b: Buffer) => b,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 2999, resetAt: Date.now() }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { encryptThumbnail } from "@/lib/documents/store";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

type Ctx = { params: Promise<{ id: string }> };
const callGet = GET as unknown as (
  req: NextRequest,
  ctx: Ctx,
) => Promise<Response>;

function makeReq(id: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/thumbnail`),
  );
}
function ctx(id: string): Ctx {
  return { params: Promise.resolve({ id }) };
}

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);

beforeEach(() => {
  vi.clearAllMocks();
  decryptMock.mockImplementation((s: string) => s.replace(/^v1\./, ""));
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/documents/inbound/[id]/thumbnail", () => {
  it("serves the decrypted JPEG with nosniff + private no-store, owner-scoped", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
      thumbnail: {
        thumbnailEncrypted: encryptThumbnail(JPEG_BYTES),
        byteSize: JPEG_BYTES.byteLength,
      },
    } as never);

    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(JPEG_BYTES)).toBe(true);

    // The query is narrowed on the session userId + live rows only.
    const where = vi.mocked(prisma.inboundDocument.findFirst).mock.calls[0][0]
      ?.where as { id: string; userId: string; deletedAt: null };
    expect(where.userId).toBe("user-1");
    expect(where.id).toBe("doc-1");
    expect(where.deletedAt).toBeNull();
  });

  it("404s when the document has no thumbnail yet", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-2",
      thumbnail: null,
    } as never);

    const res = await callGet(makeReq("doc-2"), ctx("doc-2"));
    expect(res.status).toBe(404);
  });

  it("404s for another user's document (the userId narrows it out)", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );

    const res = await callGet(makeReq("other-doc"), ctx("other-doc"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("fails closed (500) on a decrypt error — never serves ciphertext", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-3",
      thumbnail: {
        thumbnailEncrypted: encryptThumbnail(JPEG_BYTES),
        byteSize: JPEG_BYTES.byteLength,
      },
    } as never);
    decryptMock.mockImplementation(() => {
      throw new Error("unknown key id");
    });

    const res = await callGet(makeReq("doc-3"), ctx("doc-3"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
