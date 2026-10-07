/**
 * v1.4.20 — POST /api/insights/chat
 *
 * Streaming chat endpoint for the AI Coach. Returns Server-Sent
 * Events: one `token` frame per chunk of the assistant reply, then a
 * single `provenance` frame describing what the assistant could see,
 * and a closing `done` frame carrying the persisted message ids.
 *
 * This file owns the front door: auth, the `coach` AI capability
 * (refused with the capability envelope, except `no_provider`, which
 * keeps its `coach.provider.none` SSE frame with `reason`), the body
 * read and `coachChatRequestSchema`, the per-user rate limit, the
 * locale, and the inbound refusal screen (`detectRefusal` — a refusal
 * streams the localised copy and never reaches a provider).
 *
 * Everything after that — conversation, context, provider chain and
 * consent, the capability re-check at the egress site, the budget
 * reservation, the model, the reply guards, persistence and the
 * streamed frames — is the turn pipeline in `src/lib/ai/coach/turn/`.
 */

import { type NextRequest } from "next/server";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { coachChatRequestSchema } from "@/lib/ai/coach/types";
import { listConversations } from "@/lib/ai/coach/persistence";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import { runCoachTurn } from "@/lib/ai/coach/turn/pipeline";
import type { ReasoningLevel } from "@/lib/ai/reasoning/levels";
import { resolveCoachTurnReasoningLevel } from "@/lib/ai/reasoning/controls";
import { streamProviderError, streamRefusal } from "@/lib/ai/coach/turn/sse";
import { TURN_LIMITS } from "@/lib/ai/coach/tools/turn-budget";

/**
 * The `coach` capability gate for a turn. Every unavailable reason throws the
 * capability envelope (`assistant.disabled.coach`, `module.disabled`,
 * `consent.ai.required`, `ai.record.notPermitted`, `ai.unavailable`), except
 * `no_provider`: the streaming clients already read that one as the
 * `coach.provider.none` SSE frame, so it keeps that wire and gains `reason`.
 * Returns the frame to send, or null when the Coach is available.
 */
async function coachCapabilityRefusal(): Promise<Response | null> {
  try {
    await requireAiCapability("coach");
    return null;
  } catch (err) {
    if (err instanceof AiUnavailableError && err.reason === "no_provider") {
      annotate({ action: { name: "insights.coach.noProvider" } });
      return streamProviderError({
        code: "coach.provider.none",
        reason: "no_provider",
      });
    }
    throw err;
  }
}

/**
 * v1.41 — at most this many Coach turns of one person at once. A budgeted
 * turn can run for minutes; three tabs firing at the same time would run
 * three of them against one daily budget and one provider account.
 */
const COACH_CONCURRENT_TURNS = 2;
/**
 * How long a turn's slot is held at most: the longest turn's wall time
 * (`TURN_LIMITS.user.wallMs`, 200 s) plus 30 s for the streaming of its
 * reply. A slot whose release never arrived (a crashed process) frees itself
 * when the window ends.
 */
const COACH_TURN_SLOT_MS = TURN_LIMITS.user.wallMs + 30_000;

async function handleChatRequest(request: NextRequest): Promise<Response> {
  const auth = await requireAuth();
  // The `coach` capability, right after auth and before the rate limit and
  // the body parse. It folds in what the Coach module gate, the operator
  // switch and the `disableCoach` opt-out used to answer separately, plus
  // provider presence and consent.
  const refused = await coachCapabilityRefusal();
  if (refused) return refused;
  const userId = auth.user.id;

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      throw new HttpError(413, `Request body exceeds ${64 * 1024} bytes`);
    }
    body = JSON.parse(raw);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Invalid JSON body");
  }
  const parsed = coachChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "insights.coach.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    // The dotted token keeps its place in `error`: this refusal keeps its 422,
    // so moving the string would be a wire change with nothing forcing it —
    // the `invalid_json` siblings moved only because their status moved to 400
    // anyway. `meta.errorCode` publishes the same token in the field a machine
    // code belongs in, and `details.issues` names the fields that were refused.
    return apiValidationError(
      "coach.request.invalid",
      sanitiseZodIssues(parsed.error.issues),
      422,
      { errorCode: "coach.request.invalid" },
    );
  }
  const {
    conversationId,
    message,
    locale: bodyLocale,
    scope,
    guidedQuestion,
    workoutId,
    followUp,
    clarification,
    memoryDecision,
    planDecision,
  } = parsed.data;

  // Per-user request-rate ceiling layered in front of the daily budget
  // gate. The budget catches the cost dimension; this catches the
  // request-rate dimension (a tight loop or a stolen session can burn
  // the budget in seconds while pinning Prisma + provider slots before
  // the budget arithmetic catches up). 20 / minute is well outside any
  // realistic interactive use — a human can't type that fast, the iOS
  // client paces from user gestures.
  const rl = await checkRateLimit(`coach-chat:${userId}`, 20, 60 * 1000);
  if (!rl.allowed) {
    annotate({
      action: { name: "insights.coach.rate-limited" },
      meta: { userId, resetAt: rl.resetAt },
    });
    return apiError("Too many Coach requests, please wait a moment", 429);
  }

  // v1.18.7 (SENIOR-DEV HIGH) — the daily token cap is enforced atomically
  // by reserving budget right before the provider call (`reserveTurnBudget`
  // in the turn pipeline), not by a read-then-write here. The old
  // read-before-call gate let concurrent requests all pass the cap.

  const locale = await resolveServerLocale({
    request,
    override: bodyLocale,
    userLocale: auth.user.locale ?? null,
  });

  // ── Refusal short-circuit ────────────────────────────────────
  // v1.16.6 — the guided-flow question rides the prompt too, so it
  // runs through the same regex bank as the message. The questions
  // are server-derived in the honest case; this guards the dishonest
  // one (a crafted client using the field as an unchecked channel).
  const refusal = detectRefusal({
    message: guidedQuestion ? `${guidedQuestion}\n${message}` : message,
    locale,
  });
  if (refusal.refuse && refusal.message) {
    annotate({
      action: { name: "insights.coach.refused" },
      meta: { reason: refusal.reason },
    });
    return streamRefusal({
      userId,
      conversationId,
      message,
      refusalText: refusal.message,
    });
  }

  // v1.41 — the person's effective reasoning level: their choice after the
  // operator's switch and highest level, from the shared resolver. Who pays
  // is not known until the turn resolves its chain, so the turn applies the
  // operator-paid ceiling itself (`turn/reasoning.ts`); the provider's own
  // ability is left to its client.
  const reasoningLevel: ReasoningLevel = await resolveCoachTurnReasoningLevel(
    auth.user.coachPrefsJson,
  );

  // v1.41 — the person's turn slot. The counter is the rate-limit row's own
  // (an atomic upsert), given back when the turn is over; a refused slot is
  // given back at once, since the refused attempt never ran.
  const slotKey = `coach-turn-active:${userId}`;
  const slot = await checkRateLimit(
    slotKey,
    COACH_CONCURRENT_TURNS,
    COACH_TURN_SLOT_MS,
  );
  const releaseSlot = () => {
    void refundRateLimit(slotKey).catch(() => {
      // The window frees the slot on its own.
    });
  };
  if (!slot.allowed) {
    releaseSlot();
    annotate({
      action: { name: "insights.coach.concurrent-limited" },
      meta: { limit: COACH_CONCURRENT_TURNS },
    });
    return apiError("Too many Coach requests, please wait a moment", 429);
  }

  // Conversation, context, chain, egress re-check, budget, and the streamed
  // reply: `src/lib/ai/coach/turn/`.
  return runCoachTurn({
    userId,
    locale,
    signal: request.signal,
    conversationId,
    message,
    scope,
    guidedQuestion,
    workoutId,
    followUp,
    clarification,
    memoryDecision,
    planDecision,
    reasoningLevel,
    releaseSlot,
    recheckCapability: coachCapabilityRefusal,
  });
}

// Idempotency is intentionally NOT applied to this SSE-streaming route.
// `withIdempotency()` caches the response body via `cloned.text()` and
// replays it through `NextResponse.json(JSON.parse(...))` — that path
// turns an SSE wire format (`data: …\n\n` frames) into a `null` body
// because the cached text isn't JSON. The PWA never sets
// `Idempotency-Key` here so the bug is invisible today, but the iOS
// client does. Dedup still holds: a duplicate first-turn POST creates
// a second conversation row (cheap), and follow-up turns are gated by
// the conversationId existence check + 20-turn cap.
export const POST = apiHandler(handleChatRequest);

/** v1.30.2 (QoL H1) — hard cap on the `?q=` search string length. */
const LIST_QUERY_MAX_LEN = 200;

/**
 * GET /api/insights/chat?cursor=<id>&limit=<n>&q=<text>
 *
 * Cursor-paginated list of the caller's conversations for the rail.
 * Default limit 20, hard cap 50. Cursor is the id of the last item
 * on the previous page; callers receive `{ nextCursor: null }` when
 * they have reached the end.
 *
 * v1.30.2 (QoL H1) — optional `q` narrows the page to conversations whose
 * TITLE contains the text (case-insensitive substring). This makes the
 * history rail's search reach the caller's FULL conversation set instead
 * of only the loaded page; the client re-issues the cursor walk under the
 * new `q` whenever the search box changes rather than filtering client-
 * side. Message bodies are encrypted at rest and are NOT searched — a
 * decrypt-and-scan over every message would be prohibitively expensive
 * for a live keystroke search and is out of scope for this pass.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth();
  // Never AI-gated and never module-gated: the conversation list is the
  // person's stored data. It stays readable while the Coach is unavailable
  // for any reason, so every thread can be found and deleted.
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const qRaw = url.searchParams.get("q");
  const q = qRaw ? qRaw.trim().slice(0, LIST_QUERY_MAX_LEN) : undefined;

  const page = await listConversations({
    userId: auth.user.id,
    cursor,
    limit: Number.isFinite(limit) ? (limit as number) : undefined,
    q,
    // v1.28.51 (Documents R3, Design A) — the rail now surfaces BOTH health
    // threads and doc-scoped threads (the DTO carries `documentId` +
    // `documentTitle` so the client badges the fenced ones). Omitting the
    // `documentId` key drops the filter entirely — a union of both scopes —
    // while `userId` stays narrowed from the session, so the relaxation never
    // widens ownership. Doc turns still POST to the hardened document endpoint,
    // never this route (see the `documentId: null` guard on the POST path).
  });

  annotate({
    action: { name: "insights.coach.list" },
    meta: { count: page.conversations.length, hasQuery: Boolean(q) },
  });

  return apiSuccess(page);
});

// Disable the static-page optimisation; we are always streaming.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
