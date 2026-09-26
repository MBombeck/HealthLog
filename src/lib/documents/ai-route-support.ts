/**
 * v1.27.22 (Document vault P2) — shared plumbing for the optional AI actions on
 * a stored document (suggest / summary / index). Each of those routes runs the
 * same gauntlet the extract route pioneered — module gate → provider resolve →
 * consent → rate-limit → budget — and the same vision-input preparation
 * (decrypt the stored original, re-derive its MIME from the bytes, gate PDF on
 * the Anthropic path). This module centralises the parts that would otherwise be
 * copy-pasted across the three routes; the per-route budget + prompt stay local.
 */
import { Buffer } from "node:buffer";

import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { decryptDocumentContent } from "@/lib/documents/store";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import {
  checkRateLimit,
  rateLimitHeaders,
  refundRateLimit,
  type RateLimitResult,
} from "@/lib/rate-limit";

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

/** The provider-ready vision payload derived from a stored document. */
export type VisionInput =
  | {
      ok: true;
      images: {
        mediaType: "image/jpeg" | "image/png" | "image/webp";
        dataBase64: string;
      }[];
      documents: { mediaType: "application/pdf"; dataBase64: string }[];
    }
  | {
      ok: false;
      // Refs #776 — `rasterFailed` (this PDF would not render on a raster-
      // capable build) is distinct from `pdfNeedsAnthropic` (this build /
      // provider cannot take a PDF at all): they need different fixes, so
      // they must not share a label.
      reason:
        "decryptFailed" | "fileType" | "pdfNeedsAnthropic" | "rasterFailed";
    };

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
 *     toggle) before this is reached. If rasterization fails (malformed /
 *     encrypted / unrenderable), fall back to the shipped `pdfNeedsAnthropic`
 *     outcome so the job degrades to the local text-layer path and an
 *     interactive route surfaces the same actionable error.
 *
 * Images (jpg/png/webp) flow straight to `input_image`, unchanged.
 */
export async function prepareVisionInput(
  document: LoadedDocument,
  pdfSupported: boolean,
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
      return { ok: true, images: raster.images, documents: [] };
    }
    // Refs #776 — a build that cannot rasterize at all is a capability gap a
    // PDF-native (Anthropic) provider would cover; a render failure on a
    // capable build is a property of THIS document. Report them apart.
    return {
      ok: false,
      reason:
        raster.reason === "unsupported" ? "pdfNeedsAnthropic" : "rasterFailed",
    };
  }

  return {
    ok: true,
    images: [{ mediaType: mime, dataBase64: buffer.toString("base64") }],
    documents: [],
  };
}
