/**
 * Document-vault upload policy: the accept matrix, magic-byte sniffers, the
 * serving-class function, and the admin-tunable limits resolver.
 *
 * Three classes, closed deny-list, serving posture as the security boundary:
 *
 *   - Class A (inline): PDF, JPEG, PNG, WebP, GIF — browser-native passive
 *     formats the serve route renders `Content-Disposition: inline` (PDF
 *     additionally under a `Content-Security-Policy: sandbox` response
 *     header).
 *   - Class B (attachment-only): Office (OOXML + legacy CFB), text/CSV/RTF/
 *     Markdown, TIFF, HEIC/HEIF, XML/JSON — stored verbatim, served ONLY as
 *     `application/octet-stream` + `Content-Disposition: attachment` +
 *     `nosniff`. A misclassified Class B file therefore cannot execute in
 *     the app origin.
 *   - Deny: executables, scripts, HTML/XHTML/SVG (the only classes whose
 *     inline render executes script — zero medical-artefact value), generic
 *     archives / disk images, anything unidentifiable.
 *
 * The wire Content-Type is NEVER trusted anywhere — detection is magic-bytes
 * first, extension only where a container format is ambiguous (ZIP → OOXML,
 * CFB → legacy Office) or where no magic exists (plain-text formats). We
 * never parse, rewrite, or "sanitise" stored documents: the original is the
 * artefact; safety comes from what the serve route will and won't serve
 * inline.
 *
 * The labs OCR path (`src/lib/labs/ocr-upload.ts`) keeps its own 12 MiB cap
 * and narrow allowlist unchanged; this module only reuses its bounded-read
 * primitive at the route layer.
 */
import { detectAvatarMimeType } from "@/lib/avatar";
import { prisma } from "@/lib/db";

// ─── Limits (§3.3) ──────────────────────────────────────────────────────────

/** Default per-file cap: 25 MiB (a ~50-page 300-dpi scan PDF, any phone photo). */
export const DOCUMENT_DEFAULT_MAX_FILE_BYTES = 26_214_400;

/**
 * Hard server ceiling for the admin-tunable per-file cap: 100 MiB. Single-shot
 * AES-256-GCM + bounded in-memory reads are load-bearing; past this the
 * architecture (chunking, streaming crypto) would have to change, so the
 * setting cannot be pushed there.
 */
export const DOCUMENT_HARD_MAX_FILE_BYTES = 104_857_600;

/** Default per-user quota: 1 GiB. */
export const DOCUMENT_DEFAULT_QUOTA_BYTES = 1_073_741_824;

/** In-memory admission bounds for body accumulation in one server process. */
export const DOCUMENT_UPLOAD_GLOBAL_CONCURRENCY = 4;
export const DOCUMENT_UPLOAD_PER_USER_CONCURRENCY = 2;

let activeDocumentUploads = 0;
const activeDocumentUploadsByUser = new Map<string, number>();

/**
 * Reserve one process-local document upload slot. The returned release is
 * idempotent so a defensive second cleanup cannot corrupt the counters.
 */
export function acquireDocumentUploadSlot(userId: string): (() => void) | null {
  const activeForUser = activeDocumentUploadsByUser.get(userId) ?? 0;
  if (
    activeDocumentUploads >= DOCUMENT_UPLOAD_GLOBAL_CONCURRENCY ||
    activeForUser >= DOCUMENT_UPLOAD_PER_USER_CONCURRENCY
  ) {
    return null;
  }

  activeDocumentUploads += 1;
  activeDocumentUploadsByUser.set(userId, activeForUser + 1);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    activeDocumentUploads -= 1;
    const remainingForUser = (activeDocumentUploadsByUser.get(userId) ?? 1) - 1;
    if (remainingForUser === 0) {
      activeDocumentUploadsByUser.delete(userId);
    } else {
      activeDocumentUploadsByUser.set(userId, remainingForUser);
    }
  };
}

export interface DocumentLimits {
  /** Per-file upload cap in bytes (admin-tunable, clamped to the ceiling). */
  maxFileBytes: number;
  /** Per-user storage quota in bytes (user override ?? instance default). */
  quotaBytes: number;
}

/**
 * Resolve the effective limits for a user: `AppSettings.documentMaxFileBytes`
 * clamped to the hard ceiling, and quota = `User.documentQuotaBytes` ??
 * `AppSettings.documentQuotaBytes`. Missing rows fall back to the defaults.
 */
export async function resolveDocumentLimits(
  userId: string,
): Promise<DocumentLimits> {
  const [settings, user] = await Promise.all([
    prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { documentMaxFileBytes: true, documentQuotaBytes: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { documentQuotaBytes: true },
    }),
  ]);
  const rawMax =
    settings?.documentMaxFileBytes ?? DOCUMENT_DEFAULT_MAX_FILE_BYTES;
  const maxFileBytes = Math.min(
    Math.max(rawMax, 1),
    DOCUMENT_HARD_MAX_FILE_BYTES,
  );
  const quotaBytes = Number(
    user?.documentQuotaBytes ??
      settings?.documentQuotaBytes ??
      DOCUMENT_DEFAULT_QUOTA_BYTES,
  );
  return { maxFileBytes, quotaBytes };
}

// ─── Accept matrix (§3.1) ───────────────────────────────────────────────────

export type DocumentServingClass = "inline" | "attachment";

/** Class A — browser-native passive formats served inline. */
const CLASS_A_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * The one source of truth the serve route uses: Class A renders inline with
 * its true Content-Type; EVERYTHING else stored leaves the origin only as an
 * opaque attachment download.
 */
export function servingClassFor(mimeType: string): DocumentServingClass {
  return CLASS_A_MIMES.has(mimeType) ? "inline" : "attachment";
}

/**
 * Extensions the upload UI's `accept` attribute mirrors (Class A + B minus
 * HEIC — its exclusion makes the iOS picker auto-transcode camera photos to
 * JPEG so the common path stays inline-previewable). Server-side policy
 * remains the enforcement; this list is advisory for pickers.
 */
export const DOCUMENT_ACCEPTED_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".docx",
  ".xlsx",
  ".pptx",
  ".doc",
  ".xls",
  ".ppt",
  ".txt",
  ".md",
  ".csv",
  ".rtf",
  ".tif",
  ".tiff",
  ".xml",
  ".json",
];

/**
 * Extension deny-list: executables and scripts (regardless of content),
 * HTML/XHTML/SVG (inline render executes script), generic archives and disk
 * images. A ZIP container is allowed ONLY under an Office extension.
 */
const DENY_EXTENSIONS: ReadonlySet<string> = new Set([
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
]);

/** OOXML extensions → stored MIME (ZIP magic + Office extension required). */
const OOXML_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
]);

/** Legacy Office extensions → stored MIME (CFB magic + extension required). */
const CFB_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".doc", "application/msword"],
  [".xls", "application/vnd.ms-excel"],
  [".ppt", "application/vnd.ms-powerpoint"],
]);

/** Text-format extensions → stored MIME (heuristic-gated, no magic bytes). */
const TEXT_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".txt", "text/plain"],
  [".md", "text/plain"],
  [".csv", "text/csv"],
  [".xml", "application/xml"],
  [".json", "application/json"],
]);

/** Lower-cased extension (with dot) of a filename, or "" when absent. */
function extensionOf(filename: string | null | undefined): string {
  if (!filename) return "";
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return "";
  return filename.slice(idx).toLowerCase();
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/** `%PDF-` */
function isPdf(buffer: Buffer): boolean {
  return startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

/** `GIF87a` / `GIF89a` */
function isGif(buffer: Buffer): boolean {
  return (
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  );
}

/** ZIP local-file header `PK\x03\x04` (OOXML containers; also generic ZIPs). */
function isZip(buffer: Buffer): boolean {
  return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
}

/** Compound File Binary (legacy Office) `D0 CF 11 E0 A1 B1 1A E1`. */
function isCfb(buffer: Buffer): boolean {
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

/** RTF `{\rtf` */
function isRtf(buffer: Buffer): boolean {
  return startsWith(buffer, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
}

/** TIFF `II*\0` (little-endian) or `MM\0*` (big-endian). */
function isTiff(buffer: Buffer): boolean {
  return (
    startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  );
}

/** HEIC/HEIF — ISO-BMFF `ftyp` box with a HEIF-family brand. */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "hevc",
  "mif1",
  "msf1",
]);

function isHeif(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const major = buffer.toString("ascii", 8, 12).toLowerCase();
  if (HEIF_BRANDS.has(major)) return true;
  // Compatible-brand scan inside the ftyp box (bounded by the box length).
  const boxLen = Math.min(buffer.readUInt32BE(0), buffer.length);
  for (let off = 16; off + 4 <= boxLen; off += 4) {
    const brand = buffer.toString("ascii", off, off + 4).toLowerCase();
    if (HEIF_BRANDS.has(brand)) return true;
  }
  return false;
}

/** Executable magic: MZ (PE), ELF, Mach-O (32/64, both endians, fat). */
function isExecutable(buffer: Buffer): boolean {
  if (startsWith(buffer, [0x4d, 0x5a])) return true; // MZ
  if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  const machO = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ] as const;
  return machO.some((m) => startsWith(buffer, m));
}

/**
 * Plain-text heuristic for the extension-gated text formats: no NUL byte in
 * the first 8 KiB and the sample decodes as UTF-8 or Latin-1 (any byte
 * sequence is valid Latin-1, so the effective gate is "no NUL" — a binary
 * payload smuggled under `.txt` almost always carries NULs; if one does not,
 * it is still stored Class B and can only ever leave as an opaque download).
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, 8192);
  return !sample.includes(0x00);
}

export interface DetectedDocumentType {
  /** The MIME type the row stores (sniffed, never the wire Content-Type). */
  mimeType: string;
  /** Derived serving class (same as `servingClassFor(mimeType)`). */
  servingClass: DocumentServingClass;
}

/**
 * Classify an upload from its bytes (+ the claimed filename, used only where
 * a container/text format needs an extension gate). Returns null for every
 * deny case: executables, script/markup extensions, generic archives, ZIPs
 * without an Office extension, and anything unidentifiable.
 */
export function detectDocumentType(
  buffer: Buffer,
  filename: string | null | undefined,
): DetectedDocumentType | null {
  const ext = extensionOf(filename);

  // Hard denies first: content-level executables, then the extension
  // deny-list (an .exe named payload is refused even if its bytes look like
  // text; HTML/SVG are refused regardless of content).
  if (isExecutable(buffer)) return null;
  if (DENY_EXTENSIONS.has(ext)) return null;

  // ── Class A (magic bytes only — extension is irrelevant) ──
  if (isPdf(buffer)) {
    return { mimeType: "application/pdf", servingClass: "inline" };
  }
  if (isGif(buffer)) {
    return { mimeType: "image/gif", servingClass: "inline" };
  }
  const image = detectAvatarMimeType(buffer);
  if (image) {
    return { mimeType: image, servingClass: "inline" };
  }

  // ── Class B (magic where it exists; containers need the extension) ──
  if (isZip(buffer)) {
    // A ZIP container is acceptable ONLY as an OOXML Office file; a generic
    // archive (any other extension, incl. none) is denied.
    const ooxml = OOXML_BY_EXTENSION.get(ext);
    return ooxml ? { mimeType: ooxml, servingClass: "attachment" } : null;
  }
  if (isCfb(buffer)) {
    const legacy = CFB_BY_EXTENSION.get(ext);
    return legacy ? { mimeType: legacy, servingClass: "attachment" } : null;
  }
  if (isRtf(buffer)) {
    return { mimeType: "application/rtf", servingClass: "attachment" };
  }
  if (isTiff(buffer)) {
    return { mimeType: "image/tiff", servingClass: "attachment" };
  }
  if (isHeif(buffer)) {
    return { mimeType: "image/heic", servingClass: "attachment" };
  }

  // ── Text formats (extension + heuristic; no magic bytes exist) ──
  const text = TEXT_BY_EXTENSION.get(ext);
  if (text && looksLikeText(buffer)) {
    return { mimeType: text, servingClass: "attachment" };
  }

  // Unidentifiable → deny.
  return null;
}
