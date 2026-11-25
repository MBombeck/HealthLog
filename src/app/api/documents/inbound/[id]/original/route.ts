/**
 * Document vault: view / download the original uploaded document.
 *
 * The raw document is stored encrypted at rest
 * (`InboundDocument.contentEncrypted`, AES-256-GCM, codec per row). This
 * route is the ONLY path that decrypts and serves it. Owner-scoped +
 * module-gated; the bytes are PHI: never logged, never served cross-user,
 * fail-closed on a decrypt error.
 *
 * Serving posture IS the security boundary (upload policy §N1): the serving
 * class derives from the stored MIME type via `servingClassFor` —
 *
 *   - inline (Class A: PDF/JPEG/PNG/WebP/GIF): true Content-Type,
 *     `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`,
 *     `Cache-Control: private, no-store`.
 *   - attachment (Class B: Office/text/TIFF/HEIC/XML/JSON): ALWAYS
 *     `Content-Disposition: attachment` with `Content-Type:
 *     application/octet-stream` + `nosniff` — never inline, regardless of
 *     the stored type, so a misclassified file cannot execute in-origin.
 *
 * The response CSP is owned by the proxy, not this route: `src/proxy.ts`
 * carves out exactly this path with `default-src 'none'; frame-ancestors
 * 'self'` (middleware headers win over route headers, so anything set here
 * would be dead weight). Deliberately no `sandbox` directive anywhere —
 * Chromium force-downloads PDFs framed in sandboxed documents instead of
 * rendering them, which would break the inline preview.
 * `src/__tests__/proxy-document-serve-framing.test.ts` pins that posture.
 */
import { NextResponse } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { decryptDocumentContent } from "@/lib/documents/store";
import { servingClassFor } from "@/lib/documents/upload-policy";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ownValue } from "@/lib/own-key";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/**
 * Decrypting + serving an original is CPU work on PHI. A generous per-user
 * ceiling is a backstop against self-DoS only (the route is owner-scoped, so
 * there is no cross-user abuse vector).
 */
const ORIGINAL_READ_LIMIT_PER_HOUR = 240;
const ORIGINAL_READ_WINDOW_MS = 60 * 60 * 1000;

/** Extension fallback when the stored filename is absent / unusable. */
const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tif",
  "image/heic": "heic",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/rtf": "rtf",
  "application/xml": "xml",
  "application/json": "json",
};

/**
 * Percent-encode a UTF-8 string for an RFC 5987 `filename*` parameter. Builds
 * on `encodeURIComponent` and additionally escapes the characters it leaves but
 * RFC 5987's `attr-char` set forbids (`' ( ) *`).
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a header-safe filename. Strips control characters (incl. CR/LF,
 * the header-injection vector), quotes, and path separators (path traversal),
 * caps the length, and falls back to a generated name keyed by the document
 * id + MIME type when nothing usable remains.
 */
function safeDownloadName(
  filename: string | null,
  id: string,
  mimeType: string,
): string {
  const ext = ownValue(MIME_EXTENSION, mimeType) ?? "bin";
  const cleaned = (filename ?? "")
    // Strip control chars (incl. CR/LF — header injection), quotes, and path
    // separators (path traversal) before the value reaches the header.
    .replace(/[\u0000-\u001f"\\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : `document-${id}.${ext}`;
}

/**
 * v1.36.x — delegable, and the read the rest of the vault exists to reach: a
 * caregiver looking at a discharge letter needs the letter, not its filing
 * card. Same file, same 1:1 owner-scoped lookup, resolved against the record.
 *
 * The bucket keys on the ACTOR for the reason the thumbnail's does — this one
 * decrypts a whole document per call, so it is the tighter of the two.
 */
export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("read", "documents");

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `documents-original:${actor.id}`,
      ORIGINAL_READ_LIMIT_PER_HOUR,
      ORIGINAL_READ_WINDOW_MS,
    );
    if (!rl.allowed) {
      const response = apiError("Too many requests. Try again later.", 429, {
        errorCode: "documents.inbound.rateLimited",
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      // Owner-scoped: the userId narrows the row so a cuid guess cannot reach
      // another user's document. A cookie session and a Bearer token both
      // resolve through requireAuth(); neither can cross the userId boundary.
      where: { id, userId: user.id, deletedAt: null },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        contentEncrypted: true,
        contentCodec: true,
      },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    let bytes: Buffer;
    try {
      bytes = decryptDocumentContent(
        document.contentEncrypted,
        document.contentCodec,
      );
    } catch {
      // Fail closed — never fall back to the raw ciphertext. The error reason
      // (bad / missing key id, unknown codec) is logged by the annotation,
      // never the bytes.
      annotate({
        action: { name: "documents.inbound.original.decryptFailed" },
        meta: { documentId: document.id },
      });
      return apiError("Could not read the stored document", 500, {
        errorCode: "documents.inbound.decryptFailed",
      });
    }

    const servingClass = servingClassFor(document.mimeType);
    const downloadName = safeDownloadName(
      document.filename,
      document.id,
      document.mimeType,
    );
    // ASCII fallback for the bare `filename=` (replace any non-ASCII byte)
    // plus an RFC 5987 `filename*` that carries the real UTF-8 name to
    // compliant clients.
    const asciiName = downloadName.replace(/[^ -~]/g, "_");
    const dispositionType = servingClass === "inline" ? "inline" : "attachment";
    const disposition = `${dispositionType}; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(downloadName)}`;

    annotate({
      action: { name: "documents.inbound.original.get" },
      meta: {
        documentId: document.id,
        mimeType: document.mimeType,
        bytes: bytes.byteLength,
        disposition: dispositionType,
      },
    });

    const headers: Record<string, string> = {
      // Class B leaves the origin ONLY as an opaque download — the true
      // stored type is deliberately not surfaced on the wire.
      "Content-Type":
        servingClass === "inline"
          ? document.mimeType
          : "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": disposition,
      // The disposition/type pair is authoritative — never MIME-sniffed.
      "X-Content-Type-Options": "nosniff",
      // Private PHI — never cache in a shared / disk cache.
      "Cache-Control": "private, no-store",
      // No Content-Security-Policy here: the proxy's serve-route carve-out
      // owns it (`default-src 'none'; frame-ancestors 'self'`, no sandbox —
      // Chromium force-downloads sandboxed PDFs). A route-level CSP would be
      // silently overwritten by the middleware header pass.
    };

    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers,
    });
  },
);
