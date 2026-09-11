/**
 * v1.29.x (S7) — the shared FENCED-CHAT turn pipeline.
 *
 * Extraction of the v1.27.33 single-document chat route body, generalised over N
 * attached documents. Both fenced entry points share this module so they cannot
 * drift:
 *   - `POST /api/insights/chat/fenced`            (conversation-keyed, N docs)
 *   - `POST /api/documents/inbound/[id]/chat`     (path-keyed, 1 doc — the public
 *                                                  iOS contract, unchanged wire)
 *
 * THE INVARIANT this module upholds (write it on the wall): document text enters
 * an LLM prompt in EXACTLY ONE code path — this one. It registers NO tools and
 * builds NO health snapshot. There is intentionally no import of the coach tool
 * registry or snapshot builder anywhere in the fenced graph; a structural test
 * (`fenced-chat-module-graph.test.ts`) pins that so a future refactor cannot
 * quietly wire document text into the tool path.
 *
 * Security posture carried verbatim from the single-doc route:
 *   - NO TOOLS, NO SNAPSHOT — one completion per turn.
 *   - PROMPT-INJECTION FENCING — every document fenced as DATA (`fenceDocument`),
 *     per-doc header fields marker-scrubbed (`buildFencedChatSystemPrompt`).
 *   - PER-DOCUMENT EGRESS CONSENT — the single picked provider (no cascade) is
 *     consent-checked once per attached document; ALL must clear or the turn
 *     refuses (403) BEFORE any egress and BEFORE the user turn is persisted.
 *   - NUMERIC GROUNDING over the LIVE attachment union only — recomputed per turn
 *     from the join rows, never history / snapshot.
 *   - OWNER-SCOPED TEXT LOADER as a second ownership layer — a corrupted/foreign
 *     join row yields null and the turn refuses (422), never foreign text.
 */
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { createSseStream } from "@/lib/sse/create-stream";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { assertDocumentEgressConsent } from "@/lib/ai/consent-guard";
import {
  AllProvidersFailedError,
  runStreamingRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { singleUserTurn } from "@/lib/ai/types";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { detectRefusal, type CoachRefusalReason } from "@/lib/ai/coach/refusal";
import type { Locale } from "@/lib/i18n/config";
import {
  coachOutboundFallback,
  screenCoachReply,
} from "@/lib/ai/coach/outbound-guard";
import {
  findUnverifiedCoachNumbers,
  stripUnverifiedNumbers,
} from "@/lib/ai/coach/coach-prose-grounding";
import { appendMessage } from "@/lib/ai/coach/persistence";
import type { CoachStreamEvent } from "@/lib/ai/coach/types";

import { loadDocumentChatText } from "@/lib/documents/content-index";
import {
  buildFencedChatSystemPrompt,
  type FencedDoc,
} from "@/lib/documents/document-chat-prompt";
import { resolveDocumentTextProvider } from "@/lib/documents/provider-order";

const FENCED_SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const HEARTBEAT_MS = 12_000;
const HEARTBEAT_FRAME = new TextEncoder().encode(": ka\n\n");

/** Prior turns kept verbatim in the per-call window — fenced chats are short. */
const HISTORY_TURN_CAP = 20;

export interface FencedTurn {
  role: "user" | "assistant";
  content: string;
}

function encodeFencedFrame(event: CoachStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** Split a full reply into ~word-sized chunks for a streaming feel. */
function tokeniseForStreaming(content: string): string[] {
  if (!content) return [];
  const matches = content.match(/\S+\s*/g);
  return matches ?? [content];
}

/** Yield to the event loop so each SSE frame flushes as its own chunk. */
function flushTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A standalone SSE stream carrying a single structured error frame (HTTP 200). */
function streamFencedError(code: string): Response {
  const stream = createSseStream((controller) => {
    controller.enqueue(
      encodeFencedFrame({ type: "error", code, message: code }),
    );
  });
  return new Response(stream, { status: 200, headers: FENCED_SSE_HEADERS });
}

// ─── Owner-scoped context loader (the second ownership layer) ────────────────

export interface FencedDocContext extends FencedDoc {
  documentId: string;
  source: "verbatim" | "normalised";
}

export type LoadFencedResult =
  | { ok: true; docs: FencedDocContext[] }
  | { ok: false; unavailableDocId: string };

/**
 * Load every attached document's label + fenced text, OWNER-SCOPED. Each id is
 * checked twice: once for liveness + label (`deletedAt: null`, owner-narrowed)
 * and once through `loadDocumentChatText` (owner-scoped, indexed-only). A miss on
 * EITHER — deleted, soft-deleted, foreign (corrupted join row), or un-indexed —
 * fails the WHOLE turn (never a partial-context reply). Returns the failing id so
 * the route names it in the 422.
 */
export async function loadFencedDocuments(
  userId: string,
  documentIds: string[],
): Promise<LoadFencedResult> {
  const docs: FencedDocContext[] = [];
  for (const documentId of documentIds) {
    const meta = await prisma.inboundDocument.findFirst({
      where: { id: documentId, userId, deletedAt: null },
      select: { title: true, filename: true },
    });
    if (!meta) return { ok: false, unavailableDocId: documentId };
    const context = await loadDocumentChatText(userId, documentId);
    if (!context) return { ok: false, unavailableDocId: documentId };
    docs.push({
      documentId,
      title: meta.title,
      filename: meta.filename,
      text: context.text,
      source: context.source,
    });
  }
  return { ok: true, docs };
}

// ─── Inbound + replay injection screen ──────────────────────────────────────

export type FencedInboundScreen =
  | { refuse: false }
  | {
      refuse: true;
      reason: CoachRefusalReason | null;
      refusalText: string;
      replayTurnIndex: number | null;
    };

/**
 * The inbound refusal + replay-injection guard, verbatim from the single-doc
 * route: `detectRefusal` on the inbound message, then re-run over every prior
 * USER turn (an injection that slipped the regex on an earlier turn would
 * re-enter the prompt every reply). On a hit the caller streams the refusal.
 */
export function screenFencedInbound(args: {
  message: string;
  priorTurns: FencedTurn[];
  locale: Locale;
}): FencedInboundScreen {
  const inbound = detectRefusal({
    message: args.message,
    locale: args.locale,
    defaultAllow: true,
  });
  if (inbound.refuse && inbound.message) {
    return {
      refuse: true,
      reason: inbound.reason,
      refusalText: inbound.message,
      replayTurnIndex: null,
    };
  }
  for (let i = 0; i < args.priorTurns.length; i++) {
    const turn = args.priorTurns[i];
    if (turn.role !== "user") continue;
    const replayed = detectRefusal({
      message: turn.content,
      locale: args.locale,
    });
    if (!replayed.refuse) continue;
    return {
      refuse: true,
      reason: replayed.reason,
      replayTurnIndex: i,
      refusalText:
        replayed.message ??
        (args.locale === "de"
          ? "Eine frühere Nachricht in dieser Unterhaltung enthält Anweisungen, die meine Vorgaben überschreiben sollen. Beginne bitte eine neue Unterhaltung."
          : "An earlier message in this conversation contains wording that overrides my instructions. Please start a new conversation."),
    };
  }
  return { refuse: false };
}

/**
 * Stream a refusal as a single `token` frame + `done`, persisting the user turn
 * + the refusal message against an EXISTING conversation (the caller resolves /
 * creates it first, so the rail shows the attempt). No provider call.
 */
export async function streamFencedRefusal(args: {
  conversationId: string;
  message: string;
  refusalText: string;
}): Promise<Response> {
  await appendMessage({
    conversationId: args.conversationId,
    role: "user",
    content: args.message,
  });
  const refusalMessage = await appendMessage({
    conversationId: args.conversationId,
    role: "assistant",
    content: args.refusalText,
    providerType: "refusal",
  });
  const stream = createSseStream((controller) => {
    controller.enqueue(
      encodeFencedFrame({ type: "token", token: args.refusalText }),
    );
    controller.enqueue(
      encodeFencedFrame({
        type: "done",
        conversationId: args.conversationId,
        messageId: refusalMessage.id,
      }),
    );
  });
  return new Response(stream, { status: 200, headers: FENCED_SSE_HEADERS });
}

// ─── The turn pipeline ──────────────────────────────────────────────────────

export interface StreamFencedReplyArgs {
  userId: string;
  conversationId: string;
  /** The LIVE attached documents, already owner-scope-loaded (§loadFencedDocuments). */
  docs: FencedDocContext[];
  priorTurns: FencedTurn[];
  message: string;
  /** Reply language contract ("en" | "de"). */
  contractLocale: "en" | "de";
  /** i18n locale for outbound-guard fallbacks. */
  locale: Locale;
  signal: AbortSignal;
}

/**
 * Run ONE fenced turn against a resolved conversation and its live documents, and
 * return the SSE response. May throw `ConsentRequiredError` (403, rendered as
 * JSON by the api-handler) BEFORE any egress — the consent fan-out runs first.
 */
export async function streamFencedReply(
  args: StreamFencedReplyArgs,
): Promise<Response> {
  const { userId, conversationId, docs, message, contractLocale, locale } =
    args;

  // ── Provider resolution: document order (local-first, codex last), SINGLE
  // pick, NO cascade — so the exact egress equals the consent-checked target. ──
  const { pick } = await resolveDocumentTextProvider(userId);
  if (!pick) {
    annotate({ action: { name: "documents.chat.noProvider" } });
    return streamFencedError("documents.chat.provider.none");
  }

  // ── Per-document egress consent fan-out. Structured as a loop over the live
  // attachments (annotated per doc id) so a future per-document consent
  // dimension slots into this seam. ALL must clear or the first throws
  // ConsentRequiredError (403) — zero egress on partial consent, BEFORE budget
  // and BEFORE the user turn is persisted. ──
  for (const doc of docs) {
    annotate({
      action: { name: "documents.chat.consent_check" },
      meta: { documentId: doc.documentId, provider: pick.providerType },
    });
    await assertDocumentEgressConsent({
      userId,
      providerType: pick.providerType,
      surface: "insights",
    });
  }

  // Persist the user's turn first so it's on disk regardless of the outcome.
  await appendMessage({ conversationId, role: "user", content: message });

  // ── Budget reservation (atomic, before the provider call) ──
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentChat.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
    "coach",
  );
  if (!reservation.allowed) {
    annotate({ action: { name: "documents.chat.budget.exceeded" } });
    return streamFencedError("documents.chat.budget.exceeded");
  }

  // ── Prompt: persona + shared safety spine + EACH document's header + fence,
  // NO health snapshot. Combined-context truncation is honest + annotated. ──
  const fencedDocs: FencedDoc[] = docs.map((d) => ({
    title: d.title,
    filename: d.filename,
    text: d.text,
  }));
  const { prompt: systemPrompt, perDoc } = buildFencedChatSystemPrompt(
    contractLocale,
    fencedDocs,
  );
  if (perDoc.some((d) => d.truncated)) {
    annotate({
      action: { name: "documents.chat.context_truncated" },
      meta: {
        docs: perDoc.map((d, i) => ({
          documentId: docs[i].documentId,
          bytes: d.bytes,
          truncated: d.truncated,
        })),
      },
    });
  }

  const window: FencedTurn[] = [
    ...args.priorTurns.slice(-HISTORY_TURN_CAP),
    { role: "user", content: message },
  ];
  const transcript = window
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");
  const userPrompt = `CONVERSATION
${transcript}

Reply now as the assistant, grounded ONLY in the documents above, in ${
    contractLocale === "de" ? "German" : "English"
  }.`;

  // The authoritative grounding set: the LIVE attachments' texts only. Never
  // history, never a snapshot (none exists) — recomputed from `docs` this turn.
  const groundingSources = docs.map((d) => d.text);

  type Outcome =
    | {
        ok: true;
        replyText: string;
        messageId: string;
        totalTokens: number;
        model: string | null;
      }
    | { ok: false; code: string };

  async function produceReply(): Promise<Outcome> {
    let result;
    try {
      const fallback = await runStreamingRawCompletionWithFallback({
        surface: "coach",
        userId,
        // Single-provider — the document-ordered pick, no cascade.
        providers: [pick!.entry],
        onDelta: () => {},
        params: singleUserTurn({
          system: systemPrompt,
          user: userPrompt,
          temperature: AI_BUDGETS.documentChat.temperature,
          maxTokens: AI_BUDGETS.documentChat.maxTokens,
          signal: args.signal,
        }),
      });
      result = fallback.result;
    } catch (err) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      }).catch(() => {});
      if (err instanceof AllProvidersFailedError) {
        const allRateLimited =
          err.attempts.length > 0 &&
          err.attempts.every((a) => a.httpStatus === 429);
        annotate({
          action: { name: "documents.chat.providerFailed" },
          meta: {
            attempts: err.attempts.length,
            credentialExpired: err.primaryCredentialExpired,
          },
        });
        if (err.primaryCredentialExpired) {
          return {
            ok: false,
            code: "documents.chat.provider.credential_expired",
          };
        }
        return {
          ok: false,
          code: allRateLimited
            ? "documents.chat.provider.rate_limited"
            : "documents.chat.provider.unavailable",
        };
      }
      annotate({
        action: { name: "documents.chat.providerFailed" },
        meta: { attempts: 1, unwrapped: true },
      });
      return { ok: false, code: "documents.chat.provider.unavailable" };
    }

    const totalTokens = result.tokensUsed ?? 0;
    const cachedTokens = result.cachedInputTokens ?? 0;
    await reconcileSpend(
      userId,
      reservation.reserved,
      totalTokens,
      dateKey,
      cachedTokens,
      { servedBy: pick!.entry.providerType, reservedOwner: reservation.owner },
    ).catch(() => {});

    let replyText = (result.content ?? "").trim();
    if (!replyText) return { ok: false, code: "documents.chat.provider.empty" };

    // ── Outbound safety screen (dose-prescription / fabricated risk) ──
    const outbound = screenCoachReply(replyText, locale);
    if (outbound.block && outbound.reason) {
      replyText = coachOutboundFallback(outbound.reason, locale);
      annotate({
        action: { name: "documents.chat.outbound_blocked" },
        meta: { reason: outbound.reason },
      });
      await auditLog("documents.chat.outbound_blocked", {
        userId,
        details: { conversationId, reason: outbound.reason },
      });
    }

    // ── Numeric grounding — authoritative set = the LIVE attachments' numbers ──
    // v1.32.14 — count of figures withheld from this reply (each rewritten to the
    // elision mark), hoisted so the minimal provenance envelope below carries it.
    let unverifiedStripped = 0;
    if (!outbound.block) {
      const unverified = findUnverifiedCoachNumbers(
        replyText,
        groundingSources,
        locale,
      );
      if (unverified.length > 0) {
        const { prose, stripped } = stripUnverifiedNumbers(
          replyText,
          unverified,
        );
        replyText = prose;
        unverifiedStripped = stripped;
        annotate({
          action: { name: "documents.chat.number_unverified" },
          meta: {
            flagged: unverified.length,
            stripped,
            tokens: unverified.slice(0, 6).map((u) => u.source),
          },
        });
      }
    }

    const assistant = await appendMessage({
      conversationId,
      role: "assistant",
      content: replyText,
      // v1.32.14 — the fenced path otherwise persists no provenance; when the
      // guard withheld a figure, ride a MINIMAL envelope so the per-message notice
      // renders and survives reload. Count only, no values, no windows/metrics.
      metricSource:
        unverifiedStripped > 0
          ? { windows: [], metrics: [], unverifiedFigures: unverifiedStripped }
          : null,
      providerType: pick!.providerType,
      tokensUsed: totalTokens || null,
      model: result.model ?? null,
    });

    annotate({
      action: { name: "documents.chat.replied" },
      meta: {
        provider: pick!.providerType,
        tokens: totalTokens,
        conversationId,
        attachmentCount: docs.length,
        documentIds: docs.map((d) => d.documentId),
        textSource: docs.map((d) => d.source),
        historyTurns: window.length,
      },
    });

    return {
      ok: true,
      replyText,
      messageId: assistant.id,
      totalTokens,
      model: result.model ?? null,
    };
  }

  const stream = createSseStream(async (controller) => {
    const heartbeat = setInterval(() => {
      controller.enqueue(HEARTBEAT_FRAME);
    }, HEARTBEAT_MS);

    let outcome: Outcome;
    try {
      outcome = await produceReply();
    } catch (err) {
      clearInterval(heartbeat);
      annotate({
        action: { name: "documents.chat.streamError" },
        meta: { message: err instanceof Error ? err.name : "unknown" },
      });
      if (!controller.signal.aborted) {
        controller.enqueue(
          encodeFencedFrame({
            type: "error",
            code: "documents.chat.provider.unavailable",
            message: "documents.chat.provider.unavailable",
          }),
        );
      }
      return;
    }
    clearInterval(heartbeat);

    if (!outcome.ok) {
      if (!controller.signal.aborted) {
        controller.enqueue(
          encodeFencedFrame({
            type: "error",
            code: outcome.code,
            message: outcome.code,
          }),
        );
      }
      return;
    }

    for (const tok of tokeniseForStreaming(outcome.replyText)) {
      if (controller.signal.aborted) return;
      controller.enqueue(encodeFencedFrame({ type: "token", token: tok }));
      await flushTick();
    }
    if (controller.signal.aborted) return;
    controller.enqueue(
      encodeFencedFrame({
        type: "done",
        conversationId,
        messageId: outcome.messageId,
        usage: {
          totalTokens: outcome.totalTokens || null,
          model: outcome.model,
        },
      }),
    );
  });

  return new Response(stream, { status: 200, headers: FENCED_SSE_HEADERS });
}
