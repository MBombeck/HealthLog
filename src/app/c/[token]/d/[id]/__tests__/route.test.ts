import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";

/**
 * v1.28 (document vault, Phase 3) — public share-scoped document serve route
 * `GET /c/[token]/d/[id]`.
 *
 * Load-bearing behaviour under test: it resolves ONLY via the share token
 * (never a session), confines serving to the link's frozen document set (a
 * foreign / unknown / soft-deleted id → flat 404), re-enforces the passphrase
 * gate and revocation/expiry BEFORE any decrypt, applies the identical
 * serving-class posture as the owner route (inline Class A / attachment Class
 * B + octet-stream + nosniff + no-store, no route-level CSP), strips EXIF from
 * raster images on egress, and fails closed on a decrypt error.
 */

// Reversible crypto stub (mirrors the owner /original route test) so the
// document codec round-trips without real keys.
const decryptMock = vi.fn((s: string) =>
  Buffer.from(s.replace(/^v1\./, ""), "base64").toString("utf8"),
);
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `v1.${Buffer.from(s, "utf8").toString("base64")}`,
  decrypt: (s: string) => decryptMock(s),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLinkDocument: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/clinician-share/resolve-share-token", () => ({
  resolveShareGateState: vi.fn(),
  resolveShareToken: vi.fn(),
}));

vi.mock("@/lib/clinician-share/unlock-cookie", () => ({
  unlockCookieName: (h: string) => `hls_unlock_${h.slice(0, 16)}`,
  verifyUnlockValue: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 299, resetAt: Date.now() }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import {
  resolveShareGateState,
  resolveShareToken,
} from "@/lib/clinician-share/resolve-share-token";
import { verifyUnlockValue } from "@/lib/clinician-share/unlock-cookie";
import { checkRateLimit } from "@/lib/rate-limit";
import { encryptDocumentToBytes } from "@/lib/documents/store";
import { isModuleEnabled } from "@/lib/modules/gate";

const TOKEN = "hls_000000000000000000000000000000000000000000000000";
const OWNER = "owner-1";
const SHARE_LINK_ID = "link-1";

type Ctx = { params: Promise<{ token: string; id: string }> };
const callGet = GET as unknown as (
  req: NextRequest,
  ctx: Ctx,
) => Promise<Response>;

function makeReq(id: string): NextRequest {
  return new NextRequest(new URL(`http://localhost/c/${TOKEN}/d/${id}`));
}
function ctx(id: string): Ctx {
  return { params: Promise.resolve({ token: TOKEN, id }) };
}

/** Seed a membership row whose document decrypts to `bytes` of `mimeType`. */
function seedMembership(opts: {
  id?: string;
  userId?: string;
  filename?: string | null;
  mimeType: string;
  bytes: Buffer;
  deletedAt?: Date | null;
}) {
  vi.mocked(prisma.clinicianShareLinkDocument.findUnique).mockResolvedValue({
    document: {
      id: opts.id ?? "doc-1",
      userId: opts.userId ?? OWNER,
      filename: opts.filename ?? "report.pdf",
      mimeType: opts.mimeType,
      contentCodec: "base64v1",
      contentEncrypted: encryptDocumentToBytes(opts.bytes),
      deletedAt: opts.deletedAt ?? null,
    },
  } as never);
}

const PDF_BYTES = Buffer.from("%PDF-1.7 fake report body");

// A minimal JPEG carrying a GPS marker inside an APP1 (Exif) segment.
function jpegWithGps(): Buffer {
  const payload = Buffer.concat([
    Buffer.from("Exif\0\0"),
    Buffer.from("GPSLatitude=48.137"),
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(payload.length + 2);
      return b;
    })(),
    payload,
  ]);
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda]),
    Buffer.from([0x00, 0x08]),
    Buffer.from([0x01, 0x01, 0x00, 0x3f, 0x00, 0x00]),
    Buffer.from([0xaa, 0xbb]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos]);
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptMock.mockImplementation((s: string) =>
    Buffer.from(s.replace(/^v1\./, ""), "base64").toString("utf8"),
  );
  vi.mocked(verifyUnlockValue).mockReturnValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 299,
    resetAt: Date.now(),
  } as never);
  // Default: a live, unprotected link resolving to the owner scope.
  vi.mocked(resolveShareGateState).mockResolvedValue({
    tokenHash: "hash-1",
    passphraseHash: null,
  } as never);
  vi.mocked(resolveShareToken).mockResolvedValue({
    shareLinkId: SHARE_LINK_ID,
    ownerUserId: OWNER,
    label: "Clinic",
    rangeStart: new Date(),
    rangeEnd: null,
    sectionsJson: {},
    expiresAt: new Date(Date.now() + 3_600_000),
  } as never);
});

describe("GET /c/[token]/d/[id] — share document serve", () => {
  it("answers 404 once the owner switched the documents module off", async () => {
    seedMembership({ mimeType: "application/pdf", bytes: PDF_BYTES });
    vi.mocked(isModuleEnabled).mockResolvedValueOnce(false);

    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));

    expect(res.status).toBe(404);
    expect(isModuleEnabled).toHaveBeenCalledWith(OWNER, "inboundDocuments");
    expect(prisma.clinicianShareLinkDocument.findUnique).not.toHaveBeenCalled();
  });

  it("serves a PDF inline through the token, confined to the frozen set", async () => {
    seedMembership({ mimeType: "application/pdf", bytes: PDF_BYTES });

    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("inline");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    // The response CSP is proxy-owned; the route sets none.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(PDF_BYTES)).toBe(true);

    // The membership lookup ties the id to THIS link (token-confined scope).
    const arg = vi.mocked(prisma.clinicianShareLinkDocument.findUnique).mock
      .calls[0][0];
    expect(arg!.where).toEqual({
      shareLinkId_documentId: {
        shareLinkId: SHARE_LINK_ID,
        documentId: "doc-1",
      },
    });
  });

  it("strips EXIF/GPS from a shared JPEG on egress", async () => {
    const jpeg = jpegWithGps();
    seedMembership({ mimeType: "image/jpeg", bytes: jpeg, filename: "p.jpg" });

    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(200);
    const out = Buffer.from(await res.arrayBuffer());
    // The GPS marker is gone; the image is strictly smaller than the original.
    expect(out.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(out.length).toBeLessThan(jpeg.length);
    // Still an inline image.
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toContain("inline");
  });

  it("serves a Class B document as an opaque attachment (never inline)", async () => {
    seedMembership({
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: Buffer.from("docx payload"),
      filename: "letter.docx",
    });
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition.startsWith("attachment;")).toBe(true);
    expect(disposition).toContain("letter.docx");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("never serves a would-be HTML/SVG payload inline (byte-class denies it)", async () => {
    // HTML/SVG can never be stored (upload deny-list); even if a row carried
    // such a type, the serving class forces attachment + octet-stream so it
    // can never script in-origin.
    for (const mime of ["text/html", "image/svg+xml"]) {
      seedMembership({ mimeType: mime, bytes: Buffer.from("<svg/>") });
      const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
    }
  });

  it("404s a document id not on the link's frozen set", async () => {
    vi.mocked(prisma.clinicianShareLinkDocument.findUnique).mockResolvedValue(
      null as never,
    );
    const res = await callGet(makeReq("foreign"), ctx("foreign"));
    expect(res.status).toBe(404);
  });

  it("404s a soft-deleted document even if the membership row survives", async () => {
    seedMembership({
      mimeType: "application/pdf",
      bytes: PDF_BYTES,
      deletedAt: new Date(),
    });
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(404);
  });

  it("404s when the document owner does not match the token owner", async () => {
    seedMembership({
      mimeType: "application/pdf",
      bytes: PDF_BYTES,
      userId: "someone-else",
    });
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(404);
  });

  it("serves NOTHING for a revoked/expired/unknown token (gate null) — no decrypt", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue(null as never);
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(404);
    // Revocation is enforced BEFORE any decrypt or membership lookup.
    expect(prisma.clinicianShareLinkDocument.findUnique).not.toHaveBeenCalled();
    expect(resolveShareToken).not.toHaveBeenCalled();
  });

  it("serves NOTHING for a protected link without a valid unlock cookie", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue({
      tokenHash: "hash-1",
      passphraseHash: "hash(pass)",
    } as never);
    vi.mocked(verifyUnlockValue).mockReturnValue(false);
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(404);
    // The passphrase gate stands in front of any decrypt.
    expect(prisma.clinicianShareLinkDocument.findUnique).not.toHaveBeenCalled();
  });

  it("429s when the per-link serve rate limit trips", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now(),
    } as never);
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(429);
    expect(prisma.clinicianShareLinkDocument.findUnique).not.toHaveBeenCalled();
  });

  it("fails closed (500) on a decrypt error — never serves ciphertext", async () => {
    seedMembership({ mimeType: "application/pdf", bytes: PDF_BYTES });
    decryptMock.mockImplementation(() => {
      throw new Error("unknown key id");
    });
    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
