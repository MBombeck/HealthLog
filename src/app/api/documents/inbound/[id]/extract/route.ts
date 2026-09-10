/**
 * v1.25 — optional AI extraction on an already-STORED document.
 *
 * Extraction is no longer part of upload: a document is stored first
 * (provider-free), and THIS route is the explicit, user-triggered enhancement.
 * It carries the entire ingest gauntlet that upload used to run inline —
 * resolve document provider (local-first, codex last) → assertDocumentEgressConsent
 * → rate-limit → reserveBudget → runInboundExtraction → reconcileSpend → stage
 * facts — but now against a row that already exists. Absent a provider this 422s
 * the ENHANCEMENT only; the stored document is untouched and remains filed.
 *
 * Three modes:
 *   - VISION (no JSON body): decrypt the stored original, re-derive its MIME,
 *     and run the vision-capable provider over it.
 *   - TEXT (application/json, opt-in local OCR): `{ mode: "text", text }` — the
 *     browser OCR'd the document locally and posts only the text to structure.
 *   - STORED (application/json): `{ mode: "stored" }` — structure the
 *     document's own stored extracted text (its content index), the manual
 *     recovery for a skipped/failed automatic staging run. No re-upload.
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. The staged facts land PENDING for the mandatory
 * review-then-confirm screen; nothing reaches the structured stores here.
 */
import { Buffer } from "node:buffer";

import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { assertDocumentEgressConsent } from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  InboundExtractError,
  runInboundExtraction,
  type InboundExtractionResult,
} from "@/lib/documents/extract";
import {
  decryptDocumentContent,
  encryptFactData,
  encryptFactProvenance,
  serialiseDocumentDetail,
} from "@/lib/documents/store";
import {
  resolveDocumentTextProvider,
  resolveDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import {
  checkDocumentAiRateLimit,
  documentAiRateLimited,
  DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  refundDocumentAiSlot,
} from "@/lib/documents/ai-route-support";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  inboundStoredExtractSchema,
  inboundTextExtractSchema,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** A loaded, owner-scoped, still-extractable document row. */
type LoadedDocument = {
  id: string;
  kind: string;
  contentEncrypted: Uint8Array;
  contentCodec: string;
  mimeType: string;
  status: string;
};

/**
 * Replace the document's staged facts and flip it to EXTRACTED in one
 * transaction. Re-extraction is allowed only when NO fact is APPROVED yet (the
 * POST handler refuses it otherwise), so clearing every prior staged fact here
 * can never drop an approved row or sever a committed-record provenance link —
 * the only facts present are PENDING / REJECTED leftovers from an earlier run.
 */
async function stageExtraction(
  documentId: string,
  userId: string,
  result: InboundExtractionResult,
) {
  return prisma.$transaction(async (tx) => {
    await tx.extractedFact.deleteMany({ where: { documentId, userId } });
    await tx.inboundDocument.update({
      where: { id: documentId },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        reportDate: result.reportDate
          ? new Date(`${result.reportDate}T00:00:00.000Z`)
          : null,
        facts: {
          create: result.facts.map((f) => ({
            userId,
            factType: f.factType,
            status: "PENDING" as const,
            confidence: f.confidence,
            needsReview: f.needsReview,
            dataEncrypted: encryptFactData(f.data),
            provenanceEncrypted: encryptFactProvenance(f.provenance),
          })),
        },
      },
    });
    return tx.inboundDocument.findUniqueOrThrow({
      where: { id: documentId },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
  });
}

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: {
        id: true,
        kind: true,
        contentEncrypted: true,
        contentCodec: true,
        mimeType: true,
        status: true,
      },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }
    if (document.status === "CONFIRMED") {
      return apiError("This document has already been confirmed.", 422, {
        errorCode: "documents.inbound.alreadyConfirmed",
      });
    }

    // Refuse re-extraction once ANY fact on this document is APPROVED. A
    // partially-confirmed document (some facts approved, the rest still pending)
    // stays at status EXTRACTED, so the CONFIRMED gate above does not catch it.
    // Re-extracting would `deleteMany` the APPROVED rows — severing the
    // committed-record provenance link — and re-stage the same facts as PENDING,
    // letting the user approve them a second time and duplicate the committed
    // lab / condition / medication. Block it: the user must finish reviewing or
    // discard the document first.
    const approvedCount = await prisma.extractedFact.count({
      where: { documentId: document.id, userId: user.id, status: "APPROVED" },
    });
    if (approvedCount > 0) {
      annotate({
        action: { name: "documents.inbound.extractRefusedApproved" },
        meta: { documentId: document.id, approvedCount },
      });
      return apiError(
        "Some facts from this document are already confirmed. Finish reviewing or discard it before extracting again.",
        409,
        { errorCode: "documents.inbound.alreadyPartlyConfirmed" },
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      // One body read for both JSON modes, BEFORE any bucket charge — a
      // malformed body never needs a refund because nothing was charged yet.
      const { data: body, error: jsonError } = await safeJson(request, {
        maxBytes: DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
      });
      if (jsonError) return jsonError;
      if (inboundStoredExtractSchema.safeParse(body).success) {
        return handleStoredExtract(request, user.id, document);
      }
      return handleTextExtract(request, user.id, document, body);
    }
    return handleVisionExtract(request, user.id, document);
  },
);

/** TEXT mode — structure in-browser-OCR'd text against the stored row. */
async function handleTextExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  body: unknown,
): Promise<Response> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { labsLocalOcrEnabled: true },
  });
  if (!row?.labsLocalOcrEnabled) {
    annotate({ action: { name: "documents.inbound.providerUnsupported" } });
    return apiError("Local OCR is not enabled", 422, {
      errorCode: "documents.inbound.localOcrDisabled",
    });
  }

  const { pick } = await resolveDocumentTextProvider(userId);
  if (!pick) {
    return apiError("No AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }

  await assertDocumentEgressConsent({
    userId,
    providerType: pick.providerType,
    surface: "insights",
  });

  const rl = await checkDocumentAiRateLimit(userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  const parsed = inboundTextExtractSchema.safeParse(body);
  if (!parsed.success) {
    await refundDocumentAiSlot(userId);
    return apiValidationError(
      "Invalid document text payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "documents.inbound.extractFailed",
      },
    );
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtractText.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    await refundDocumentAiSlot(userId);
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  try {
    const result = await runInboundExtraction({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ocrText: parsed.data.text,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );

    const updated = await stageExtraction(document.id, userId, result);

    await auditLog("documents.inbound.extract", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: updated.facts.length,
        mode: "text",
      },
    });

    return apiSuccess(serialiseDocumentDetail(updated, updated.facts));
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof InboundExtractError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.inbound.extractFailed" },
      meta: { reason: "provider_error", mode: "text" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}

/**
 * STORED mode — structure the document's OWN stored extracted text (the
 * content index the read/index step produced) into staged facts.
 *
 * This is the manual recovery for a skipped or failed automatic staging run:
 * the same text-structuring pass the auto worker performs, but user-triggered
 * from the document detail. No re-upload, no second read of the original, no
 * browser OCR — so the local-OCR opt-in is not required here. Everything else
 * runs the full gauntlet: provider resolve → consent → rate limit (charged
 * only when the provider is actually dispatched) → budget → stage PENDING for
 * the mandatory review-then-confirm step. Nothing is committed here.
 */
async function handleStoredExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
): Promise<Response> {
  const chat = await loadDocumentChatText(userId, document.id);
  if (!chat || !chat.text.trim()) {
    return apiError("Read the document first, then extract.", 422, {
      errorCode: "documents.inbound.notIndexed",
    });
  }

  const { pick } = await resolveDocumentTextProvider(userId);
  if (!pick) {
    return apiError("No AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }

  await assertDocumentEgressConsent({
    userId,
    providerType: pick.providerType,
    surface: "insights",
  });

  const rl = await checkDocumentAiRateLimit(userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtractText.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    await refundDocumentAiSlot(userId);
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  try {
    const result = await runInboundExtraction({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ocrText: chat.text,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );

    const updated = await stageExtraction(document.id, userId, result);

    await auditLog("documents.inbound.extract", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: updated.facts.length,
        mode: "stored",
      },
    });

    return apiSuccess(serialiseDocumentDetail(updated, updated.facts));
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof InboundExtractError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.inbound.extractFailed" },
      meta: { reason: "provider_error", mode: "stored" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}

/** VISION mode — run the stored original through the vision provider. */
async function handleVisionExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
): Promise<Response> {
  const { pick } = await resolveDocumentVisionProvider(userId);
  if (!pick) {
    return apiError("No vision-capable AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }

  await assertDocumentEgressConsent({
    userId,
    providerType: pick.providerType,
    surface: "insights",
  });

  const rl = await checkDocumentAiRateLimit(userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  // Decrypt the stored original and re-derive its MIME from the bytes (never
  // trust a stored label for the provider call). Every miss below happens
  // before the provider dispatch, so the charged slot goes back.
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    await refundDocumentAiSlot(userId);
    return apiError("Couldn't read the stored document.", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }

  const mime = detectOcrMimeType(buffer);
  if (!mime) {
    await refundDocumentAiSlot(userId);
    return apiError(
      "This document can't be scanned. Use local OCR (text mode).",
      422,
      { errorCode: "documents.inbound.fileType" },
    );
  }

  if (mime === "application/pdf" && !pick.pdfSupported) {
    await refundDocumentAiSlot(userId);
    return apiError(
      "PDF scanning needs a Claude vision provider; use local OCR instead.",
      422,
      { errorCode: "documents.inbound.pdfNeedsAnthropic" },
    );
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtract.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    await refundDocumentAiSlot(userId);
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  const dataBase64 = buffer.toString("base64");
  const images =
    mime === "application/pdf" ? [] : [{ mediaType: mime, dataBase64 }];
  const documents =
    mime === "application/pdf"
      ? [{ mediaType: "application/pdf" as const, dataBase64 }]
      : [];

  try {
    const result = await runInboundExtraction({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images,
      documents,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );

    const updated = await stageExtraction(document.id, userId, result);

    await auditLog("documents.inbound.extract", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: updated.facts.length,
        mode: "vision",
      },
    });

    return apiSuccess(serialiseDocumentDetail(updated, updated.facts));
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof InboundExtractError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.inbound.extractFailed" },
      meta: { reason: "provider_error", mode: "vision" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}
