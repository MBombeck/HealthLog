/**
 * v1.25 — optional AI extraction on an already-STORED document.
 *
 * Extraction is no longer part of upload: a document is stored first
 * (provider-free), and THIS route is the explicit, user-triggered enhancement.
 * It carries the entire ingest gauntlet that upload used to run inline —
 * requireAiCapability("documentAi") → resolve document provider (local-first,
 * codex last) and re-check the capability for that pick, consent receipt
 * included → rate-limit → reserveBudget → runInboundExtraction (the document
 * read a page or a part at a time, every read after the first reserved on its
 * own) → reconcileSpend → stage facts — but now against a row that already
 * exists. Absent a provider this 422s the ENHANCEMENT only; the stored
 * document is untouched and remains filed.
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
 *
 * v1.40 — `Prefer: respond-async` (RFC 7240) runs the extraction in the
 * background worker: every refusal that can be answered quickly is still
 * answered here, then the route answers 202 with a run id. The run's result is
 * `{ documentId, factsStaged, status }` rather than the whole detail (the
 * facts are staged on the document; the client reads them from there).
 * Without the header the route answers the document detail as before; the
 * iPhone app relies on that. Both paths run one body (`executeDocumentExtract`),
 * which re-checks the document under a row lock before it stages anything.
 * Inside the request the reads are bounded (`SYNC_EXTRACT_MAX_READS`): a
 * twenty-page report read a page at a time with a retry each was forty model
 * calls in one HTTP request. What does not fit is reported on the document as
 * `extractionIncomplete`, and the background run reads it in full.
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
  isJsonContentType,
} from "@/lib/api-response";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import {
  buildDateKey,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { prisma } from "@/lib/db";
import {
  markerIndexForFacts,
  serialiseDocumentDetail,
} from "@/lib/documents/store";
import {
  requireDocumentTextProvider,
  requireDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import {
  checkDocumentAiRateLimit,
  documentAiRateLimited,
  DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  loadOwnedDocument,
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  executeDocumentExtract,
  type DocumentExtractInput,
} from "@/lib/documents/ai-runs/extract-run";
import {
  acceptedRunResponse,
  outcomeResponse,
  prefersRespondAsync,
} from "@/lib/documents/ai-runs/http";
import { findLiveDocumentRun, startAiRun } from "@/lib/documents/ai-runs/start";
import type { AiRunBudget } from "@/lib/documents/ai-runs/types";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  inboundStoredExtractSchema,
  inboundTextExtractSchema,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

type ExtractInputMode = "text" | "stored" | "vision";

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    // Reading a document is model work. The provider and the consent receipt
    // are answered by the pick below, for the provider actually used.
    await requireAiCapability("documentAi", { pickDecides: true });

    const { id } = await params;
    const document = await loadOwnedDocument(user.id, id);
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
    // discard the document first. Staging asks again under a row lock, because
    // a review can finish while the read runs.
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

    const background = prefersRespondAsync(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (isJsonContentType(contentType)) {
      // One body read for both JSON modes, BEFORE any bucket charge — a
      // malformed body never needs a refund because nothing was charged yet.
      const { data: body, error: jsonError } = await safeJson(request, {
        maxBytes: DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
      });
      if (jsonError) return jsonError;
      if (inboundStoredExtractSchema.safeParse(body).success) {
        return handleStoredExtract(request, user.id, document, background);
      }
      return handleTextExtract(request, user.id, document, body, background);
    }
    return handleVisionExtract(request, user.id, document, background);
  },
);

/**
 * An extraction of this document from the same input, already queued or
 * running: attach to it rather than charge a second one. Background only.
 */
async function liveRunResponse(
  userId: string,
  documentId: string,
  input: ExtractInputMode,
): Promise<Response | null> {
  const live = await findLiveDocumentRun(
    userId,
    documentId,
    "DOCUMENT_EXTRACT",
    (params) => params.extract?.input === input,
  );
  return live ? acceptedRunResponse(live) : null;
}

/** Reserve the read's budget; null (slot refunded) when the day is spent. */
async function reserveFor(
  userId: string,
  providerType: ProviderChainType,
  tokens: number,
): Promise<AiRunBudget | null> {
  const dateKey = await buildDateKey(userId);
  const reservation = await reserveBudget(
    userId,
    tokens,
    dateKey,
    resolveDailyCap([{ providerType }]),
    resolveCostOwner([{ providerType }]),
    "coach",
  );
  if (!reservation.allowed) {
    await refundDocumentAiSlot(userId);
    return null;
  }
  return { reserved: reservation.reserved, owner: reservation.owner, dateKey };
}

function budgetExceeded(): Response {
  return apiError("Your AI usage budget for today is reached.", 429, {
    errorCode: "documents.inbound.budgetExceeded",
  });
}

/** Queue the extraction for the background worker. */
function queueExtract(
  userId: string,
  document: LoadedDocument,
  input: ExtractInputMode,
  budget: AiRunBudget,
  text: string | null,
): Promise<Response> {
  return startAiRun({
    userId,
    kind: "DOCUMENT_EXTRACT",
    documentId: document.id,
    params: {
      mode: input === "vision" ? "vision" : "text",
      budget,
      extract: { input },
    },
    input: text === null ? null : Buffer.from(text, "utf8"),
    refundSlot: () => refundDocumentAiSlot(userId),
  });
}

/** The synchronous path: run the shared body and answer with the detail. */
async function runNow(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  input: DocumentExtractInput,
): Promise<Response> {
  const outcome = await executeDocumentExtract({
    userId,
    document,
    input,
    origin: { ipAddress: getClientIp(request), worker: false },
  });
  if (!outcome.ok) return outcomeResponse(outcome);
  const { document: staged } = outcome.data;
  return apiSuccess(
    serialiseDocumentDetail(
      staged,
      staged.facts,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      await markerIndexForFacts(userId, staged.facts),
    ),
  );
}

/** TEXT mode — structure in-browser-OCR'd text against the stored row. */
async function handleTextExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  body: unknown,
  background: boolean,
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

  const pick = await requireDocumentTextProvider(userId);

  if (background) {
    const live = await liveRunResponse(userId, document.id, "text");
    if (live) return live;
  }

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

  const budget = await reserveFor(
    userId,
    pick.entry.providerType,
    AI_BUDGETS.ocrExtractText.maxTokens,
  );
  if (!budget) return budgetExceeded();

  if (background) {
    return queueExtract(userId, document, "text", budget, parsed.data.text);
  }
  return runNow(request, userId, document, {
    mode: "text",
    text: parsed.data.text,
    pick,
    budget,
  });
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
  background: boolean,
): Promise<Response> {
  const chat = await loadDocumentChatText(userId, document.id);
  if (!chat || !chat.text.trim()) {
    return apiError("Read the document first, then extract.", 422, {
      errorCode: "documents.inbound.notIndexed",
    });
  }

  const pick = await requireDocumentTextProvider(userId);

  if (background) {
    const live = await liveRunResponse(userId, document.id, "stored");
    if (live) return live;
  }

  const rl = await checkDocumentAiRateLimit(userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  const budget = await reserveFor(
    userId,
    pick.entry.providerType,
    AI_BUDGETS.ocrExtractText.maxTokens,
  );
  if (!budget) return budgetExceeded();

  if (background) {
    // The worker loads the stored text itself; nothing is sealed into the run.
    return queueExtract(userId, document, "stored", budget, null);
  }
  return runNow(request, userId, document, {
    mode: "stored",
    text: chat.text,
    pick,
    budget,
  });
}

/** VISION mode — run the stored original through the vision provider. */
async function handleVisionExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  background: boolean,
): Promise<Response> {
  const pick = await requireDocumentVisionProvider(userId);

  if (background) {
    const live = await liveRunResponse(userId, document.id, "vision");
    if (live) return live;
  }

  const rl = await checkDocumentAiRateLimit(userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  const budget = await reserveFor(
    userId,
    pick.entry.providerType,
    AI_BUDGETS.ocrExtract.maxTokens,
  );
  if (!budget) return budgetExceeded();

  if (background) {
    // The worker decrypts the stored original itself, after it has picked
    // the provider again and re-checked the wire for it.
    return queueExtract(userId, document, "vision", budget, null);
  }
  return runNow(request, userId, document, { mode: "vision", pick, budget });
}
