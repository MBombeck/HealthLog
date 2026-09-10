/**
 * v1.27.22 (Document vault P2) — AI filing-metadata assist on a stored document.
 *
 * An explicit "Suggest details" action: runs ONE provider call over the stored
 * original (VISION) or browser-OCR'd text (TEXT) and returns a `{ title, kind,
 * documentDate }` DRAFT. It runs the full extract-route gauntlet (module gate →
 * provider resolve → consent → rate-limit → budget reserve → reconcile) but
 * WRITES NOTHING (P2-D2): no `ExtractedFact`, no status flip, no structured
 * store. The human reviews the draft and presses Save on the edit form.
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. With no provider configured this 422s the enhancement;
 * the stored document and the manual edit form are untouched.
 */
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
import {
  DocumentAssistError,
  runDocumentAssist,
  type DocumentSuggestion,
} from "@/lib/documents/assist";
import {
  checkDocumentAiRateLimit,
  documentAiRateLimited,
  DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  loadOwnedDocument,
  prepareVisionInput,
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  resolveDocumentTextProvider,
  resolveDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { inboundTextExtractSchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await loadOwnedDocument(user.id, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return handleTextSuggest(request, user.id, document);
    }
    return handleVisionSuggest(request, user.id, document);
  },
);

/** Persist the AI-budget ledger side effect + the audit trail. NEVER the row. */
async function finishSuggest(
  request: NextRequest,
  userId: string,
  documentId: string,
  mode: "vision" | "text",
  suggestion: DocumentSuggestion,
): Promise<Response> {
  await auditLog("documents.inbound.suggest", {
    userId,
    ipAddress: getClientIp(request),
    details: { documentId, mode },
  });
  annotate({
    action: { name: "documents.assist.suggest" },
    meta: {
      documentId,
      mode,
      hasTitle: suggestion.title !== null,
      hasKind: suggestion.kind !== null,
      hasDate: suggestion.documentDate !== null,
    },
  });
  return apiSuccess({ suggestions: suggestion });
}

/** TEXT mode — suggest from in-browser-OCR'd text (opt-in local OCR). */
async function handleTextSuggest(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
): Promise<Response> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { labsLocalOcrEnabled: true },
  });
  if (!row?.labsLocalOcrEnabled) {
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

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  });
  if (jsonError) {
    await refundDocumentAiSlot(userId);
    return jsonError;
  }
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
    AI_BUDGETS.documentAssist.maxTokens,
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
    const suggestion = await runDocumentAssist({
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
    return finishSuggest(request, userId, document.id, "text", suggestion);
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof DocumentAssistError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.assist.failed" },
      meta: { reason: "provider_error", mode: "text" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}

/** VISION mode — suggest from the stored original via the vision provider. */
async function handleVisionSuggest(
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

  const vision = await prepareVisionInput(document, pick.pdfSupported);
  if (!vision.ok) {
    // Preparation failed before any provider dispatch — the slot goes back.
    await refundDocumentAiSlot(userId);
    if (vision.reason === "pdfNeedsAnthropic") {
      return apiError(
        "PDF scanning needs a Claude vision provider; use local OCR instead.",
        422,
        { errorCode: "documents.inbound.pdfNeedsAnthropic" },
      );
    }
    if (vision.reason === "fileType") {
      return apiError(
        "This document can't be scanned. Use local OCR (text mode).",
        422,
        { errorCode: "documents.inbound.fileType" },
      );
    }
    return apiError("Couldn't read the stored document.", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentAssist.maxTokens,
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
    const suggestion = await runDocumentAssist({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images: vision.images,
      documents: vision.documents,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );
    return finishSuggest(request, userId, document.id, "vision", suggestion);
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof DocumentAssistError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.assist.failed" },
      meta: { reason: "provider_error", mode: "vision" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}
