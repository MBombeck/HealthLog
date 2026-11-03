/**
 * v1.27.22 (Document vault P2) — shared plumbing for the optional AI actions on
 * a stored document (suggest / summary / index). Each of those routes runs the
 * same gauntlet the extract route pioneered — module gate → provider resolve →
 * consent → rate-limit → budget — and the same vision-input preparation
 * (decrypt the stored original, re-derive its MIME from the bytes, send a PDF
 * whole, rendered, or by its text layer). This module centralises the parts
 * that would otherwise be copy-pasted across the three routes; the per-route
 * budget + prompt stay local.
 */
import { Buffer } from "node:buffer";

import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  readPdfTextLayer,
  textLayerText,
} from "@/lib/documents/pdf-text-layer";
import { RASTER_MAX_PAGES, rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { decryptDocumentContent } from "@/lib/documents/store";
import type { VisionInput } from "@/lib/documents/vision-input";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import {
  checkRateLimit,
  rateLimitHeaders,
  refundRateLimit,
  type RateLimitResult,
} from "@/lib/rate-limit";

export type { VisionInput } from "@/lib/documents/vision-input";

/**
 * The document-AI actions (extract / suggest / summary / index) share one
 * per-user hourly egress bucket. The ceiling is operator-tunable via
 * `DOCUMENT_AI_LIMIT_PER_HOUR` (default 6, clamped to 1–1000 so a typo can
 * neither zero the surface out nor remove the cap entirely) — same posture as
 * `INSIGHTS_RATE_LIMIT_PER_HOUR` on the briefing route. Unset / non-numeric
 * falls back to the default.
 */
const DOCUMENT_AI_LIMIT_DEFAULT = 6;
const DOCUMENT_AI_LIMIT_MIN = 1;
const DOCUMENT_AI_LIMIT_MAX = 1000;

export function resolveDocumentAiLimitPerHour(): number {
  const raw = process.env.DOCUMENT_AI_LIMIT_PER_HOUR;
  if (!raw) return DOCUMENT_AI_LIMIT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DOCUMENT_AI_LIMIT_DEFAULT;
  return Math.min(
    DOCUMENT_AI_LIMIT_MAX,
    Math.max(DOCUMENT_AI_LIMIT_MIN, parsed),
  );
}

export const DOCUMENT_AI_WINDOW_MS = 60 * 60 * 1000;
/** The shared rate-limit bucket key prefix (identical to the extract route). */
export const DOCUMENT_AI_BUCKET = "documents-inbound";

/** Charge one slot of the shared per-user document-AI bucket. */
export async function checkDocumentAiRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    `${DOCUMENT_AI_BUCKET}:${userId}`,
    resolveDocumentAiLimitPerHour(),
    DOCUMENT_AI_WINDOW_MS,
  );
}

/**
 * Give a charged slot back when the request failed BEFORE the metered work
 * (provider dispatch, or the local index/echo work on the no-egress paths).
 * The bucket is charged early so a 429 stays cheap, but a slot must reflect
 * work actually performed — a malformed body, an unreadable original, or an
 * exhausted budget dispatched nothing and burns no allowance. Best-effort:
 * a failed refund never masks the response the caller is about to return.
 */
export async function refundDocumentAiSlot(userId: string): Promise<void> {
  try {
    await refundRateLimit(`${DOCUMENT_AI_BUCKET}:${userId}`);
  } catch {
    // The original (error) response matters more than the bookkeeping.
  }
}

/**
 * The shared 429 for the document-AI bucket. Carries the standard
 * `X-RateLimit-*` headers AND mirrors the reset instant into the error meta
 * (`retryAt`, ISO 8601) so the client can tell the user the ACTUAL wait —
 * the window is an hour, not "a few minutes".
 */
export function documentAiRateLimited(rl: RateLimitResult): Response {
  const response = apiError("Too many document AI requests this hour.", 429, {
    errorCode: "documents.inbound.rateLimited",
    retryAt: new Date(rl.resetAt).toISOString(),
  });
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}
/** Cap on a browser-OCR text body (mirrors the extract text mode). */
export const DOCUMENT_AI_TEXT_BODY_MAX_BYTES = 512 * 1024;

/**
 * v1.27.33 (Document vault P4 — chat about a document) — the per-user request-
 * rate bucket for the document chat. Layered in front of the daily AI budget:
 * the budget catches the cost dimension, this catches the request-rate one (a
 * tight loop or a stolen session). 20 / minute mirrors the Coach chat bucket —
 * well outside any interactive use.
 */
export const DOCUMENT_CHAT_BUCKET = "document-chat";
export const DOCUMENT_CHAT_LIMIT_PER_MINUTE = 20;
export const DOCUMENT_CHAT_WINDOW_MS = 60 * 1000;

/** A loaded, owner-scoped, live document row with its encrypted content. */
export interface LoadedDocument {
  id: string;
  kind: string;
  contentEncrypted: Uint8Array;
  contentCodec: string;
  mimeType: string;
  status: string;
  /**
   * The import asked for `aiRead=defer` (#1038). Automatic paths read the
   * document locally only while it is set.
   */
  aiReadDeferred: boolean;
}

/** Load one live, owner-scoped document with the columns the AI actions need. */
export async function loadOwnedDocument(
  userId: string,
  id: string,
): Promise<LoadedDocument | null> {
  return prisma.inboundDocument.findFirst({
    where: { id, userId, deletedAt: null },
    select: {
      id: true,
      kind: true,
      contentEncrypted: true,
      contentCodec: true,
      mimeType: true,
      status: true,
      aiReadDeferred: true,
    },
  });
}

/**
 * Decrypt the stored original, re-derive its MIME from the bytes (never trust
 * the stored label for a provider call), and split it into the images/documents
 * arrays a vision call takes. Fails closed on a decrypt error.
 *
 * PDF handling by provider capability:
 *   - `pdfSupported` (Anthropic) → native `document` block, highest fidelity.
 *   - otherwise (codex / any image-only-wire provider) → rasterize the pages to
 *     JPEG `input_image` parts so the provider can still read the PDF. Egress is
 *     already authorised upstream (the consent gate / the `documentsAutoAiRead`
 *     toggle) before this is reached. A PDF that will not render on a build
 *     that renders is `rasterFailed`.
 *   - #1311 — on a server that cannot render PDF pages at all, the PDF's text
 *     layer is read instead (`mode: "text"`); a scanned PDF, which has none, is
 *     `pdfRendererUnavailable`: only a provider that takes PDFs whole, or a
 *     photo of the pages, can be read there.
 *
 * Images (jpg/png/webp) flow straight to `input_image`, unchanged.
 */
export async function prepareVisionInput(
  document: LoadedDocument,
  pdfSupported: boolean,
  /**
   * The most pages a text-layer read takes. The default is the render cap, the
   * pages a vision read would have seen; the index reads as many pages as the
   * local text index does, so the index it writes is complete.
   */
  opts: { textLayerPages?: number } = {},
): Promise<VisionInput> {
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    return { ok: false, reason: "decryptFailed" };
  }

  const mime = detectOcrMimeType(buffer);
  if (!mime) return { ok: false, reason: "fileType" };

  if (mime === "application/pdf") {
    if (pdfSupported) {
      return {
        ok: true,
        mode: "vision",
        images: [],
        documents: [
          {
            mediaType: "application/pdf",
            dataBase64: buffer.toString("base64"),
          },
        ],
      };
    }
    // Non-Anthropic vision provider — render the PDF pages to images it can read.
    const raster = await rasterizePdf(buffer);
    if (raster.ok) {
      return { ok: true, mode: "vision", images: raster.images, documents: [] };
    }
    if (raster.reason === "busy" || raster.reason === "interrupted") {
      return { ok: false, reason: "readerBusy" };
    }
    // Refs #776 — a render failure on a capable build is a property of THIS
    // document; a build that cannot render at all is a property of the server.
    if (raster.reason !== "unsupported") {
      return { ok: false, reason: "rasterFailed" };
    }
    const read = await readPdfTextLayer(
      buffer,
      opts.textLayerPages ?? RASTER_MAX_PAGES,
      "documents.vision",
    );
    if (read.ok) {
      return {
        ok: true,
        mode: "text",
        text: textLayerText(read.layer),
      };
    }
    if (read.reason === "busy") return { ok: false, reason: "readerBusy" };
    return {
      ok: false,
      reason:
        read.reason === "none" ? "pdfRendererUnavailable" : "rasterFailed",
    };
  }

  return {
    ok: true,
    mode: "vision",
    images: [{ mediaType: mime, dataBase64: buffer.toString("base64") }],
    documents: [],
  };
}
