/**
 * v1.27.22 (Document vault P2) — on-demand, SESSION-ONLY document summary /
 * extracted text.
 *
 * `?mode=summary` (default) returns a short plain-language summary of WHAT the
 * document is; `?mode=text` returns its raw transcribed text. The summary is
 * descriptive only and is forbidden from diagnosing (interpretation boundary
 * G7).
 *
 * `mode=text` stays transient (P2-D4) — a transcription is a read-through of the
 * user's own file and there is nothing to keep. `mode=summary` PERSISTS onto the
 * document row since v1.30.31: the user asked for it explicitly, it is the same
 * artefact the background job stores, and keeping it means a second open shows
 * the paragraph instead of buying it again. Beyond that the old rule holds —
 * nothing reaches coach memory, snapshots, the structured stores, or the search
 * index; a summary the safety screen blocked is never stored as text.
 *
 * Same VISION/TEXT dispatch and gauntlet as the extract route. The document is
 * UNTRUSTED (prompt-injection): the server never acts on an instruction inside
 * it. With no provider configured this 422s; nothing is stored either way.
 *
 * v1.40 — `Prefer: respond-async` (RFC 7240) runs the read in the background
 * worker: every refusal that can be answered quickly is still answered here,
 * then the route answers 202 with a run id and `GET /api/ai-runs/{id}` serves
 * the same body this route answers with synchronously. A summary that is to
 * be stored marks the document PENDING while it is queued. Without the header
 * the route behaves exactly as before; the iPhone app relies on that. Both
 * paths run one body (`executeDocumentSummary`). A transcription of text the
 * browser already read calls no model and is answered here either way.
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
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import {
  buildDateKey,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { auditLog } from "@/lib/auth/audit";
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
  executeDocumentSummary,
  markSummaryQueued,
  type DocumentSummaryInput,
  type SummaryPersistence,
} from "@/lib/documents/ai-runs/summary-run";
import type { AiRunBudget, AiRunParams } from "@/lib/documents/ai-runs/types";
import { transcribeDocument } from "@/lib/documents/describe";
import {
  requireDocumentTextProvider,
  requireDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import {
  DOCUMENT_SUMMARY_MODES,
  inboundTextExtractSchema,
  type DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type { Locale } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** What one request asks for, read once from the query and the headers. */
interface SummaryRequest {
  userId: string;
  document: LoadedDocument;
  mode: DocumentSummaryMode;
  locale: Locale;
  persist: SummaryPersistence | null;
  background: boolean;
}

function resolveMode(request: NextRequest): DocumentSummaryMode {
  const raw = new URL(request.url).searchParams.get("mode");
  return (DOCUMENT_SUMMARY_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as DocumentSummaryMode)
    : "summary";
}
function resolvePersistRequested(request: NextRequest): boolean {
  return new URL(request.url).searchParams.get("persist") === "true";
}

function resolveReplaceExisting(request: NextRequest): boolean {
  return new URL(request.url).searchParams.get("replace") === "true";
}

/** The budget the requested mode charges. */
function budgetFor(mode: DocumentSummaryMode): number {
  return mode === "text"
    ? AI_BUDGETS.documentTranscribe.maxTokens
    : AI_BUDGETS.documentSummary.maxTokens;
}

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

    const mode = resolveMode(request);
    // A normal summary request fills an empty slot only. Replacement is
    // reserved for the document detail's explicit "Generate again" action.
    const persist: SummaryPersistence | null =
      mode === "summary" && resolvePersistRequested(request)
        ? { replaceExisting: resolveReplaceExisting(request) }
        : null;
    // The outbound screen on the summary needs the reader's locale to pick its
    // pattern banks; resolve it once here and thread it into both describe legs.
    const locale = await resolveServerLocale({
      request,
      userLocale: user.locale ?? null,
    });
    const ask: SummaryRequest = {
      userId: user.id,
      document,
      mode,
      locale,
      persist,
      background: prefersRespondAsync(request),
    };
    const contentType = request.headers.get("content-type") ?? "";
    if (isJsonContentType(contentType)) {
      return handleTextSummary(request, ask);
    }
    return handleVisionSummary(request, ask);
  },
);

/** The run parameters for this request (never health data). */
function runParams(
  ask: SummaryRequest,
  inputMode: "vision" | "text",
  budget: AiRunBudget,
): AiRunParams {
  return {
    mode: inputMode,
    budget,
    summary: {
      output: ask.mode,
      persist: ask.persist !== null,
      replace: ask.persist?.replaceExisting ?? false,
      locale: ask.locale,
    },
  };
}

/**
 * A run that will produce the same thing, already queued or running: attach
 * to it rather than charge a second one. Background path only.
 */
async function liveRunResponse(
  ask: SummaryRequest,
  inputMode: "vision" | "text",
): Promise<Response | null> {
  const live = await findLiveDocumentRun(
    ask.userId,
    ask.document.id,
    "DOCUMENT_SUMMARY",
    (params) =>
      params.mode === inputMode &&
      params.summary?.output === ask.mode &&
      params.summary.persist === (ask.persist !== null) &&
      params.summary.replace === (ask.persist?.replaceExisting ?? false),
  );
  return live ? acceptedRunResponse(live) : null;
}

/** Reserve the read's budget; null (slot refunded) when the day is spent. */
async function reserveFor(
  ask: SummaryRequest,
  providerType: ProviderChainType,
): Promise<AiRunBudget | null> {
  const dateKey = await buildDateKey(ask.userId);
  const reservation = await reserveBudget(
    ask.userId,
    budgetFor(ask.mode),
    dateKey,
    resolveDailyCap([{ providerType }]),
    resolveCostOwner([{ providerType }]),
    "coach",
  );
  if (!reservation.allowed) {
    await refundDocumentAiSlot(ask.userId);
    return null;
  }
  return { reserved: reservation.reserved, owner: reservation.owner, dateKey };
}

function budgetExceeded(): Response {
  return apiError("Your AI usage budget for today is reached.", 429, {
    errorCode: "documents.inbound.budgetExceeded",
  });
}

/** Queue the read; a summary that is to be stored is marked PENDING first. */
async function queueSummary(
  ask: SummaryRequest,
  inputMode: "vision" | "text",
  budget: AiRunBudget,
  text: string | null,
): Promise<Response> {
  if (ask.persist) await markSummaryQueued(ask.userId, ask.document.id);
  return startAiRun({
    userId: ask.userId,
    kind: "DOCUMENT_SUMMARY",
    documentId: ask.document.id,
    params: runParams(ask, inputMode, budget),
    input: text === null ? null : Buffer.from(text, "utf8"),
    refundSlot: () => refundDocumentAiSlot(ask.userId),
  });
}

/** TEXT mode — summarise / echo in-browser-OCR'd text. */
async function handleTextSummary(
  request: NextRequest,
  ask: SummaryRequest,
): Promise<Response> {
  const { userId, document, mode } = ask;
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { labsLocalOcrEnabled: true },
  });
  if (!row?.labsLocalOcrEnabled) {
    return apiError("Local OCR is not enabled", 422, {
      errorCode: "documents.inbound.localOcrDisabled",
    });
  }

  if (ask.background && mode !== "text") {
    const live = await liveRunResponse(ask, "text");
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

  // `mode=text` over posted OCR text is a pure echo — the text IS the
  // transcription. No provider egress, no consent, no budget: session-only.
  // There is nothing to run in the background, so the preference is not
  // applied and the answer comes straight back.
  if (mode === "text") {
    const result = await transcribeDocument({
      provider: {} as never,
      providerType: "local-ocr",
      ocrText: parsed.data.text,
    });
    await auditLog("documents.inbound.summary", {
      userId,
      ipAddress: getClientIp(request),
      details: { documentId: document.id, mode, inputMode: "text" },
    });
    annotate({
      action: { name: "documents.summary.serve" },
      meta: { documentId: document.id, mode, inputMode: "text" },
    });
    return apiSuccess(result);
  }

  let pick: Awaited<ReturnType<typeof requireDocumentTextProvider>>;
  try {
    pick = await requireDocumentTextProvider(userId);
  } catch (err) {
    // Refused before any dispatch — the slot goes back with the refusal.
    await refundDocumentAiSlot(userId);
    throw err;
  }

  const budget = await reserveFor(ask, pick.entry.providerType);
  if (!budget) return budgetExceeded();

  if (ask.background) {
    // The worker picks the provider again and re-checks the wire for it right
    // before the text leaves.
    return queueSummary(ask, "text", budget, parsed.data.text);
  }

  return runNow(request, ask, {
    mode: "text",
    text: parsed.data.text,
    pick,
    budget,
  });
}

/** VISION mode — summarise / transcribe the stored original. */
async function handleVisionSummary(
  request: NextRequest,
  ask: SummaryRequest,
): Promise<Response> {
  const pick = await requireDocumentVisionProvider(ask.userId);

  if (ask.background) {
    const live = await liveRunResponse(ask, "vision");
    if (live) return live;
  }

  const rl = await checkDocumentAiRateLimit(ask.userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  const budget = await reserveFor(ask, pick.entry.providerType);
  if (!budget) return budgetExceeded();

  if (ask.background) {
    // The worker decrypts the stored original itself, after it has picked
    // the provider again and re-checked the wire for it.
    return queueSummary(ask, "vision", budget, null);
  }

  return runNow(request, ask, { mode: "vision", pick, budget });
}

/** The synchronous path: run the shared body inside this request. */
async function runNow(
  request: NextRequest,
  ask: SummaryRequest,
  input: DocumentSummaryInput,
): Promise<Response> {
  return outcomeResponse(
    await executeDocumentSummary({
      userId: ask.userId,
      document: ask.document,
      input,
      output: ask.mode,
      locale: ask.locale,
      persist: ask.persist,
      origin: { ipAddress: getClientIp(request), worker: false },
    }),
  );
}
