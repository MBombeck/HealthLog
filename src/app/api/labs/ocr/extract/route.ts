/**
 * v1.18.9 / v1.18.10 — POST /api/labs/ocr/extract
 *
 * Read-only (NOT idempotent) extraction of a paper lab report into STRUCTURED
 * proposed rows for the mandatory human-review screen. Nothing is written to
 * the database here; the raw upload is never persisted or logged.
 *
 * Two modes, dispatched on the request content-type:
 *
 *   - VISION (multipart/form-data): a photo / PDF is uploaded and run through
 *     the user's vision-capable provider. The image transits server memory
 *     ephemerally.
 *   - TEXT (application/json, v1.18.10): the browser OCR's the image
 *     (tesseract.js) and POSTs only the extracted TEXT here. Any configured
 *     provider can structure it — no vision required — so a text-only provider
 *     (ChatGPT-OAuth/Codex, a text-only model) reaches the SAME review/commit
 *     flow. The raw image never reaches the server. Gated by the opt-in
 *     `labsLocalOcrEnabled` preference.
 *
 * Guards mirror the Coach's discipline in both modes:
 *   requireAuth → resolve provider → assertConsentForChain → rate-limit (6/h)
 *   → reserveBudget → run extraction → reconcile budget.
 *
 * Extracted text is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside the document — the human review step is the safety
 * boundary, and the commit route is the only write path.
 */
import { Buffer } from "node:buffer";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { prisma } from "@/lib/db";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import {
  resolveTextProvider,
  resolveVisionProvider,
} from "@/lib/labs/ocr-capability";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";
import {
  BodyTooLargeError,
  detectOcrMimeType,
  OCR_MAX_BYTES,
  readBoundedBody,
} from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ocrTextExtractSchema } from "@/lib/validations/labs-ocr";

export const dynamic = "force-dynamic";

/** 6 extraction calls per hour — they are expensive (vision) / metered (text). */
const EXTRACT_LIMIT_PER_HOUR = 6;
const EXTRACT_WINDOW_MS = 60 * 60 * 1000;

/** OCR'd text is bounded in the schema; cap the JSON body proportionally. */
const TEXT_BODY_MAX_BYTES = 512 * 1024;

function providerFailureMeta(error: unknown, mode?: "text") {
  const err = error as {
    httpStatus?: unknown;
    model?: unknown;
    bodyExcerpt?: unknown;
  };
  return {
    reason: "provider_error",
    ...(mode ? { mode } : {}),
    ...(typeof err.httpStatus === "number"
      ? { upstreamStatus: err.httpStatus }
      : {}),
    ...(typeof err.model === "string" ? { model: err.model } : {}),
    ...(typeof err.bodyExcerpt === "string"
      ? { upstreamError: err.bodyExcerpt }
      : {}),
  };
}

export const POST = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  // Dispatch on the body shape: a JSON body is the local-OCR text mode; a
  // multipart body is the native-vision image/PDF mode.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return handleTextExtract(request, user.id);
  }
  return handleVisionExtract(request, user.id);
});

/**
 * TEXT mode (v1.18.10) — structure in-browser-OCR'd text via any configured
 * provider. No image bytes reach the server; the raw image stayed on-device.
 */
async function handleTextExtract(
  request: Request,
  userId: string,
): Promise<Response> {
  // The opt-in toggle must be on. Re-checked server-side so the surface cannot
  // be reached by a client that ignored the capability probe.
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { labsLocalOcrEnabled: true },
  });
  if (!row?.labsLocalOcrEnabled) {
    annotate({ action: { name: "labs.ocr.providerUnsupported" } });
    return apiError("Local OCR is not enabled", 422, {
      errorCode: "labs.ocr.localOcrDisabled",
    });
  }

  // Any configured provider can structure the text.
  const { chain, pick } = await resolveTextProvider(userId);
  if (!pick) {
    annotate({
      action: { name: "labs.ocr.providerUnsupported" },
      meta: { chainLength: chain.length, mode: "text" },
    });
    return apiError("No AI provider is configured", 422, {
      errorCode: "labs.ocr.providerUnsupported",
    });
  }

  // Consent gate — only the server-managed key trips this; BYOK / local / codex
  // egress is the user's own act (the toggle is the consent for local OCR).
  await assertConsentForChain({ userId, chain, surface: "insights" });

  const rl = await checkRateLimit(
    `labs-ocr:${userId}`,
    EXTRACT_LIMIT_PER_HOUR,
    EXTRACT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "labs.ocr.rateLimited" } });
    const response = apiError("Too many scans. Try again later.", 429, {
      errorCode: "labs.ocr.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: TEXT_BODY_MAX_BYTES,
  });
  if (jsonError) return jsonError;

  const parsed = ocrTextExtractSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid OCR text payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "labs.ocr.extractFailed",
      },
    );
  }

  // Budget — text mode is a plain text→JSON structuring pass, far cheaper than
  // a vision call, so it reserves the proportionate text ceiling rather than
  // the vision budget. Over-charging the vision rate for a text call would
  // exhaust the day budget against spend that never happened.
  // v1.21.0 (F1) — the operator-cost cap applies only when the picked provider
  // egresses on the operator's own key; a BYOK / Codex / local pick runs on the
  // user's own plan and gets the generous user-plan ceiling.
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtractText.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "labs.ocr.budget.exceeded" },
      meta: { totalAfter: reservation.totalAfter, mode: "text" },
    });
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "labs.ocr.budgetExceeded",
    });
  }

  try {
    const result = await runOcrExtraction({
      userId,
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ocrText: parsed.data.text,
    });
    // A clean structuring pass spent (at most) the reservation; the provider
    // already billed it, so reconcile against the reserved estimate.
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
      0,
      { servedBy: pick.entry.providerType, reservedOwner: reservation.owner },
    );
    return apiSuccess(result);
  } catch (err) {
    // A failed structuring call produced no usable rows; mirror the vision
    // path and refund the reservation in full rather than charging it.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    if (err instanceof OcrExtractError) {
      return apiError("Couldn't read the report. Try a clearer photo.", 422, {
        errorCode: "labs.ocr.extractFailed",
      });
    }
    annotate({
      action: { name: "labs.ocr.extractFailed" },
      meta: providerFailureMeta(err, "text"),
    });
    return apiError(
      "The configured AI provider could not process this report. Check the provider configuration and retry.",
      502,
      { errorCode: "labs.ocr.extractFailed" },
    );
  }
}

/**
 * VISION mode — run a multipart photo / PDF through the user's vision-capable
 * provider. The image transits server memory ephemerally and is never stored.
 */
async function handleVisionExtract(
  request: Request,
  userId: string,
): Promise<Response> {
  // 1. Resolve a vision-capable provider. 422 when none is configured.
  const { chain, pick } = await resolveVisionProvider(userId);
  if (!pick) {
    annotate({
      action: { name: "labs.ocr.providerUnsupported" },
      meta: { chainLength: chain.length },
    });
    return apiError("No vision-capable AI provider is configured", 422, {
      errorCode: "labs.ocr.providerUnsupported",
    });
  }

  // 2. Consent gate — server-managed egress of health data requires a receipt.
  await assertConsentForChain({ userId, chain, surface: "insights" });

  // 3. Rate-limit (vision calls are costly).
  const rl = await checkRateLimit(
    `labs-ocr:${userId}`,
    EXTRACT_LIMIT_PER_HOUR,
    EXTRACT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "labs.ocr.rateLimited" } });
    const response = apiError("Too many scans. Try again later.", 429, {
      errorCode: "labs.ocr.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // 4. Reserve the day's budget BEFORE the provider call (atomic, TOCTOU-safe).
  // v1.21.0 (F1) — the operator-cost cap applies only when the picked vision
  // provider egresses on the operator's own key; a BYOK / Codex pick runs on
  // the user's own plan and gets the generous user-plan ceiling.
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtract.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "labs.ocr.budget.exceeded" },
      meta: { totalAfter: reservation.totalAfter },
    });
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "labs.ocr.budgetExceeded",
    });
  }

  // From here on a failure must refund the reservation.
  try {
    // 5. Pre-flight on the declared content length, then a stream-level
    // bounded read (a chunked upload omits Content-Length and would otherwise
    // buffer the whole body before any size check).
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > OCR_MAX_BYTES) {
      annotate({
        action: { name: "labs.ocr.fileRejected" },
        meta: { reason: "content_length_exceeded" },
      });
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      });
      return apiError("File is too large (max 12 MB).", 413, {
        errorCode: "labs.ocr.fileTooLarge",
      });
    }

    let formData: FormData;
    try {
      const bytes = await readBoundedBody(request.body, OCR_MAX_BYTES);
      formData = await new Response(new Blob([bytes]), {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData();
    } catch (err) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      });
      if (err instanceof BodyTooLargeError) {
        annotate({
          action: { name: "labs.ocr.fileRejected" },
          meta: { reason: "stream_size_exceeded" },
        });
        return apiError("File is too large (max 12 MB).", 413, {
          errorCode: "labs.ocr.fileTooLarge",
        });
      }
      return apiError("Invalid multipart body", 400);
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      });
      return apiError("Field 'file' must be a file", 422);
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      });
      return apiError("Failed to read uploaded file", 400);
    }

    // 6. Magic-byte MIME sniff (the wire Content-Type is untrusted).
    const mime = detectOcrMimeType(buffer);
    if (!mime) {
      annotate({
        action: { name: "labs.ocr.fileRejected" },
        meta: { reason: "unsupported_mime" },
      });
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      });
      return apiError("Upload a JPEG, PNG, WebP, or PDF.", 415, {
        errorCode: "labs.ocr.fileType",
      });
    }

    // 7. PDF handling — mirror the document vault's `prepareVisionInput`
    // (`src/lib/documents/ai-route-support.ts`) exactly:
    //   - Anthropic (`pick.pdfSupported`) reads the native `document` block at
    //     highest fidelity;
    //   - every other vision provider (codex / any image-only wire) reads the
    //     PDF via `rasterizePdf`, which renders the pages to JPEG `input_image`
    //     parts the provider already handles. Rendering is pure local compute
    //     (no egress). `rasterizePdf` never throws: a malformed / encrypted /
    //     unrenderable PDF returns `{ ok: false }`, and we keep the shipped
    //     `pdfNeedsAnthropic` reject as the graceful fallback.
    let images: {
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      dataBase64: string;
    }[];
    let documents: { mediaType: "application/pdf"; dataBase64: string }[];

    if (mime === "application/pdf") {
      if (pick.pdfSupported) {
        images = [];
        documents = [
          {
            mediaType: "application/pdf",
            dataBase64: buffer.toString("base64"),
          },
        ];
      } else {
        const raster = await rasterizePdf(buffer);
        if (!raster.ok) {
          annotate({
            action: { name: "labs.ocr.fileRejected" },
            meta: { reason: "pdf_rasterize_failed" },
          });
          await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
            servedBy: null,
            reservedOwner: reservation.owner,
          });
          return apiError(
            "Couldn't read this PDF; upload a photo instead.",
            422,
            { errorCode: "labs.ocr.pdfNeedsAnthropic" },
          );
        }
        images = raster.images;
        documents = [];
      }
    } else {
      images = [{ mediaType: mime, dataBase64: buffer.toString("base64") }];
      documents = [];
    }

    // 8. Run the extraction. The actual token spend reconciles the reservation.
    let actualTokens = 0;
    try {
      const result = await runOcrExtraction({
        userId,
        provider: pick.entry.instance,
        providerType: pick.providerType,
        images,
        documents,
      });
      // The orchestration does not surface token counts; reconcile against the
      // reserved estimate as the spend ceiling (the provider already billed it).
      actualTokens = reservation.reserved;
      await reconcileSpend(
        userId,
        reservation.reserved,
        actualTokens,
        dateKey,
        0,
        { servedBy: pick.entry.providerType, reservedOwner: reservation.owner },
      );
      return apiSuccess(result);
    } catch (err) {
      // Provider/extraction failure — the call may still have burned tokens, so
      // reconcile against the reserved estimate rather than refunding in full.
      await reconcileSpend(
        userId,
        reservation.reserved,
        actualTokens,
        dateKey,
        0,
        { servedBy: pick.entry.providerType, reservedOwner: reservation.owner },
      );
      if (err instanceof OcrExtractError) {
        return apiError("Couldn't read the report. Try a clearer photo.", 422, {
          errorCode: "labs.ocr.extractFailed",
        });
      }
      annotate({
        action: { name: "labs.ocr.extractFailed" },
        meta: providerFailureMeta(err),
      });
      return apiError(
        "The configured AI provider could not process this report. Check the provider configuration and retry.",
        502,
        { errorCode: "labs.ocr.extractFailed" },
      );
    }
  } catch (err) {
    // A guard threw after the reservation (e.g. consent races) — refund fully.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    }).catch(() => {});
    throw err;
  }
}
