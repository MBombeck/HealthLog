/**
 * v1.18.9 / v1.18.10 — POST /api/labs/ocr/extract
 *
 * Read-only (NOT idempotent) extraction of a paper lab report into STRUCTURED
 * proposed rows for the mandatory human-review screen. Nothing is written to
 * the person's record here; the raw upload is never logged.
 *
 * v1.40 — the read runs in the background worker. This route answers every
 * refusal it can answer quickly (capability, provider, rate bucket, budget, a
 * malformed or oversized upload, an unknown file type), seals the upload or
 * the text into a `DocumentAiRun` (AES-256-GCM, dropped the moment the run
 * finishes, the row deleted an hour later) and answers 202 with the run id.
 * `GET /api/ai-runs/{id}` serves the proposed rows. Only the web client calls
 * this route, so there is no synchronous form to keep.
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
 *   requireAuth → requireAiCapability("labsOcr") → resolve provider and
 *   re-check the capability for that pick (`requireLabsOcrProvider`: the
 *   operator's switch, the labs module, and a document consent receipt for a
 *   pick that leaves the machine) → rate-limit
 *   (`LABS_OCR_LIMIT_PER_HOUR`, default 6/h) → reserveBudget → queue the run.
 *   The worker resolves the provider again, re-checks the wire, runs the
 *   extraction and reconciles the budget (`src/lib/labs/ocr-run.ts`). A slot is
 *   charged early so a 429 stays cheap, and it is handed back when the scan
 *   fails before the provider is called.
 *
 * Extracted text is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside the document — the human review step is the safety
 * boundary, and the commit route is the only write path.
 */
import { Buffer } from "node:buffer";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
  isJsonContentType,
} from "@/lib/api-response";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { startAiRun } from "@/lib/documents/ai-runs/start";
import { prisma } from "@/lib/db";
import { requireLabsOcrProvider } from "@/lib/labs/ocr-capability";
import { OCR_RESERVE_TOKENS } from "@/lib/labs/ocr-run";
import {
  BodyTooLargeError,
  detectOcrMimeType,
  OCR_MAX_BYTES,
  readBoundedBody,
} from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import {
  checkLabsOcrRateLimit,
  labsOcrRateLimited,
  refundLabsOcrSlot,
} from "@/lib/labs/ocr-rate-limit";
import { ocrTextExtractSchema } from "@/lib/validations/labs-ocr";

export const dynamic = "force-dynamic";

/** OCR'd text is bounded in the schema; cap the JSON body proportionally. */
const TEXT_BODY_MAX_BYTES = 512 * 1024;

export const POST = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  // Reading a lab report is model work in both modes: vision sends the image,
  // text mode sends what the browser read off it. The provider and the consent
  // receipt are answered by the pick below, for the provider actually used.
  await requireAiCapability("labsOcr", { pickDecides: true });

  // Dispatch on the body shape: a JSON body is the local-OCR text mode; a
  // multipart body is the native-vision image/PDF mode.
  const contentType = request.headers.get("content-type") ?? "";
  if (isJsonContentType(contentType)) {
    return handleTextExtract(request, user.id);
  }
  return handleVisionExtract(request, user.id);
});

/**
 * TEXT mode (v1.18.10) — queue in-browser-OCR'd text for any configured
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

  // Any configured provider can structure the text. The pick is re-checked
  // against `labsOcr` for exactly that provider; one that leaves the machine
  // needs a document consent receipt.
  const pick = await requireLabsOcrProvider(userId, "text");

  const rl = await checkLabsOcrRateLimit(userId);
  if (!rl.allowed) {
    annotate({ action: { name: "labs.ocr.rateLimited" } });
    return labsOcrRateLimited(rl);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: TEXT_BODY_MAX_BYTES,
  });
  if (jsonError) {
    await refundLabsOcrSlot(userId);
    return jsonError;
  }

  const parsed = ocrTextExtractSchema.safeParse(body);
  if (!parsed.success) {
    await refundLabsOcrSlot(userId);
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
  // v1.21.0 — the operator-cost cap applies only when the picked provider
  // egresses on the operator's own key; a BYOK / Codex / local pick runs on the
  // user's own plan and gets the generous user-plan ceiling.
  const dateKey = await buildDateKey(userId);
  const reservation = await reserveBudget(
    userId,
    OCR_RESERVE_TOKENS.text,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
    "coach",
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "labs.ocr.budget.exceeded" },
      meta: { totalAfter: reservation.totalAfter, mode: "text" },
    });
    await refundLabsOcrSlot(userId);
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "labs.ocr.budgetExceeded",
    });
  }

  // The structuring pass runs in the worker, which picks the provider again
  // and re-checks the wire for it before the text leaves.
  return startAiRun({
    userId,
    kind: "LABS_OCR_EXTRACT",
    params: {
      mode: "text",
      budget: {
        reserved: reservation.reserved,
        owner: reservation.owner,
        dateKey,
      },
    },
    input: Buffer.from(parsed.data.text, "utf8"),
    refundSlot: () => refundLabsOcrSlot(userId),
  });
}

/**
 * VISION mode — queue a multipart photo / PDF for the user's vision-capable
 * provider. The upload is sealed into the run until the read finishes.
 */
async function handleVisionExtract(
  request: Request,
  userId: string,
): Promise<Response> {
  // 1-2. Resolve a vision-capable provider (422 when none is configured) and
  // re-check `labsOcr` for it, consent receipt included.
  const pick = await requireLabsOcrProvider(userId, "vision");

  // 3. Rate-limit (vision calls are costly).
  const rl = await checkLabsOcrRateLimit(userId);
  if (!rl.allowed) {
    annotate({ action: { name: "labs.ocr.rateLimited" } });
    return labsOcrRateLimited(rl);
  }

  // 4. Reserve the day's budget BEFORE the provider call (atomic, TOCTOU-safe).
  // v1.21.0 — the operator-cost cap applies only when the picked vision
  // provider egresses on the operator's own key; a BYOK / Codex pick runs on
  // the user's own plan and gets the generous user-plan ceiling.
  const dateKey = await buildDateKey(userId);
  const reservation = await reserveBudget(
    userId,
    OCR_RESERVE_TOKENS.vision,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
    "coach",
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "labs.ocr.budget.exceeded" },
      meta: { totalAfter: reservation.totalAfter },
    });
    await refundLabsOcrSlot(userId);
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
      await refundLabsOcrSlot(userId);
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
      await refundLabsOcrSlot(userId);
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
      await refundLabsOcrSlot(userId);
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
      await refundLabsOcrSlot(userId);
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
      await refundLabsOcrSlot(userId);
      return apiError("Upload a JPEG, PNG, WebP, or PDF.", 415, {
        errorCode: "labs.ocr.fileType",
      });
    }

    // 7. Queue the read. The worker renders a PDF for a provider that cannot
    // read one natively, runs the extraction, and settles the reservation.
    return await startAiRun({
      userId,
      kind: "LABS_OCR_EXTRACT",
      params: {
        mode: "vision",
        mime,
        budget: {
          reserved: reservation.reserved,
          owner: reservation.owner,
          dateKey,
        },
      },
      input: buffer,
      refundSlot: () => refundLabsOcrSlot(userId),
    });
  } catch (err) {
    // A guard threw after the reservation (e.g. consent races) — refund fully.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    }).catch(() => {});
    await refundLabsOcrSlot(userId);
    throw err;
  }
}
