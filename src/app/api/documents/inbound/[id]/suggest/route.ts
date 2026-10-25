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
 *
 * v1.40 — `Prefer: respond-async` (RFC 7240) runs the read in the background
 * worker: every refusal that can be answered quickly is still answered here,
 * then the route answers 202 with a run id and `GET /api/ai-runs/{id}` serves
 * the same body this route answers with synchronously. Without the header the
 * route behaves exactly as before; the iPhone app relies on that. Both paths
 * run one body (`executeDocumentSuggest`).
 */
import { Buffer } from "node:buffer";

import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
  isJsonContentType,
} from "@/lib/api-response";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import {
  buildDateKey,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import {
  checkDocumentAiRateLimit,
  documentAiRateLimited,
  DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  loadOwnedDocument,
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  acceptedRunResponse,
  outcomeResponse,
  prefersRespondAsync,
} from "@/lib/documents/ai-runs/http";
import { findLiveDocumentRun, startAiRun } from "@/lib/documents/ai-runs/start";
import {
  executeDocumentSuggest,
  type DocumentSuggestInput,
} from "@/lib/documents/ai-runs/suggest-run";
import type { AiRunBudget } from "@/lib/documents/ai-runs/types";
import {
  requireDocumentTextProvider,
  requireDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { inboundTextExtractSchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // Writes nothing (the draft goes back to the edit form), so the shared
    // write ceiling does not count it; the document-AI bucket meters it.
    const { user } = await requireAuth(undefined, { readOverPost: true });

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

    const background = prefersRespondAsync(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (isJsonContentType(contentType)) {
      return handleTextSuggest(request, user.id, document, background);
    }
    return handleVisionSuggest(request, user.id, document, background);
  },
);

/**
 * A suggestion read of this document over the same transport, already queued
 * or running: attach to it rather than charge a second one. Background only.
 */
async function liveRunResponse(
  userId: string,
  documentId: string,
  mode: "vision" | "text",
): Promise<Response | null> {
  const live = await findLiveDocumentRun(
    userId,
    documentId,
    "DOCUMENT_SUGGEST",
    (params) => params.mode === mode,
  );
  return live ? acceptedRunResponse(live) : null;
}

/** Reserve the read's budget; null (slot refunded) when the day is spent. */
async function reserveFor(
  userId: string,
  providerType: ProviderChainType,
): Promise<AiRunBudget | null> {
  const dateKey = await buildDateKey(userId);
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentAssist.maxTokens,
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

/** The synchronous path: run the shared body inside this request. */
async function runNow(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  input: DocumentSuggestInput,
): Promise<Response> {
  return outcomeResponse(
    await executeDocumentSuggest({
      userId,
      document,
      input,
      origin: { ipAddress: getClientIp(request), worker: false },
    }),
  );
}

/** TEXT mode — suggest from in-browser-OCR'd text (opt-in local OCR). */
async function handleTextSuggest(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  background: boolean,
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

  const pick = await requireDocumentTextProvider(userId);

  if (background) {
    const live = await liveRunResponse(userId, document.id, "text");
    if (live) return live;
  }

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

  const budget = await reserveFor(userId, pick.entry.providerType);
  if (!budget) return budgetExceeded();

  if (background) {
    // The worker picks the provider again and re-checks the wire for it right
    // before the text leaves.
    return startAiRun({
      userId,
      kind: "DOCUMENT_SUGGEST",
      documentId: document.id,
      params: { mode: "text", budget },
      input: Buffer.from(parsed.data.text, "utf8"),
      refundSlot: () => refundDocumentAiSlot(userId),
    });
  }

  return runNow(request, userId, document, {
    mode: "text",
    text: parsed.data.text,
    pick,
    budget,
  });
}

/** VISION mode — suggest from the stored original via the vision provider. */
async function handleVisionSuggest(
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

  const budget = await reserveFor(userId, pick.entry.providerType);
  if (!budget) return budgetExceeded();

  if (background) {
    // The worker decrypts the stored original itself, after it has picked
    // the provider again and re-checked the wire for it.
    return startAiRun({
      userId,
      kind: "DOCUMENT_SUGGEST",
      documentId: document.id,
      params: { mode: "vision", budget },
      refundSlot: () => refundDocumentAiSlot(userId),
    });
  }

  return runNow(request, userId, document, { mode: "vision", pick, budget });
}
