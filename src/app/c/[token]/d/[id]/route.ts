/**
 * v1.28 (document vault, Phase 3) — public share-scoped document serve route.
 *
 * The recipient of a clinician share link views/downloads a shared document
 * through this path. It is the share analogue of the owner-only
 * `/api/documents/inbound/[id]/original` route, and it re-implements that
 * route's serving discipline verbatim — but its ONLY credential is the raw
 * `hls_` share token in the URL path. It never calls `requireAuth`, never reads
 * a session, and never trusts a `userId` from the wire.
 *
 * Trust boundary (mirrors `/c/[token]/page.tsx`):
 *   1. Resolve the live-gate state (no counter bump). A malformed / unknown /
 *      revoked / expired token → the same flat 404 the page returns.
 *   2. If the link is passphrase-protected, require the short-lived unlock
 *      cookie — the SAME token-scoped cookie (`path=/c/<token>`) the page
 *      checks. This route lives UNDER that path so the browser sends it; a
 *      recipient who never unlocked the record cannot pull a blob.
 *   3. Rate-limit per link (leaked-token fetch-storm backstop) BEFORE any read.
 *   4. Resolve the full share context (owner id + frozen scope). This is the
 *      one place revocation/expiry are re-checked and the access counters are
 *      bumped — ALWAYS before any decrypt.
 *   5. Confine to the frozen set: serve ONLY a document id present in this
 *      link's `ClinicianShareLinkDocument` rows, owner-scoped and live. A
 *      guessed / foreign / deleted id → flat 404.
 *
 * Serving posture IS the security boundary (identical to the owner route):
 * Class A (PDF/JPEG/PNG/WebP/GIF) inline with its true type; everything else
 * as `application/octet-stream` + `attachment` + `nosniff`. HTML/SVG were
 * never storable (upload deny-list), so nothing served inline can script. The
 * response CSP (`default-src 'none'; frame-ancestors 'self'`) is owned by the
 * proxy's share-serve carve-out, not this route.
 *
 * EXIF/XMP/GPS is stripped from JPEG/PNG/WebP on egress (never at rest) so the
 * recipient does not inadvertently receive the owner's camera metadata; other
 * types pass through (documented limit).
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { stripImageMetadata } from "@/lib/clinician-share/exif-strip";
import {
  resolveShareGateState,
  resolveShareToken,
} from "@/lib/clinician-share/resolve-share-token";
import {
  unlockCookieName,
  verifyUnlockValue,
} from "@/lib/clinician-share/unlock-cookie";
import { prisma } from "@/lib/db";
import { decryptDocumentContent } from "@/lib/documents/store";
import { servingClassFor } from "@/lib/documents/upload-policy";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

type RouteParams = { params: Promise<{ token: string; id: string }> };

export const dynamic = "force-dynamic";

/**
 * Per-link serve ceiling. A leaked live token could otherwise be used to fetch
 * the frozen set in a tight loop; a generous but bounded per-link limit is the
 * backstop (the link is already possession-gated + expiring + passphrase-gated).
 */
const SHARE_SERVE_LIMIT_PER_HOUR = 300;
const SHARE_SERVE_WINDOW_MS = 60 * 60 * 1000;

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

/** Percent-encode for an RFC 5987 `filename*` parameter. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a header-safe filename: strip control chars (CR/LF header injection),
 * quotes, and path separators, cap the length, and fall back to a generated
 * name when nothing usable remains.
 */
function safeDownloadName(
  filename: string | null,
  id: string,
  mimeType: string,
): string {
  const ext = MIME_EXTENSION[mimeType] ?? "bin";
  const cleaned = (filename ?? "")
    .replace(/[\u0000-\u001f"\\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : `document-${id}.${ext}`;
}

/** One blunt 404 for every miss class — a probe distinguishes nothing. */
function notFound() {
  return apiError("Not found", 404, {
    errorCode: "share-link.document.notFound",
  });
}

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { token, id } = await params;
    annotate({ action: { name: "share-link.document.serve" } });

    // 1. Live-gate check first (no counter bump). Malformed / unknown /
    //    revoked / expired all collapse to the same flat 404.
    const gate = await resolveShareGateState(token);
    if (!gate) return notFound();

    // 2. Passphrase gate: a protected link serves nothing until the recipient
    //    holds the short-lived, token-scoped unlock cookie. This route lives
    //    under `/c/<token>` so the browser sends that cookie automatically.
    if (gate.passphraseHash !== null) {
      const cookieStore = await cookies();
      const unlockValue = cookieStore.get(
        unlockCookieName(gate.tokenHash),
      )?.value;
      if (!verifyUnlockValue(unlockValue, gate.tokenHash)) {
        return notFound();
      }
    }

    // 3. Per-link rate limit BEFORE any decrypt (leaked-token fetch-storm
    //    backstop). Keyed on the resolved token hash so it is per-link.
    const rl = await checkRateLimit(
      `share-documents:${gate.tokenHash}`,
      SHARE_SERVE_LIMIT_PER_HOUR,
      SHARE_SERVE_WINDOW_MS,
    );
    if (!rl.allowed) {
      const response = apiError("Too many requests. Try again later.", 429, {
        errorCode: "share-link.document.rateLimited",
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    // 4. Resolve the full share context (owner id + frozen scope). Revocation
    //    and expiry are re-enforced here — ALWAYS before any decrypt — and the
    //    access counters are bumped fire-and-forget.
    const context = await resolveShareToken(token);
    if (!context) return notFound();
    // The owner switched the documents module off: no document leaves, the
    // same answer as an unknown one.
    if (!(await isModuleEnabled(context.ownerUserId, "inboundDocuments"))) {
      return notFound();
    }

    // 5. Confine to the frozen set: the document must be a member of THIS
    //    link, owned by the link's owner, and live. The composite lookup ties
    //    the id to the token; a guessed / foreign id finds no membership row.
    const membership = await prisma.clinicianShareLinkDocument.findUnique({
      where: {
        shareLinkId_documentId: {
          shareLinkId: context.shareLinkId,
          documentId: id,
        },
      },
      select: {
        document: {
          select: {
            id: true,
            userId: true,
            filename: true,
            mimeType: true,
            contentEncrypted: true,
            contentCodec: true,
            deletedAt: true,
          },
        },
      },
    });
    const document = membership?.document;
    // Defence in depth: the membership already binds an owner-checked id, but
    // re-assert ownership + liveness so a soft-deleted document (the cascade
    // only fires on HARD delete) can never be served.
    if (
      !document ||
      document.userId !== context.ownerUserId ||
      document.deletedAt !== null
    ) {
      return notFound();
    }

    let bytes: Buffer;
    try {
      bytes = decryptDocumentContent(
        document.contentEncrypted,
        document.contentCodec,
      );
    } catch {
      // Fail closed — never fall back to the raw ciphertext.
      annotate({
        action: { name: "share-link.document.decryptFailed" },
        meta: { shareLinkId: context.shareLinkId, documentId: document.id },
      });
      return apiError("Could not read the stored document", 500, {
        errorCode: "share-link.document.decryptFailed",
      });
    }

    // EXIF/XMP/GPS strip on egress for raster images (JPEG/PNG/WebP); other
    // types pass through unchanged. The stored original is untouched.
    const served = stripImageMetadata(bytes, document.mimeType);

    const servingClass = servingClassFor(document.mimeType);
    const downloadName = safeDownloadName(
      document.filename,
      document.id,
      document.mimeType,
    );
    const asciiName = downloadName.replace(/[^ -~]/g, "_");
    const dispositionType = servingClass === "inline" ? "inline" : "attachment";
    const disposition = `${dispositionType}; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(downloadName)}`;

    annotate({
      action: { name: "share-link.document.get" },
      meta: {
        shareLinkId: context.shareLinkId,
        documentId: document.id,
        mimeType: document.mimeType,
        bytes: served.byteLength,
        disposition: dispositionType,
        stripped: served.byteLength !== bytes.byteLength,
      },
    });

    const headers: Record<string, string> = {
      // Class B leaves the origin ONLY as an opaque download — the true stored
      // type is deliberately not surfaced on the wire.
      "Content-Type":
        servingClass === "inline"
          ? document.mimeType
          : "application/octet-stream",
      "Content-Length": String(served.byteLength),
      "Content-Disposition": disposition,
      // The disposition/type pair is authoritative — never MIME-sniffed.
      "X-Content-Type-Options": "nosniff",
      // Private PHI, served through a public token — never cache anywhere.
      "Cache-Control": "private, no-store",
      // No Content-Security-Policy here: the proxy's share-serve carve-out
      // owns it (`default-src 'none'; frame-ancestors 'self'`); a route-level
      // CSP would be silently overwritten by the middleware header pass.
    };

    return new NextResponse(served as unknown as BodyInit, {
      status: 200,
      headers,
    });
  },
);
