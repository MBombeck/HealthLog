import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Document-vault policy layer: exhaustive accept-matrix coverage.
 *
 * Every Class A and Class B format is detected from real magic-byte
 * fixtures, every deny case is denied, the wire Content-Type never plays a
 * role (the detector does not even receive it), container ambiguity (ZIP →
 * OOXML only under an Office extension) is pinned, adversarial polyglots
 * behave as designed, and the limits resolver clamps to the hard ceiling.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  DOCUMENT_DEFAULT_MAX_FILE_BYTES,
  acquireDocumentUploadSlot,
  DOCUMENT_UPLOAD_GLOBAL_CONCURRENCY,
  DOCUMENT_UPLOAD_PER_USER_CONCURRENCY,
  DOCUMENT_DEFAULT_QUOTA_BYTES,
  DOCUMENT_HARD_MAX_FILE_BYTES,
  detectDocumentType,
  resolveDocumentLimits,
  servingClassFor,
} from "../upload-policy";

// ─── Magic-byte fixtures ─────────────────────────────────────────────────────

const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n", "latin1");
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16, 0x11),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0x22),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(8, 0x33),
]);
const GIF87 = Buffer.concat([Buffer.from("GIF87a"), Buffer.alloc(16, 0x44)]);
const GIF89 = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16, 0x44)]);
const ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(32, 0x55),
]);
const CFB = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(32, 0x66),
]);
const RTF = Buffer.from("{\\rtf1\\ansi Hello}", "latin1");
const TIFF_LE = Buffer.concat([
  Buffer.from([0x49, 0x49, 0x2a, 0x00]),
  Buffer.alloc(16, 0x77),
]);
const TIFF_BE = Buffer.concat([
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
  Buffer.alloc(16, 0x77),
]);

/** ISO-BMFF ftyp box with the given major + compatible brands. */
function ftyp(major: string, compat: string[] = []): Buffer {
  const brands = Buffer.from([major, "0000", ...compat].join(""), "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(8 + brands.byteLength);
  return Buffer.concat([len, Buffer.from("ftyp"), brands, Buffer.alloc(8)]);
}

const TEXT = Buffer.from("Befund: alles unauffällig.\nZeile 2\n", "utf8");
const MZ = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0x90)]);
const ELF = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.alloc(32, 0),
]);
const MACHO = Buffer.concat([
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.alloc(32, 0),
]);

describe("detectDocumentType — Class A (inline; magic bytes only)", () => {
  it.each([
    ["report.pdf", PDF, "application/pdf"],
    ["photo.jpg", JPEG, "image/jpeg"],
    ["scan.png", PNG, "image/png"],
    ["scan.webp", WEBP, "image/webp"],
    ["anim87.gif", GIF87, "image/gif"],
    ["anim89.gif", GIF89, "image/gif"],
  ])("%s → %s inline", (name, bytes, mime) => {
    expect(detectDocumentType(bytes, name)).toEqual({
      mimeType: mime,
      servingClass: "inline",
    });
  });

  it("classifies by bytes, not extension (JPEG named .dat is still a JPEG)", () => {
    expect(detectDocumentType(JPEG, "export.dat")).toEqual({
      mimeType: "image/jpeg",
      servingClass: "inline",
    });
  });
});

describe("detectDocumentType — Class B (attachment-only)", () => {
  it.each([
    [
      "letter.docx",
      ZIP,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "values.xlsx",
      ZIP,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "slides.pptx",
      ZIP,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["letter.doc", CFB, "application/msword"],
    ["values.xls", CFB, "application/vnd.ms-excel"],
    ["slides.ppt", CFB, "application/vnd.ms-powerpoint"],
    ["note.rtf", RTF, "application/rtf"],
    ["scan.tif", TIFF_LE, "image/tiff"],
    ["scan.tiff", TIFF_BE, "image/tiff"],
    ["befund.txt", TEXT, "text/plain"],
    ["befund.md", TEXT, "text/plain"],
    ["werte.csv", TEXT, "text/csv"],
    ["export.xml", TEXT, "application/xml"],
    ["export.json", TEXT, "application/json"],
  ])("%s → %s attachment", (name, bytes, mime) => {
    expect(detectDocumentType(bytes, name)).toEqual({
      mimeType: mime,
      servingClass: "attachment",
    });
  });

  it.each([
    ["heic (major brand)", ftyp("heic")],
    ["heix (major brand)", ftyp("heix")],
    ["hevc (major brand)", ftyp("hevc")],
    ["mif1 (major brand)", ftyp("mif1")],
    ["msf1 (major brand)", ftyp("msf1")],
    ["compatible-brand heic", ftyp("isom", ["heic"])],
  ])("HEIC/HEIF %s → image/heic attachment", (_label, bytes) => {
    expect(detectDocumentType(bytes, "photo.heic")).toEqual({
      mimeType: "image/heic",
      servingClass: "attachment",
    });
  });
});

describe("detectDocumentType — deny", () => {
  it.each([
    ["MZ executable", MZ, "payload.pdf"],
    ["ELF executable", ELF, "scan.png"],
    ["Mach-O executable", MACHO, "report.txt"],
  ])("%s is denied regardless of a friendly extension", (_l, bytes, name) => {
    expect(detectDocumentType(bytes, name)).toBeNull();
  });

  it.each([
    ".exe",
    ".dll",
    ".bat",
    ".cmd",
    ".sh",
    ".ps1",
    ".js",
    ".mjs",
    ".jar",
    ".apk",
    ".html",
    ".htm",
    ".xhtml",
    ".svg",
    ".zip",
    ".7z",
    ".rar",
    ".tar",
    ".gz",
    ".iso",
    ".img",
    ".dmg",
  ])("extension %s is denied even with harmless text bytes", (ext) => {
    expect(detectDocumentType(TEXT, `file${ext}`)).toBeNull();
  });

  it("denies a ZIP container without an Office extension (incl. no name)", () => {
    expect(detectDocumentType(ZIP, "archive.zip")).toBeNull();
    expect(detectDocumentType(ZIP, "archive")).toBeNull();
    expect(detectDocumentType(ZIP, null)).toBeNull();
    // CFB without a legacy-Office extension is equally refused.
    expect(detectDocumentType(CFB, "blob.bin")).toBeNull();
  });

  it("denies text-extension files smuggling NUL bytes", () => {
    const binaryish = Buffer.concat([TEXT, Buffer.from([0x00]), TEXT]);
    expect(detectDocumentType(binaryish, "befund.txt")).toBeNull();
  });

  it("denies unidentifiable bytes and empty files", () => {
    expect(detectDocumentType(Buffer.from([1, 2, 3, 4, 5, 6]), "x.bin")).toBe(
      null,
    );
    expect(detectDocumentType(Buffer.alloc(0), "empty.txt")).toBeNull();
    // Text-like bytes under a non-text extension stay unidentifiable.
    expect(detectDocumentType(TEXT, "notes.abc")).toBeNull();
  });

  it("adversarial: SVG content cannot sneak in under an image extension", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(detectDocumentType(svg, "image.svg")).toBeNull(); // ext deny
    expect(detectDocumentType(svg, "image.png")).toBeNull(); // no PNG magic, no text ext
  });

  it("adversarial: HTML under a text extension stays attachment-only", () => {
    // Accepted as text/plain — but Class B never renders inline, so the
    // markup can never execute in-origin.
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    expect(detectDocumentType(html, "page.txt")).toEqual({
      mimeType: "text/plain",
      servingClass: "attachment",
    });
    expect(detectDocumentType(html, "page.html")).toBeNull();
  });

  it("adversarial: a PDF with an HTML head is still a PDF (sandboxed inline)", () => {
    const polyglot = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from("<script>alert(1)</script>"),
    ]);
    expect(detectDocumentType(polyglot, "poly.pdf")).toEqual({
      mimeType: "application/pdf",
      servingClass: "inline",
    });
  });
});

describe("servingClassFor", () => {
  it("marks exactly the browser-native passive set inline", () => {
    for (const mime of [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]) {
      expect(servingClassFor(mime)).toBe("inline");
    }
  });

  it("marks every other stored type attachment (incl. unknowns)", () => {
    for (const mime of [
      "image/heic",
      "image/tiff",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "text/csv",
      "application/rtf",
      "application/xml",
      "application/json",
      "text/html", // must never happen at rest, but even then: attachment
      "image/svg+xml",
      "application/octet-stream",
    ]) {
      expect(servingClassFor(mime)).toBe("attachment");
    }
  });
});

describe("document upload concurrency slots", () => {
  it("bounds concurrent uploads per user and releases exactly once", () => {
    const releases = Array.from(
      { length: DOCUMENT_UPLOAD_PER_USER_CONCURRENCY },
      () => acquireDocumentUploadSlot("slot-user"),
    );
    expect(releases.every(Boolean)).toBe(true);
    expect(acquireDocumentUploadSlot("slot-user")).toBeNull();

    releases[0]!();
    releases[0]!();
    const replacement = acquireDocumentUploadSlot("slot-user");
    expect(replacement).not.toBeNull();

    replacement!();
    for (const release of releases.slice(1)) release!();
  });

  it("bounds total concurrent uploads across different users", () => {
    const releases = Array.from(
      { length: DOCUMENT_UPLOAD_GLOBAL_CONCURRENCY },
      (_, index) => acquireDocumentUploadSlot(`global-slot-user-${index}`),
    );
    expect(releases.every(Boolean)).toBe(true);
    expect(acquireDocumentUploadSlot("global-slot-overflow")).toBeNull();

    for (const release of releases) release!();
  });
});

describe("resolveDocumentLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the defaults with no settings row and no override", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    await expect(resolveDocumentLimits("u1")).resolves.toEqual({
      maxFileBytes: DOCUMENT_DEFAULT_MAX_FILE_BYTES,
      quotaBytes: DOCUMENT_DEFAULT_QUOTA_BYTES,
    });
  });

  it("clamps the per-file cap to the hard 100 MiB ceiling", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      documentMaxFileBytes: 999_999_999_999,
      documentQuotaBytes: BigInt(DOCUMENT_DEFAULT_QUOTA_BYTES),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const limits = await resolveDocumentLimits("u1");
    expect(limits.maxFileBytes).toBe(DOCUMENT_HARD_MAX_FILE_BYTES);
  });

  it("prefers the per-user quota override over the instance default", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      documentMaxFileBytes: 26_214_400,
      documentQuotaBytes: BigInt(2_000_000_000),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentQuotaBytes: BigInt(50_000_000),
    } as never);
    const limits = await resolveDocumentLimits("u1");
    expect(limits.quotaBytes).toBe(50_000_000);
  });

  it("uses the instance quota when the user carries no override", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      documentMaxFileBytes: 26_214_400,
      documentQuotaBytes: BigInt(2_000_000_000),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentQuotaBytes: null,
    } as never);
    const limits = await resolveDocumentLimits("u1");
    expect(limits.quotaBytes).toBe(2_000_000_000);
  });
});
