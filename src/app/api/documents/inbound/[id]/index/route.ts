/**
 * v1.27.22 (Document vault P2) — populate / refresh one document's content
 * search index.
 *
 * VISION (no JSON body): decrypt the stored original, run ONE provider
 * transcription call, then tokenise + encrypt the text into
 * `DocumentContentIndex`. Consent + budget gated, exactly like extract.
 *
 * TEXT (`application/json`, opt-in local OCR): `{ mode: "text", text }` — the
 * browser OCR'd the image on-device and posts only the TEXT (P2-D9). No provider
 * egress, so no consent / budget; the server just tokenises + encrypts it. The
 * raw image never leaves the device on this path.
 *
 * Decision (maintainer, 2026-07-07): content indexing is gated on the EXISTING
 * AI consent / provider gate — there is NO separate `documentsContentIndexEnabled`
 * toggle (the plan's P2-D8 opt-in was refused to avoid toggle sprawl). The vision
 * path runs `assertDocumentEgressConsent` (any external provider needs an active
 * receipt; a local pick stays ungated); the text path rides the local-OCR opt-in
 * the lab / extract text mode already uses — no provider egress at all.
 *
 * Persists ONLY AES-256-GCM ciphertext text + opaque HMAC token hashes (A4).
 *
 * v1.40 — `Prefer: respond-async` (RFC 7240) runs the read in the background
 * worker: every refusal that can be answered quickly is still answered here,
 * then the route answers 202 with a run id and `GET /api/ai-runs/{id}` serves
 * the same body this route answers with synchronously. Without the header the
 * route answers the same body as before; the iPhone app relies on that. Both
 * paths run one body (`executeDocumentIndex`). Inside the request the lab
 * staging is bounded like the extract route (`SYNC_EXTRACT_MAX_READS`): what
 * does not fit is reported on the document as `extractionIncomplete`.
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
} from "@/lib/api-response";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
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
import {
  DOCUMENT_INDEX_RESERVE_TOKENS,
  executeDocumentIndex,
} from "@/lib/documents/ai-runs/index-run";
import { findLiveDocumentRun, startAiRun } from "@/lib/documents/ai-runs/start";
import { requireDocumentVisionProvider } from "@/lib/documents/provider-order";
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

    const background = prefersRespondAsync(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return handleTextIndex(request, user.id, document, background);
    }
    return handleVisionIndex(request, user.id, document, background);
  },
);

/**
 * A read of this document already queued or running: attach to it rather than
 * charge a second one. Background path only; the synchronous path keeps its
 * behaviour of one request, one read.
 */
async function liveRunResponse(
  userId: string,
  documentId: string,
): Promise<Response | null> {
  const live = await findLiveDocumentRun(userId, documentId, "DOCUMENT_INDEX");
  return live ? acceptedRunResponse(live) : null;
}

/** TEXT mode — index browser-OCR'd text (no provider egress). */
async function handleTextIndex(
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

  if (background) {
    const live = await liveRunResponse(userId, document.id);
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

  if (background) {
    // The text is indexed in the worker, which then continues into the same
    // lab staging (model calls) the synchronous path makes.
    return startAiRun({
      userId,
      kind: "DOCUMENT_INDEX",
      documentId: document.id,
      params: { mode: "text" },
      input: Buffer.from(parsed.data.text, "utf8"),
      refundSlot: () => refundDocumentAiSlot(userId),
    });
  }

  return outcomeResponse(
    await executeDocumentIndex({
      userId,
      document,
      input: { mode: "text", text: parsed.data.text },
      origin: { ipAddress: getClientIp(request), worker: false },
    }),
  );
}

/** VISION mode — transcribe the stored original, then index the text. */
async function handleVisionIndex(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  background: boolean,
): Promise<Response> {
  // Transcribing the stored original is model work; indexing text the browser
  // already read (the text mode above) is not, and stays open with AI off so
  // search keeps working. The provider and the consent receipt are answered
  // by the pick, for the provider actually used.
  await requireAiCapability("documentAi", { pickDecides: true });
  const pick = await requireDocumentVisionProvider(userId);

  if (background) {
    const live = await liveRunResponse(userId, document.id);
    if (live) return live;
  }

  const rl = await checkDocumentAiRateLimit(userId);
  if (!rl.allowed) return documentAiRateLimited(rl);

  const dateKey = await buildDateKey(userId);
  const reservation = await reserveBudget(
    userId,
    DOCUMENT_INDEX_RESERVE_TOKENS,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
    "coach",
  );
  if (!reservation.allowed) {
    await refundDocumentAiSlot(userId);
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }
  const budget = {
    reserved: reservation.reserved,
    owner: reservation.owner,
    dateKey,
  };

  if (background) {
    // The worker picks the provider again and re-checks the wire for it right
    // before the stored original leaves.
    return startAiRun({
      userId,
      kind: "DOCUMENT_INDEX",
      documentId: document.id,
      params: { mode: "vision", budget },
      refundSlot: () => refundDocumentAiSlot(userId),
    });
  }

  return outcomeResponse(
    await executeDocumentIndex({
      userId,
      document,
      input: { mode: "vision", pick, budget },
      origin: { ipAddress: getClientIp(request), worker: false },
    }),
  );
}
