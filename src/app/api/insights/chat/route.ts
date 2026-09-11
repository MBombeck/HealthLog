/**
 * v1.4.20 — POST /api/insights/chat
 *
 * Streaming chat endpoint for the AI Coach. Returns Server-Sent
 * Events: one `token` frame per chunk of the assistant reply, then a
 * single `provenance` frame describing what the assistant could see,
 * and a closing `done` frame carrying the persisted message ids.
 *
 * Behaviour:
 *   1. requireAuth() — cookie session OR bearer token (iOS app).
 *   2. Validate body with `coachChatRequestSchema`.
 *   3. reserveBudget(resolveDailyCap(chain)) — 429 with
 *      `coach.budget.exceeded` when the day's token cap for the
 *      credential that would pay for the call is already burned.
 *   4. detectRefusal() — pattern-based prompt-injection +
 *      off-topic guard. Refusal emits a single `token` frame with
 *      the localised refusal copy and a `done` frame; never hits a
 *      provider.
 *   5. Idempotency: only when `conversationId` is absent (= the user
 *      is creating a new conversation). withIdempotency() caches the
 *      streamed body so a retry under the same Idempotency-Key
 *      replays the original assistant message instead of double-
 *      creating the conversation.
 *   6. Provider chain — runRawCompletionWithFallback() walks the
 *      user's configured providers; on AllProvidersFailedError emit
 *      an `error` frame and persist nothing.
 *   7. Persist user message + assistant message (encrypted) and bump
 *      the day's CoachUsage token ledger.
 */
import { type NextRequest } from "next/server";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import { redactOptional, redactSecrets } from "@/lib/logging/redact";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/gate";

import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { localeLanguageNames as LANGUAGE_NAMES } from "@/lib/i18n/config";
import {
  AllProvidersFailedError,
  runStreamingRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { resolveProviderChain, resolveProvider } from "@/lib/ai/provider";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import { singleUserTurn, type CompletionResult } from "@/lib/ai/types";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

import {
  coachChatRequestSchema,
  type CoachStreamEvent,
} from "@/lib/ai/coach/types";
import {
  appendMessage,
  createConversation,
  fetchConversationWithMessages,
  listConversations,
} from "@/lib/ai/coach/persistence";
import { enqueueCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-shared";
import { instructionLocale } from "@/lib/ai/prompts/output-language";
import { storeDeterministicFacts } from "@/lib/ai/coach/facts";
import {
  buildDateKey,
  reserveBudget,
  reconcileSpend,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import {
  screenCoachReply,
  coachOutboundFallback,
} from "@/lib/ai/coach/outbound-guard";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import {
  openerArchetypeHint,
  shouldUseNameForTurn,
  firstNameFromDisplayName,
} from "@/lib/ai/prompts/opener-archetype";
import { getSelfContextTextForUser } from "@/lib/ai/coach/about-me";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import {
  buildCoachProviderPrompts,
  buildCoachToolRequest,
  buildCoachTurnContext,
  type CoachTurn,
} from "@/lib/ai/coach/chat-request-builder";
import { buildWorkoutEvidenceSection } from "@/lib/ai/coach/workout-evidence-builder";
import {
  COACH_TOOL_DEFS,
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  buildToolModeAddendum,
  runCoachToolLoop,
  MAX_ROUNDS,
  type CoachToolTrace,
} from "@/lib/ai/coach/tools";
import { parseKeyValuesSentinel } from "@/lib/ai/coach/keyvalues";
import {
  findUnverifiedCoachNumbersInLedger,
  stripUnverifiedNumbers,
} from "@/lib/ai/coach/coach-prose-grounding";
import {
  buildGroundingLedger,
  figuresForPersistence,
} from "@/lib/ai/coach/grounding-ledger";
import { getScheduledDoseValues } from "@/lib/medications/scheduled-doses";
import { scrubUnknownLearnLinks } from "@/lib/ai/coach/learn-link-guard";
import { parseSuggestReminder } from "@/lib/ai/coach/suggest-reminder";
import { gateSuggestion } from "@/lib/ai/coach/suggest-gate";
import {
  parseRememberSentinel,
  captureReminderFromSentinel,
  buildRememberAddendum,
} from "@/lib/ai/coach/reminders";
import {
  parseSuggestAction,
  buildSuggestActionAddendum,
  type CoachSuggestedAction,
} from "@/lib/ai/coach/suggest-action";
import {
  parseCoachPrefs,
  DEFAULT_REMINDER_SUGGESTION_PREFS,
} from "@/lib/validations/coach-prefs";
import type { CoachSuggestion } from "@/lib/ai/coach/types";
import { createSseStream } from "@/lib/sse/create-stream";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function encodeFrame(event: CoachStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * v1.22 (#89) — keepalive heartbeat. An SSE COMMENT frame (a line starting
 * with `:`) carries no `data:` payload, so the Coach client's frame parser
 * (`parseSseChunk` finds the `data:` line; a comment frame has none) drops it
 * silently — exactly what a keepalive should be. Flushed on `HEARTBEAT_MS`
 * while the provider is still loading the model / generating, so a reverse
 * proxy never idle-drops the long-lived SSE connection.
 */
const HEARTBEAT_MS = 12_000;
const HEARTBEAT_FRAME = new TextEncoder().encode(": ka\n\n");

/**
 * Split a full assistant reply into ~roughly-word-sized chunks so the
 * UI gets a "streaming" feel even when the underlying provider client
 * returned the body in one shot.
 */
function tokeniseForStreaming(content: string): string[] {
  if (!content) return [];
  // Split on whitespace boundaries while preserving the spaces — keeps
  // word boundaries intact and avoids the UI having to glue tokens.
  const matches = content.match(/\S+\s*/g);
  return matches ?? [content];
}

/**
 * v1.12.0 — yield control back to the event loop for one tick so the
 * stream controller flushes the just-enqueued frame before the next one
 * is produced. `setTimeout(0)` (rather than a bare `Promise.resolve()`
 * microtask) hands the turn back to the platform's stream pump so each
 * SSE frame lands in its own network chunk; a microtask would drain
 * before the runtime gets a chance to flush. The delay is intentionally
 * zero — we want incremental delivery, not an artificial typewriter
 * pause.
 */
function flushTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function handleChatRequest(request: NextRequest): Promise<Response> {
  const auth = await requireAuth();
  // v1.18.0 — two-layer module gate (operator availability + per-user
  // disableCoach) on top of the legacy assistant flag. 403 module.disabled.
  const gate = await requireModuleEnabled(auth.user.id, "coach");
  if (!gate.enabled) return gate.response;
  // v1.4.31 — operator can disable the Coach surface app-wide.
  // Throws AssistantDisabledError → apiHandler returns 403 +
  // `errorCode: "assistant.disabled.coach"` per the iOS contract.
  await requireAssistantSurface("coach");
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
  // by reserving budget BEFORE the provider call (see the reservation right
  // before `runRawCompletionWithFallback`), not by a read-then-write here.
  // The old read-before-call gate let concurrent requests all pass the cap.

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

  // ── Conversation resolution ──────────────────────────────────
  let workingConversationId: string;
  let priorTurns: CoachTurn[] = [];
  // v1.32.9 (Coach Guard II / G2) — cross-turn Grounding Ledger sources. Prior
  // USER messages (numbers the user themselves stated) and the persisted
  // per-turn tool figures of prior turns (`groundedFigures` — server-computed
  // magnitudes, NEVER the assistant's prose, per D3). Both feed reconciliation
  // so a figure recalled a turn later is not stripped, without a laundering
  // path through assistant narration.
  let priorUserMessages: string[] = [];
  let priorToolFigures: number[] = [];
  // v1.11.1 — rolling summary of the elided older turns, read stale-while-
  // revalidate; null for a fresh conversation or when none is on file.
  let priorSummary: string | null = null;

  if (conversationId) {
    // v1.29.x (S7) — the load-bearing prompt-injection fence, now a DUAL
    // predicate. Untrusted document text may only enter an LLM prompt on the
    // fenced pipeline (no tools, no snapshot). This tool route must never load a
    // fenced conversation:
    //   PRIMARY  — `documentScoped: false` in the WHERE. The sticky flag is set
    //              at fenced-creation / first-attach and NEVER cleared, so a
    //              conversation that has EVER held a document 404s here forever.
    //   BACKSTOP — even so, assert zero live attachments. `documentScoped: false`
    //              with an attachment row present is flag/join drift (an
    //              invariant broke somewhere): fail closed, loudly.
    // A doc turn is routed by the client to `/api/insights/chat/fenced` (or the
    // single-doc sheet endpoint). Should a fenced id ever reach THIS route the
    // fetch returns nothing and the turn 404s rather than running an injected
    // instruction against the coach's write tools. Do not relax.
    const existing = await fetchConversationWithMessages(
      userId,
      conversationId,
      { documentScoped: false },
    );
    if (!existing) {
      // 404, not 403 — never reveal cross-user / cross-mode existence
      throw new HttpError(404, "coach.conversation.notFound");
    }
    if (existing.attachmentCount > 0) {
      // Drift alarm — telemetry AND an audit row (not routine telemetry).
      annotate({
        action: { name: "insights.coach.fence_drift" },
        meta: { conversationId: existing.id },
      });
      await auditLog("insights.coach.fence_drift", {
        userId,
        details: { conversationId: existing.id },
      });
      throw new HttpError(404, "coach.conversation.notFound");
    }
    workingConversationId = existing.id;
    priorSummary = existing.summary ?? null;
    // #781 — cancelled-turn markers (`providerType: "cancelled"`, empty body)
    // are UI rows, not conversation content: keep them out of the provider
    // transcript so an interrupted turn adds no empty assistant line to the
    // prompt. They stay in the DTO the client renders.
    priorTurns = existing.messages
      .filter((m) => m.providerType !== "cancelled")
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));
    // Ledger cross-turn sources (D3-safe): user-authored numbers + the
    // persisted tool figures of prior turns. Assistant PROSE is never read.
    priorUserMessages = existing.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    priorToolFigures = existing.messages.flatMap((m) =>
      m.metricSource?.groundedFigures
        ? [...m.metricSource.groundedFigures]
        : [],
    );

    // v1.4.43 W13 M-3 — replay-injection guard. `detectRefusal` runs
    // only on the inbound `message` per turn, so an injection that
    // slipped past the regex bank on a previous turn would re-enter
    // the prompt every reply. Re-run the detector against every
    // user-turn re-loaded from DB; on a hit, short-circuit the SSE
    // with a refusal AND drop an `insights.coach.replay_injection`
    // row so the failure case is observable. The audit row carries
    // the conversation id (server-owned), the turn index (no PII)
    // and the matched reason — never the message content. v1.4.43
    // W10 simplifier-L-2 — action name follows the `<surface>.<verb>`
    // convention (no `audit.` prefix; no `.replay-injection` dash).
    for (let i = 0; i < priorTurns.length; i++) {
      const turn = priorTurns[i];
      if (turn.role !== "user") continue;
      const replayed = detectRefusal({ message: turn.content, locale });
      if (!replayed.refuse) continue;
      annotate({
        action: { name: "insights.coach.replay_injection" },
        meta: { reason: replayed.reason, turnIndex: i },
      });
      await auditLog("insights.coach.replay_injection", {
        userId,
        details: {
          conversationId: existing.id,
          turnIndex: i,
          reason: replayed.reason,
        },
      });
      return streamRefusal({
        userId,
        conversationId: existing.id,
        message,
        refusalText:
          replayed.message ??
          getServerTranslator(locale).t("coach.refusal.conversationPoisoned"),
      });
    }
  } else {
    const created = await createConversation({ userId, title: message });
    workingConversationId = created.id;
  }

  // Persist the user's turn first so it's safely on disk regardless
  // of whether the provider call succeeds.
  await appendMessage({
    conversationId: workingConversationId,
    role: "user",
    content: message,
  });

  // Build the prompt: system + (optional) snapshot + recent history +
  // the new user message. v1.4.23 H4 — fold per-user prefs into the
  // system-prompt prefix; the snapshot builder reads the same prefs
  // separately so excluded metrics never even leave the DB.
  //
  // v1.4.25 W5 — `coachPrefs.defaultWindow` is the user's saved
  // analysis-window preference. Merge it into the snapshot scope when
  // the client didn't supply a per-conversation override; the override
  // (header pill / sources rail) always wins. Keep the merge cheap so
  // we don't accidentally widen narrow per-call scopes.
  const prefsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      coachPrefsJson: true,
      displayName: true,
      // v1.22 (#89) — per-user response timeout (seconds), mainly for slow
      // local/self-hosted backends. Threaded onto the provider call below.
      aiResponseTimeoutSeconds: true,
    },
  });
  const coachPrefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  // v1.22 (#89) — the upstream timeout for THIS turn's provider call. On the
  // streaming (local) path it is the per-idle-gap ceiling; on the buffered path
  // it is the whole-call ceiling. A generous ~180 s default replaces the legacy
  // 60 s client default that timed the Coach out on an MLX/exo backend whose
  // first request loads the model. Clamped to sane bounds at write-time.
  const aiResponseTimeoutMs =
    prefsRow?.aiResponseTimeoutSeconds != null
      ? prefsRow.aiResponseTimeoutSeconds * 1000
      : 180_000;
  const effectiveScope =
    scope?.window === undefined && coachPrefs.defaultWindow
      ? { ...(scope ?? {}), window: coachPrefs.defaultWindow }
      : scope;
  const snapshot = await buildCoachSnapshot(userId, effectiveScope);
  // v1.15.20 — the user-authored "about me" self-description (Settings →
  // AI) rides the system prompt as a delimited, user-provided context
  // block. Fail-open: a missing / undecryptable text yields null and the
  // prompt is byte-identical to the pre-feature one.
  // v1.16.0 — composed self-context: structured questionnaire fields
  // plus age/gender merged in from the User profile.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  // v1.32.9 (Coach Guard II / G3) — the user's active medication doses, for the
  // Grounding Ledger's `schedule` source AND the schedule-gated dose
  // continuation exemption. Fail-open: a read failure yields an empty set, which
  // keeps the Guard I phrase-anchored dose behaviour.
  const scheduleDoses = await getScheduledDoseValues(userId).catch(() => []);
  // v1.22 (B2/F6) — the canonical system-prompt module is owned elsewhere, so
  // the two memory/action clauses are appended at assembly time here: one
  // teaches the model to emit `---REMEMBER---` (durable "remind me" capture),
  // one teaches the closed `---SUGGEST-ACTION---` confirm-card allowlist. Both
  // are provider-neutral sentinels stripped from the prose before it streams.
  // v1.22 (W6) — per-turn personalization: a sparse, hash-gated first name and
  // an opener-archetype hint so multi-turn sessions vary. The turn index is the
  // count of prior turns, so the name surfaces on ~1-in-3 turns, varied and
  // never on a fixed cadence; both omit cleanly when no display name is set.
  const turnIndex = priorTurns.length;
  const firstName = firstNameFromDisplayName(prefsRow?.displayName ?? null);
  const coachPersonalization = {
    firstName,
    mayUseName:
      firstName != null && shouldUseNameForTurn(`${userId}:${turnIndex}`),
    openerHint: openerArchetypeHint(`${userId}:${turnIndex}`, locale),
  };
  const baseSystemPrompt = getCoachSystemPrompt(
    locale,
    coachPrefs,
    aboutMe,
    coachPersonalization,
  );
  const turnContext = buildCoachTurnContext({
    priorTurns,
    priorSummary,
    message,
    guidedQuestion,
  });
  const { window, isFirstTurn, includeFullSnapshot } = turnContext;
  // v1.11.1 — once a conversation grows past the history cap, refresh the
  // rolling summary + extract durable facts off the request path. Fire-and-
  // forget: this turn uses whatever summary is already on disk; the refresh
  // makes the next long turn fresh. No-ops without an embedded worker.
  // v1.16.1 — always-remember categories (allergies, intolerances, explicit
  // self-reported diagnoses) must not wait for the >TURN_CAP memory refresh:
  // a health-critical statement in the second message of a short chat used
  // to never reach the fact store. The deterministic pattern pass is
  // provider-free and deduped, so it fires on every user turn.
  void storeDeterministicFacts({
    conversationId: workingConversationId,
    userId,
    message,
    locale,
  }).catch(() => {
    // Fact capture must never break the chat turn; the >TURN_CAP LLM
    // extraction remains as the catch-all on long conversations.
  });
  if (turnContext.historyElided) {
    void enqueueCoachMemoryRefresh({
      conversationId: workingConversationId,
      userId,
      // Coach memory prose is composed in de/en only — it is MODEL-FACING
      // context (a rolling conversation summary + extracted durable facts),
      // not user-facing prose, so English is the correct target for every
      // locale without a reviewed body. The former `=== "en" ? "en" : "de"`
      // binary composed and keyed a French account's memory in German.
      locale: instructionLocale(locale),
    });
  }

  // A workout launch is an optional narrowing of Coach, not permission to
  // bypass the workouts module. Disabled modules contribute no read and no
  // provider payload; the generic conversation still proceeds.
  const workoutsEnabled =
    !workoutId || (await isModuleEnabled(userId, "workouts"));
  const workoutEvidence =
    isFirstTurn && workoutId && workoutsEnabled
      ? await buildWorkoutEvidenceSection(userId, workoutId)
      : null;
  if (workoutId) {
    annotate({
      action: { name: "coach.launch.scoped" },
      meta: {
        source: "workout",
        // Whether the narrow actually resolved. A foreign / stale id finds
        // nothing and the conversation simply proceeds unscoped.
        resolved: workoutEvidence !== null,
        firstTurn: isFirstTurn,
      },
    });
  }
  const { systemPrompt, userPrompt } = buildCoachProviderPrompts({
    baseSystemPrompt,
    rememberAddendum: buildRememberAddendum(locale),
    suggestActionAddendum: buildSuggestActionAddendum(locale),
    languageName: LANGUAGE_NAMES[locale],
    snapshotJson: snapshot.snapshotJson,
    referenceGrounding: snapshot.referenceGrounding,
    workoutEvidence,
    turnContext,
  });

  // ── Provider chain ──────────────────────────────────────────
  // v1.20.0 (F1) — provider capabilities select tool retrieval or the legacy
  // snapshot-stuffing path.
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      annotate({
        action: { name: "insights.coach.noProvider" },
      });
      return streamProviderError({ code: "coach.provider.none" });
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  // v1.12.1 — consent gate before any server-managed external egress. When
  // the chain could egress via the operator's global key, require an active
  // `ai_coach` (or master `ai_full`) receipt. BYOK / local / ChatGPT-OAuth
  // chains are the user's own egress and stay ungated. Throws
  // ConsentRequiredError → apiHandler returns 403 + `consent.ai.required`.
  await assertConsentForChain({ userId, chain, surface: "coach" });

  // v1.20.0 (F1) — tool mode is on only when EVERY provider in the chain
  // supports tool-calling, so whichever hop the fallback runner lands on can
  // still serve tools. A chain that includes a no-tools provider (local /
  // Ollama) falls back to the legacy snapshot-stuffing path verbatim, exactly
  // as before — the snapshot builder stays alive as the no-tools floor.
  const toolMode = chain.every((c) => c.instance.supportsTools !== false);

  // v1.18.7 (SENIOR-DEV HIGH) — atomically RESERVE the day's budget before
  // the provider call. The reservation increments the day's total by the
  // per-call ceiling (`maxTokens`) in one upsert and returns the new total;
  // concurrent requests serialise on the row so they cannot all pass the cap.
  // Over-cap → 429 refusal frame, reservation already refunded. The actual
  // token count is reconciled against this reservation after the call,
  // including on empty / sentinel replies (their tokens were still burned).
  //
  // v1.20.0 (F1) — the tool loop makes up to MAX_ROUNDS provider round-trips,
  // so reserve the per-call ceiling × the round count up front and reconcile
  // the SUMMED actual tokens afterwards. The atomic reserve/reconcile
  // primitives are unchanged; only the reserved amount scales.
  // v1.21.0 (F1) — the daily ceiling is the OPERATOR's cost cap only when the
  // chain egresses via the operator's own key (`admin-openai` primary). A
  // ChatGPT-OAuth/Codex or BYOK chain runs on the user's OWN plan/key and costs
  // the operator nothing, so it gets the generous user-plan ceiling — gating it
  // on the operator-cost cap would lock the user out of a plan they pay for.
  const dailyCap = resolveDailyCap(chain);
  const reqDateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    toolMode
      ? AI_BUDGETS.coach.maxTokens * MAX_ROUNDS
      : AI_BUDGETS.coach.maxTokens,
    reqDateKey,
    dailyCap,
    resolveCostOwner(chain),
    "coach",
  );
  if (!reservation.allowed) {
    // v1.38.19 (Wave E, fix round 1) — say WHICH ceiling refused and WHOSE.
    // `totalAfter` alone is the day's mixed total; on an operator refusal that
    // is not the counter that tripped, and reading `totalAfter: 1200000`
    // against a 200 000 ceiling is what turned the 06:42Z incident into a
    // production log dig. Integers and two small enums — no key, host or model
    // name is added.
    annotate({
      action: { name: "coach.budget.exceeded" },
      meta: {
        owner: reservation.owner,
        surface: "coach",
        limit: reservation.limit,
        cap: dailyCap,
        totalAfter: reservation.totalAfter,
        operatorAfter: reservation.operatorAfter,
      },
    });
    return streamProviderError({ code: "coach.budget.exceeded" });
  }

  // v1.22 (#89) — the provider call + every safety guard + persistence run
  // INSIDE the SSE stream now (see `produceReply` + the heartbeat-fronted
  // emit below). This is the real fix for a slow local backend: the HTTP
  // response headers flush immediately, a keepalive comment frame goes out
  // every few seconds while the model is still loading / generating so the
  // reverse proxy never idle-drops the connection, and the no-tools (local)
  // path streams real provider tokens with a per-idle-gap timeout instead of
  // one buffered fetch under a total-timeout. Client-visible token frames
  // still carry the FULLY-GUARDED text — every guard runs on the complete
  // reply before the first token frame leaves, exactly as before.
  type ReplyOutcome =
    | {
        ok: true;
        replyText: string;
        provenance: typeof snapshot.provenance;
        suggestion: CoachSuggestion | null;
        action: CoachSuggestedAction | null;
        messageId: string;
        totalTokens: number;
        model: string | null;
      }
    | { ok: false; code: string };

  async function produceReply(): Promise<ReplyOutcome> {
    let result: CompletionResult;
    // v1.38.19 (Wave E) — typed as the chain's provider union, not a bare
    // string: the budget reconcile attributes the turn's tokens to the cost
    // owner of the hop named here.
    let workingProviderType: ProviderChainType;
    let toolTrace: CoachToolTrace[] = [];
    // v1.21.0 (P6) — the present tool-result payloads this turn, for the post-hoc
    // prose number-verifier. Empty on the no-tools path.
    let toolResultPayloads: unknown[] = [];
    // v1.21.2 (A8) — no-tools/local-provider parity for the prose number-verifier.
    // The tool path grades prose against the figures the tools returned; the
    // no-tools path has no tools, so the authoritative set is the SNAPSHOT the
    // model was actually shown this turn — `snapshot.sections`, the structured
    // record `snapshotJson` is serialised from, which already carries the
    // correlations-snapshot block. Populated only when the full figures were
    // delivered this turn (`includeFullSnapshot`); on a cheap follow-up the block
    // was not re-sent, so there is no fresh authoritative set to grade against.
    let noToolsSnapshotPayloads: unknown[] = [];
    // The DATA INVENTORY manifest (per-domain sample counts) that rode this
    // turn's tool-mode prompt. Hoisted out of the tool branch because the
    // all-missed activation below needs it as a WIDENER: the counts were in
    // front of the model, so a plain count restatement ("you've logged 42 BP
    // readings") must stay grounded even on a turn whose every tool missed.
    // Never an ACTIVATOR on its own — see the v1.32.1 note below.
    let inventoryPayloads: unknown[] = [];
    let totalTokensSpent: number;
    // v1.21.0 (F3) — cached-input tokens to subtract at reconcile (prompt-cached
    // input the user did not re-pay for must not be billed to the daily meter).
    let cachedTokensSpent = 0;
    try {
      if (toolMode) {
        // v1.20.0 (F1) — base context: the full system prompt + a tool-mode
        // grounding addendum, with the tiny DATA INVENTORY manifest and the
        // transcript on the user turn. The figures are NOT in the prompt — the
        // model pulls only what it needs via the retrieval tools. The inventory
        // build reuses the snapshot we already computed (60s LRU), so the tools
        // that fire this turn share its reads.
        const inventory = await buildCoachDataInventory(userId, effectiveScope);
        const toolRequest = buildCoachToolRequest({
          systemPrompt,
          toolModeAddendum: buildToolModeAddendum(locale),
          focusHint: renderFocusHint(effectiveScope?.sources),
          workoutEvidence,
          dataInventory: renderDataInventory(inventory),
          guidedBlock: turnContext.guidedBlock,
          transcript: turnContext.transcript,
          languageName: LANGUAGE_NAMES[locale],
        });
        const loop = await runCoachToolLoop({
          userId,
          providers: chain,
          system: toolRequest.system,
          messages: toolRequest.messages,
          tools: COACH_TOOL_DEFS,
          temperature: AI_BUDGETS.coach.temperature,
          maxTokens: AI_BUDGETS.coach.maxTokens,
          fallbackWindow: effectiveScope?.window,
          // v1.21.0 (D5-1) — share the inventory's full-source snapshot across
          // every tool so the turn builds ONE snapshot, not one per tool. The
          // probe scope is the exact scope the inventory was built against, so the
          // per-tool reads land its 60s LRU entry.
          sharedScope: inventory.probeScope,
          // v1.20.1 — thread the abort signal so a mid-generation disconnect tears
          // down the per-round provider calls instead of paying the full cost.
          signal: request.signal,
          // v1.22 (#89) — per-user response timeout for each tool-round call.
          timeoutMs: aiResponseTimeoutMs,
        });
        result = loop.result;
        // The loop reports the hop it landed on as a bare string; it is
        // assigned from `workingProvider.providerType` one frame up.
        workingProviderType = loop.workingProviderType as ProviderChainType;
        toolTrace = loop.toolTrace;
        // v1.32.1 — the numeric verifier ACTIVATES only when this turn actually
        // delivered figures the model was told to ground against: a pinned
        // workout-evidence block or a present tool result. The DATA INVENTORY
        // manifest (sample counts per domain) is NOT an activator — it rides
        // every tool-mode prompt even on a turn where the model answered
        // without calling a tool, and on that turn the base prompt deliberately
        // carries no pre-computed figures (the model must fetch them), so the
        // verifier must stay dormant and leave the prompt-level grounding rule
        // as the backstop, exactly as on `main`. Activating it off the
        // counts-only inventory would flag a snapshot figure the model cited
        // without a fresh tool call as ungrounded (a real regression caught by
        // the integration suite). When the turn IS active, the inventory counts
        // still WIDEN the authoritative set so a plain count restatement
        // ("you've logged 42 BP readings") stays grounded.
        const presentToolPayloads = [
          ...(workoutEvidence === null ? [] : [workoutEvidence]),
          // A miss carries no `data` but may carry `available` — the bounded
          // out-of-window aggregate rule 3 lets the model cite. Ground it.
          ...(loop.toolResults ?? []).map((r) => r.data ?? r.available),
        ];
        inventoryPayloads = [inventory.entries];
        toolResultPayloads =
          presentToolPayloads.length > 0
            ? [...presentToolPayloads, inventory.entries]
            : [];
        totalTokensSpent = loop.totalTokens;
        cachedTokensSpent = loop.cachedTokens;
      } else {
        // v1.22 (#89) — the no-tools path (local / Ollama / exo, and any chain
        // that includes a non-tool provider) runs through the STREAMING runner so
        // the local client emits real tokens as they arrive and the per-idle-gap
        // timeout governs. `onDelta` counts streamed chunks for observability; the
        // heartbeat keeps the proxy connection warm and the assembled reply is
        // returned in full so every guard below still runs on the complete text.
        let streamedDeltas = 0;
        const fallback = await runStreamingRawCompletionWithFallback({
          surface: "coach",
          userId,
          providers: chain,
          onDelta: () => {
            streamedDeltas += 1;
          },
          // v1.20.0 — the no-tools path still builds one assembled user turn (the
          // transcript-flattening includes the current authoritative snapshot
          // on every stateless no-tools request), so it ships as a single user
          // message. The stable persona rides `system` and is cache-eligible.
          params: singleUserTurn({
            system: systemPrompt,
            user: userPrompt,
            temperature: AI_BUDGETS.coach.temperature,
            maxTokens: AI_BUDGETS.coach.maxTokens,
            // v1.20.1 — thread the request's abort signal so a mid-generation
            // client disconnect tears the upstream provider call down instead of
            // paying the full token cost into a closed connection.
            signal: request.signal,
            // v1.22 (#89) — per-idle-gap timeout for the streaming local call /
            // whole-call timeout for the buffered cloud fallback.
            timeoutMs: aiResponseTimeoutMs,
          }),
        });
        annotate({
          action: { name: "coach.stream.deltas" },
          meta: { deltas: streamedDeltas },
        });
        result = fallback.result;
        workingProviderType = fallback.workingProvider.providerType;
        totalTokensSpent = result.tokensUsed ?? 0;
        cachedTokensSpent = result.cachedInputTokens ?? 0;
        // v1.21.2 (A8) — the no-tools path grades only when it delivered the
        // full SNAPSHOT. Stateless provider requests always do; retaining the
        // conditional keeps the builder contract explicit and testable.
        if (includeFullSnapshot) {
          noToolsSnapshotPayloads = [
            snapshot.sections,
            ...(workoutEvidence === null ? [] : [workoutEvidence]),
          ];
        }
      }
    } catch (err) {
      // The provider chain failed outright — no tokens were billed, so refund
      // the full reservation before surfacing the error frame.
      await reconcileSpend(userId, reservation.reserved, 0, reqDateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      }).catch(() => {});
      // #781 — the client walked away mid-generation. The request's abort
      // signal is threaded into every provider call, so the teardown surfaces
      // here as an abort-shaped failure with `request.signal` already flipped.
      // Close the turn honestly instead of letting the user message dangle
      // unanswered: persist an EMPTY assistant marker tagged
      // `providerType: "cancelled"` (the same channel "refusal" and "nudge"
      // already use for non-provider rows) so the thread shows the turn as
      // interrupted and offers a retry on reload. The content is empty by
      // construction — nothing guarded was produced, and anything the client
      // ever SAW was persisted before the first token frame left, so no
      // unguarded partial text is ever written. The reservation was refunded
      // above; a retry pays exactly what a fresh turn pays.
      if (request.signal.aborted) {
        await appendMessage({
          conversationId: workingConversationId,
          role: "assistant",
          content: "",
          providerType: "cancelled",
          promptVersion: PROMPT_VERSION,
        }).catch(() => {
          // Marker persistence is best-effort — a failure leaves the
          // dangling user turn, which is exactly the pre-#781 state.
        });
        annotate({
          action: { name: "insights.coach.cancelled" },
          meta: { conversationId: workingConversationId },
        });
        return { ok: false, code: "coach.cancelled" };
      }
      if (err instanceof AllProvidersFailedError) {
        annotate({
          action: { name: "insights.coach.providerFailed" },
          meta: {
            attempts: err.attempts.length,
            firstStatus: err.attempts[0]?.httpStatus ?? null,
            credentialExpired: err.primaryCredentialExpired,
          },
        });
        // v1.11.0 W1 — when the user's PRIMARY provider failed with an
        // auth-class status (401/403), the credential is dead, not the
        // service. Surface a distinct `credential_expired` frame so the
        // drawer can deep-link the user to reconnect rather than telling
        // them to "try again later" — the gap that let an expired codex
        // token silently kill all generation.
        if (err.primaryCredentialExpired) {
          return { ok: false, code: "coach.provider.credential_expired" };
        }
        // v1.4.25 W5 — distinguish provider rate-limit (every attempt
        // landed on 429) from generic unavailability. The drawer's
        // error-decoder surfaces the rate-limit copy with a warning
        // toast instead of the generic provider-down message, so the
        // user understands the limit is transient.
        const allRateLimited =
          err.attempts.length > 0 &&
          err.attempts.every((a) => a.httpStatus === 429);
        return {
          ok: false,
          code: allRateLimited
            ? "coach.provider.rate_limited"
            : "coach.provider.unavailable",
        };
      }
      // v1.21.3 — defence in depth. The chain runner wraps every hard provider
      // failure in `AllProvidersFailedError`, but a provider client can still
      // throw a tagged wire error that reaches here un-wrapped (e.g. a Codex 400
      // raised mid tool-loop on a path the chain runner did not catch). Such an
      // error is a PROVIDER failure, not a server bug — surface the same graceful
      // `coach.provider.*` frame the chain path uses rather than rethrowing into
      // an HTTP 500 (the bug that took the live Coach down for codex users). Only
      // a genuinely unexpected error (no upstream tag, no httpStatus) keeps the
      // 500 + GlitchTip path so real defects stay visible.
      const providerError = classifyBubblingProviderError(err);
      if (providerError) {
        annotate({
          action: { name: "insights.coach.providerFailed" },
          meta: {
            attempts: 1,
            firstStatus: providerError.httpStatus,
            credentialExpired: providerError.code === "credential_expired",
            unwrapped: true,
          },
        });
        return { ok: false, code: `coach.provider.${providerError.code}` };
      }
      throw err;
    }

    // v1.18.7 (SENIOR-DEV MEDIUM) — the provider call returned, so its tokens
    // were billed regardless of reply quality. Reconcile the reservation
    // against the actual count NOW, before any empty/sentinel short-circuit, so
    // an empty or sentinel-only reply still records its burned cost (the old
    // post-hoc `recordSpend` ran only on the happy path, undercounting these).
    // v1.20.0 (F1) — reconcile against the SUMMED tokens across every tool round
    // (the loop accumulates them); the no-tools path sums to the single call.
    await reconcileSpend(
      userId,
      reservation.reserved,
      totalTokensSpent,
      reqDateKey,
      cachedTokensSpent,
      { servedBy: workingProviderType, reservedOwner: reservation.owner },
    ).catch(() => {
      // Ledger reconcile is best-effort; a failure leaves the conservative
      // reservation in place (never an undercount) and never breaks the turn.
    });

    const rawReply = (result.content ?? "").trim();
    if (!rawReply) {
      return { ok: false, code: "coach.provider.empty" };
    }

    // v1.4.22 — strip the optional `---KEYVALUES---` … `---END---`
    // sentinel out of the prose. The stripped prose is what we stream
    // to the client and persist; the parsed entries enrich the
    // provenance envelope so the UI can render the collapsible
    // "Worauf bezieht sich das?" disclosure.
    const sentinel = parseKeyValuesSentinel(rawReply);
    const proseAfterStrip = sentinel.prose.trim();
    // v1.4.22 W5 reconcile (Code-H1) — when the model emits a
    // sentinel-only / malformed reply, `sentinel.prose` is empty after
    // stripping. The previous fallback `sentinel.prose.trim() || rawReply`
    // surfaced raw `---KEYVALUES---` markers to the user. The empty-prose
    // condition signals an unusable provider response: short-circuit to
    // the structured `coach.provider.empty` error frame instead of
    // streaming the raw sentinel body.
    if (!proseAfterStrip) {
      annotate({
        action: { name: "coach.keyvalues.parse_failed" },
        meta: {
          kept: sentinel.keyValues.length,
          reason: "empty_prose_after_strip",
          promptVersion: PROMPT_VERSION,
        },
      });
      return { ok: false, code: "coach.provider.empty" };
    }
    // v1.18.1 (Workstream C) — strip the optional `---SUGGEST-REMINDER---`
    // block out of the prose-after-keyvalues. The model proposes a cadence;
    // the gate decides whether it actually surfaces (module-toggle + opt-out
    // + dismissal memory + cooldown + dedup against a live COACH reminder).
    // A suppressed proposal leaves the prose unchanged and emits no card.
    const suggestParse = parseSuggestReminder(proseAfterStrip);
    let replyText = suggestParse.prose.trim() || proseAfterStrip;

    // v1.22 (B2) — strip the optional `---REMEMBER---` block and capture the
    // reminder INLINE on this turn (not in the >20-turn memory worker), so a
    // casual "remind me about X" in a SHORT chat is no longer lost. A missing
    // note / invalid `when` drops the block (the user never sees the raw
    // marker). Fire-and-forget: the capture write must never break the turn.
    //
    // v1.30.25 — the capture writes `proposed`, not `active`. The block is
    // model output, and the model reads a prompt carrying document-sourced
    // text, so the write needs the same propose-then-confirm moat every other
    // model-driven write already has. See `captureReminderFromSentinel`.
    const rememberParse = parseRememberSentinel(replyText, new Date());
    replyText = rememberParse.prose.trim() || replyText;
    if (rememberParse.reminder) {
      const capture = rememberParse.reminder;
      void captureReminderFromSentinel({
        userId,
        conversationId: workingConversationId,
        parsed: capture,
      }).catch(() => {
        // Reminder capture is best-effort; never sink the turn.
      });
    } else if (rememberParse.malformed) {
      annotate({
        action: { name: "coach.reminder.capture_malformed" },
        meta: { conversationId: workingConversationId },
      });
    }

    // v1.22 (F6) — strip the optional `---SUGGEST-ACTION---` block (the
    // generalised confirm→apply moat). The model names ONE action from the closed
    // allowlist (`checkup.create` / `reminder.note`); the card surfaces additively
    // and NOTHING is created until the user taps confirm (the entity is built
    // server-side, field-by-field, by `POST /api/coach/suggested-actions`).
    const actionParse = parseSuggestAction(replyText);
    replyText = actionParse.prose.trim() || replyText;

    // v1.18.10 (HIGH-2) — OUTBOUND safety screen on the assembled assistant
    // reply, before persistence and streaming. The inbound `detectRefusal`
    // guards the user's message; this guards the model's reply for a
    // dose-prescription or a fabricated clinical risk score that slipped past
    // the system-prompt GLP-1/grounding contracts. On a trip the turn is
    // replaced with a calm, grounded fallback and any reminder suggestion /
    // key-value provenance is dropped — the user never sees the unsafe text.
    const outbound = screenCoachReply(replyText, locale, scheduleDoses);
    if (outbound.block && outbound.reason) {
      replyText = coachOutboundFallback(outbound.reason, locale);
      annotate({
        action: { name: "insights.coach.outbound_blocked" },
        meta: { reason: outbound.reason, promptVersion: PROMPT_VERSION },
      });
      await auditLog("insights.coach.outbound_blocked", {
        userId,
        details: {
          conversationId: workingConversationId,
          reason: outbound.reason,
        },
      });
    }

    // v1.21.0 (P6 / C2-5) — post-hoc numeric verifier on the Coach prose. Cross-
    // check every number the model cited against this turn's authoritative figure
    // set; an unmatched number (transcription / paraphrase drift) is soft-stripped
    // to the editorial elision mark `[…]` and annotated (v1.32.14 — the withheld
    // count also rides the provenance envelope to drive the per-message notice).
    // Cheap, non-blocking, and a no-op when there
    // is no authoritative set — the prompt-level grounding rule remains the
    // backstop, exactly like the briefing's "no signals → skip". A blocked turn
    // already carries canned fallback prose, so skip it.
    //
    // v1.21.2 (A8) — the authoritative set is the figures the tools returned on the
    // tool path, and the SNAPSHOT the model was shown on the no-tools/local path
    // (`snapshot.sections`, which already carries the correlations-snapshot block).
    // Exactly one is populated per turn; the grading, tolerance, and exemptions are
    // identical, so a number the model invents is flagged the same way on both.
    // v1.32.9 (Coach Guard II / G2+G3) — grade the prose against the typed
    // Grounding Ledger rather than a per-turn magnitude bag. Activation is
    // unchanged from Guard I: the ledger is graded ONLY when THIS turn delivered
    // fresh figures the model was told to ground against (a present tool result
    // / pinned workout, or the full snapshot on the no-tools path). The
    // cross-turn, memory, schedule, reference, and guided sources only WIDEN an
    // active grading — they never ACTIVATE it, so a snapshot figure the model
    // cited on a no-tool turn is still left alone (the v1.32.1 regression guard
    // holds). Assistant prose is never a ledger source (D3).
    //
    // The turn that CALLED tools and got nothing back is graded too. It used to
    // be the one turn the verifier sat out: a pure miss carries no `data` and no
    // `available`, `runCoachToolLoop` drops that shape from `toolResults`, and
    // the no-tools snapshot fallback below is populated only in the non-tool
    // branch — so `activatingPayloads` came out empty and every figure in the
    // reply shipped unchecked. That is backwards. A turn whose every tool
    // reported `{ present: false }` is not an absence of evidence about the
    // reply, it is evidence that the record holds nothing to cite, which is
    // exactly when a fabricated figure is both likeliest and most harmful.
    //
    // `toolTrace` is the discriminant, because it records every tool that ran
    // INCLUDING the pure misses. It separates the two cases the old condition
    // conflated: tools ran and found nothing (grade — the model was told the
    // record is empty and answered with numbers anyway), versus the model
    // answered without calling a tool at all (stay dormant — the v1.32.1
    // regression, where the base prompt deliberately carries no pre-computed
    // figures and flagging a legitimately recalled one was a real defect).
    const missedEveryTool =
      toolMode && toolTrace.length > 0 && toolResultPayloads.length === 0;
    const activatingPayloads =
      toolResultPayloads.length > 0
        ? toolResultPayloads
        : missedEveryTool
          ? inventoryPayloads
          : noToolsSnapshotPayloads;
    let groundedFigures: number[] = [];
    // v1.32.14 — count of figures withheld from THIS reply (each rewritten to the
    // elision mark). Hoisted out of the guard block so it can ride the provenance
    // envelope and drive the quiet per-message notice. Stays 0 on a blocked turn
    // (the guard is skipped, its fallback prose carries no figures).
    let unverifiedStripped = 0;
    // True when the guard stripped a figure on a turn whose every tool missed —
    // i.e. the model put a number on a record that holds none. Drives the
    // honest-replacement below.
    let fabricatedOnEmptyRecord = false;
    if (activatingPayloads.length > 0 || missedEveryTool) {
      const ledger = buildGroundingLedger({
        toolPayloads: activatingPayloads,
        priorToolFigures,
        priorUserMessages,
        // The self-context (goals / about-me) rides the system prompt on both
        // paths — the ledger's `memory` source.
        memoryTexts: aboutMe ? [aboutMe] : [],
        scheduleDoses,
        // Reference grounding rides the prompt only on the no-tools
        // full-snapshot path; the guided block rides both paths.
        referenceGrounding:
          !toolMode && includeFullSnapshot ? snapshot.referenceGrounding : null,
        guidedBlock: turnContext.guidedBlock,
      });
      // Persist THIS turn's tool figures (bare magnitudes) so a LATER turn can
      // recall them via the ledger — D3: the tool trace, never the prose.
      groundedFigures = figuresForPersistence(ledger);
      if (!outbound.block) {
        const unverified = findUnverifiedCoachNumbersInLedger(
          replyText,
          ledger,
          locale,
          // On an all-missed turn an EMPTY ledger is the finding, not a reason
          // to skip: nothing was retrievable, so nothing can reconcile.
          { gradeAgainstEmptyLedger: missedEveryTool },
        );
        if (unverified.length > 0) {
          const { prose: corrected, stripped } = stripUnverifiedNumbers(
            replyText,
            unverified,
          );
          replyText = corrected;
          unverifiedStripped = stripped;
          fabricatedOnEmptyRecord = missedEveryTool && stripped > 0;
          annotate({
            action: { name: "coach.prose.number_unverified" },
            meta: {
              flagged: unverified.length,
              stripped,
              // No raw values — just the count + truncated tokens for ops triage.
              tokens: unverified.slice(0, 6).map((u) => u.source),
              promptVersion: PROMPT_VERSION,
            },
          });
        }
      }
    }

    // A stripped reply on an empty record is not worth sending. Eliding the
    // digits leaves the sentences that carried them — "your sleep averaged […]
    // minutes, up from […]" still asserts a series, an average and a direction
    // for a metric the tools just reported has no readings at all. The false
    // claim survives the strip; only its precision goes. So replace the turn
    // with the honest answer instead of shipping the elided mush.
    //
    // Scoped tightly: this fires only when every tool missed AND the guard
    // actually stripped something. A reply that cited a legitimately grounded
    // figure (a prior turn's tool result, an inventory count) reconciles
    // against the ledger, strips nothing, and is left alone.
    //
    // REPLACE, not withhold — the same policy the outbound screen uses on this
    // surface, for the same reason: the user is waiting on a synchronous answer
    // and silence reads as a failure.
    //
    // Accepted trade-off: a reply mixing one grounded recall with one
    // fabrication is replaced wholesale, losing the good half. That is the
    // right way round — the alternative leaves an invented figure's sentence
    // on screen.
    if (fabricatedOnEmptyRecord) {
      replyText = getServerTranslator(locale).t("coach.noRecordedData");
      // The reply now carries no figures at all, so the withheld-figure notice
      // would be describing prose the reader can no longer see. The replacement
      // copy states the same thing in plain words.
      unverifiedStripped = 0;
      annotate({
        action: { name: "coach.prose.empty_record_replaced" },
        meta: { promptVersion: PROMPT_VERSION },
      });
      await auditLog("insights.coach.empty_record_replaced", {
        userId,
        details: { conversationId: workingConversationId },
      });
    }

    // v1.21.0 (NEW-C C-3) — Learn-link post-filter. The prompt instructs the
    // model to only link a published `/learn/<slug>`, but that is guidance, not
    // enforcement: a fabricated `/learn/<invented-slug>` would otherwise ship as
    // a dead link. Scrub any reference whose slug is not in the catalog (a real
    // one is kept verbatim). A blocked turn carries canned fallback prose with no
    // links, so skip it.
    if (!outbound.block && replyText.includes("/learn/")) {
      const scrubbed = scrubUnknownLearnLinks(replyText);
      if (scrubbed.dropped.length > 0) {
        replyText = scrubbed.text;
        annotate({
          action: { name: "coach.learn.link_dropped" },
          meta: {
            dropped: scrubbed.dropped.length,
            // Truncated slug tokens for ops triage — no user content.
            slugs: scrubbed.dropped.slice(0, 6),
            promptVersion: PROMPT_VERSION,
          },
        });
      }
    }

    let surfacedSuggestion: CoachSuggestion | null = null;
    if (!outbound.block && suggestParse.cadence) {
      const decision = await gateSuggestion({
        prisma,
        userId,
        cadence: suggestParse.cadence,
        prefs:
          coachPrefs.reminderSuggestions ?? DEFAULT_REMINDER_SUGGESTION_PREFS,
      });
      if (decision.surface) {
        const cadence = suggestParse.cadence;
        surfacedSuggestion = {
          cadenceId: cadence.id,
          measurementType: cadence.measurementType,
          label: cadence.labelKey,
        };
        // Stamp the cooldown anchor (frequency cap) onto the prefs blob.
        const nextSuggestionPrefs = {
          ...(coachPrefs.reminderSuggestions ??
            DEFAULT_REMINDER_SUGGESTION_PREFS),
          lastSuggestedAt: new Date().toISOString(),
        };
        void prisma.user
          .update({
            where: { id: userId },
            data: {
              coachPrefsJson: {
                ...coachPrefs,
                reminderSuggestions: nextSuggestionPrefs,
              },
            },
          })
          .catch(() => {
            // Cooldown stamp is best-effort: a write failure at worst lets a
            // second suggestion through sooner, never breaks the chat turn.
          });
        annotate({
          action: { name: "coach.reminder.suggested" },
          meta: { cadenceId: cadence.id, metric: cadence.measurementType },
        });
      } else {
        annotate({
          action: { name: "coach.reminder.suppressed" },
          meta: { cadenceId: suggestParse.cadence.id, reason: decision.reason },
        });
      }
    }
    // v1.22 (F6) — surface the confirm-card action when the turn was not blocked.
    // Additive: the prose already stands alone; the card only offers the one-tap
    // confirm. Nothing is created server-side until the user taps it.
    let surfacedAction: CoachSuggestedAction | null = null;
    if (!outbound.block && actionParse.action) {
      surfacedAction = actionParse.action;
      annotate({
        action: { name: "coach.action.suggested" },
        meta: { actionType: actionParse.action.actionType },
      });
    }

    const enrichedProvenance: typeof snapshot.provenance = {
      ...snapshot.provenance,
      ...(surfacedAction ? { suggestedAction: surfacedAction } : {}),
      // v1.18.10 (HIGH-2) — a blocked turn carries the fallback prose, so the
      // key-values from the discarded reply must not ride along as provenance.
      ...(!outbound.block && sentinel.keyValues.length > 0
        ? { keyValues: sentinel.keyValues }
        : {}),
      ...(surfacedSuggestion ? { suggestion: surfacedSuggestion } : {}),
      // v1.20.0 (F1) — persist the retrieval-tool trace (which tools ran +
      // whether each found data) so a reload can show "what I looked at" and the
      // audit can replay grounding. Metadata only.
      ...(toolTrace.length > 0
        ? {
            toolCalls: toolTrace.map((t) => ({
              name: t.name,
              present: t.present,
            })),
          }
        : {}),
      // v1.32.9 (Coach Guard II / G2) — persist THIS turn's tool figures so a
      // later turn's Grounding Ledger can recall them (D3-safe: tool trace, not
      // prose). Dropped on a blocked turn (its figures rode the discarded reply).
      ...(!outbound.block && groundedFigures.length > 0
        ? { groundedFigures }
        : {}),
      // v1.32.14 — the count of figures the grounding guard withheld this turn,
      // so the quiet "some figures couldn't be checked" notice renders under the
      // bubble and survives a conversation reload. Count only, no values. Omitted
      // when nothing was withheld.
      ...(unverifiedStripped > 0
        ? { unverifiedFigures: unverifiedStripped }
        : {}),
    };
    if (sentinel.malformed) {
      // Graceful degrade: log so ops can spot a provider whose
      // sentinel format has drifted, but pass the prose through
      // unchanged. v1.4.23 H1 — split the annotation:
      //   - parse_partial: at least one row parsed AND at least one
      //     row failed (mixed-format drift on a single reply)
      //   - parse_failed: the whole block was unusable
      // Both annotations carry the per-line `reasons` array so an ops
      // dashboard can attribute the failure cause without re-running
      // the parser.
      const reasons = sentinel.malformedEntries.map((entry) => entry.reason);
      const annotationName =
        sentinel.keyValues.length > 0 && sentinel.malformedEntries.length > 0
          ? "coach.keyvalues.parse_partial"
          : "coach.keyvalues.parse_failed";
      annotate({
        action: { name: annotationName },
        meta: {
          kept: sentinel.keyValues.length,
          malformedCount: sentinel.malformedEntries.length,
          reasons,
          promptVersion: PROMPT_VERSION,
        },
      });
    }

    // Persist the assistant message BEFORE we begin streaming; if the
    // client disconnects we still have the canonical row.
    const assistantMessage = await appendMessage({
      conversationId: workingConversationId,
      role: "assistant",
      content: replyText,
      metricSource: enrichedProvenance,
      providerType: workingProviderType,
      promptVersion: PROMPT_VERSION,
      // v1.18.9 — persist the per-turn token count + model so the quiet
      // token footer survives a conversation reload. The live turn paints
      // from the `done.usage` SSE frame below; reloads read these columns.
      // v1.20.0 (F1) — the summed cost across every tool round, so the footer
      // reflects the true turn cost on the tool path too.
      tokensUsed: totalTokensSpent || null,
      model: result.model ?? null,
    });

    // v1.18.7 — the day's spend was already reconciled against the
    // reservation immediately after the provider returned (above), so there is
    // no post-persistence ledger bump here. The reservation guarantees the
    // tokens are counted even if persistence or streaming fails afterwards.

    annotate({
      action: { name: "insights.coach.replied" },
      meta: {
        provider: workingProviderType,
        // v1.20.0 (F1) — summed tokens across every tool round (the loop) or the
        // single call (no-tools path), so the dashboards see the true turn cost.
        tokens: totalTokensSpent,
        promptVersion: PROMPT_VERSION,
        conversationId: workingConversationId,
        historyTurns: window.length,
        // v1.20.0 (F1) — whether this turn ran the tool-retrieval path, and how
        // many tools it fetched, so the dashboards can correlate the token delta
        // with the new path vs the legacy snapshot path.
        toolMode,
        toolsCalled: toolTrace.length,
        // v1.19.1 (C4) — whether the full SNAPSHOT block rode this turn (the
        // expensive prefix) vs the cheap pointer. On the tool path the snapshot
        // never rides the prompt, so this is the legacy-path signal only.
        snapshotSent: !toolMode && includeFullSnapshot,
        promptChars: userPrompt.length,
        // v1.7.0 — count of provenance metrics the snapshot surfaced
        // this turn (a proxy for cluster breadth) so the dashboards can
        // correlate reply shape with cluster activation.
        clusterCount: snapshot.provenance.metrics.length,
      },
    });

    // produceReply success — hand the fully-guarded reply + provenance back to
    // the heartbeat-fronted stream below for client-visible emission.
    return {
      ok: true,
      replyText,
      provenance: enrichedProvenance,
      suggestion: surfacedSuggestion,
      action: surfacedAction,
      messageId: assistantMessage.id,
      totalTokens: totalTokensSpent,
      model: result.model ?? null,
    };
  } // end produceReply

  // ── Stream the body to the client ────────────────────────────
  // v1.22 (#89) — the provider call + every guard + persistence run INSIDE the
  // stream (via `produceReply`) so the HTTP headers + a keepalive heartbeat
  // flush immediately and keep the reverse proxy from idle-dropping the
  // connection while a slow local backend is still loading the model /
  // generating. Only once the FULLY-GUARDED reply is ready do client-visible
  // token frames go out.
  //
  // v1.12.0 — yield to the event loop between token frames so each one flushes
  // as its own network chunk; the visible cadence reads ChatGPT/Claude-style.
  const stream = createSseStream(async (controller) => {
    // Keepalive: an SSE comment frame (`: ka`) the client parser ignores,
    // flushed on an interval through the pre-first-token (prompt-processing)
    // and generation phases.
    const heartbeat = setInterval(() => {
      controller.enqueue(HEARTBEAT_FRAME);
    }, HEARTBEAT_MS);

    let outcome: ReplyOutcome;
    try {
      outcome = await produceReply();
    } catch (err) {
      clearInterval(heartbeat);
      // #781 — a client disconnect can also surface as an abort-shaped error
      // on a path `produceReply`'s own catch does not own (e.g. a teardown
      // rejection out of persistence). That is not a defect and nobody is
      // listening: skip the GlitchTip forward and the error frame.
      if (request.signal.aborted) {
        annotate({
          action: { name: "insights.coach.cancelled" },
          meta: { conversationId: workingConversationId, lateAbort: true },
        });
        return;
      }
      // The stream is already open, so we cannot 500: a tagged provider error
      // surfaces a graceful `coach.provider.*` frame; anything else degrades to
      // a generic unavailable frame. A genuine defect is still annotated.
      const providerError = classifyBubblingProviderError(err);
      if (!providerError) {
        // Not a tagged provider failure — a genuine server defect raised
        // inside the open producer (e.g. a DB error in the post-stream
        // `appendMessage` persistence). Record it on the wide event and
        // forward it to GlitchTip so it stays visible instead of reading
        // as a provider outage; the stream is open, so we still emit an
        // error frame below rather than a 500.
        getEvent()?.setError(
          err instanceof Error ? err : new Error(String(err)),
        );
        void reportCoachStreamDefect(err);
      }
      annotate({
        action: { name: "insights.coach.streamError" },
        meta: {
          unwrapped: Boolean(providerError),
          reported: !providerError,
          firstStatus: providerError?.httpStatus ?? null,
        },
      });
      if (!controller.signal.aborted) {
        const code = providerError
          ? `coach.provider.${providerError.code}`
          : "coach.provider.unavailable";
        controller.enqueue(encodeFrame({ type: "error", code, message: code }));
      }
      return;
    }
    clearInterval(heartbeat);

    if (!outcome.ok) {
      if (!controller.signal.aborted) {
        controller.enqueue(
          encodeFrame({
            type: "error",
            code: outcome.code,
            message: outcome.code,
          }),
        );
      }
      return;
    }

    for (const tok of tokeniseForStreaming(outcome.replyText)) {
      // v1.18.10 (A-2) — stop tokenising the moment the client disconnects.
      if (controller.signal.aborted) return;
      controller.enqueue(encodeFrame({ type: "token", token: tok }));
      await flushTick();
    }
    if (controller.signal.aborted) return;
    controller.enqueue(
      encodeFrame({ type: "provenance", metricSource: outcome.provenance }),
    );
    // v1.18.1 (Workstream C) — additive `suggestion` frame.
    if (outcome.suggestion) {
      controller.enqueue(
        encodeFrame({ type: "suggestion", suggestion: outcome.suggestion }),
      );
    }
    // v1.22 (F6) — additive `suggestedAction` frame.
    if (outcome.action) {
      controller.enqueue(
        encodeFrame({
          type: "suggestedAction",
          suggestedAction: outcome.action,
        }),
      );
    }
    // v1.18.9 — additive `usage` envelope on the `done` frame.
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId: workingConversationId,
        messageId: outcome.messageId,
        usage: {
          totalTokens: outcome.totalTokens || null,
          model: outcome.model,
        },
      }),
    );
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Emit a refusal as a single `token` frame followed by `done`. No
 * provider call, no persisted assistant message — the user message is
 * still kept on disk so the rail shows the conversation history
 * accurately. The user message landing on disk is a deliberate choice;
 * the rail otherwise wouldn't show the user's attempt at all.
 */
async function streamRefusal(args: {
  userId: string;
  conversationId: string | undefined;
  message: string;
  refusalText: string;
}): Promise<Response> {
  let conversationId = args.conversationId;
  if (!conversationId) {
    const created = await createConversation({
      userId: args.userId,
      title: args.message,
    });
    conversationId = created.id;
  } else {
    const owned = await prisma.coachConversation.findFirst({
      where: { id: conversationId, userId: args.userId },
      select: { id: true },
    });
    if (!owned) {
      throw new HttpError(404, "coach.conversation.notFound");
    }
  }

  await appendMessage({
    conversationId,
    role: "user",
    content: args.message,
  });
  const refusalMessage = await appendMessage({
    conversationId,
    role: "assistant",
    content: args.refusalText,
    metricSource: { windows: [], metrics: ["general"] },
    providerType: "refusal",
    promptVersion: PROMPT_VERSION,
  });

  const stream = createSseStream((controller) => {
    controller.enqueue(encodeFrame({ type: "token", token: args.refusalText }));
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId,
        messageId: refusalMessage.id,
      }),
    );
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * v1.21.3 — classify a provider error that bubbled out of the chain runner
 * un-wrapped (i.e. not an `AllProvidersFailedError`). The provider clients tag
 * their thrown errors with `upstream` + `httpStatus`; a tagged error is a
 * provider failure that must surface a graceful `coach.provider.*` frame rather
 * than rethrow into an HTTP 500. Returns `null` for anything that is NOT a
 * recognisable provider error (a real server bug), so those keep the 500 +
 * GlitchTip path. Status mapping mirrors `AllProvidersFailedError`: 401/403 →
 * credential_expired, 429 → rate_limited, everything else → unavailable.
 */
function classifyBubblingProviderError(err: unknown): {
  code: "credential_expired" | "rate_limited" | "unavailable";
  httpStatus: number | null;
} | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as { upstream?: unknown; httpStatus?: unknown };
  const hasUpstreamTag = typeof e.upstream === "string";
  const status = typeof e.httpStatus === "number" ? e.httpStatus : null;
  // Require the wire tag — a bare `{ httpStatus }` from unrelated code must not
  // be swallowed as a provider outage.
  if (!hasUpstreamTag) return null;
  if (status === 401 || status === 403) {
    return { code: "credential_expired", httpStatus: status };
  }
  if (status === 429) return { code: "rate_limited", httpStatus: status };
  return { code: "unavailable", httpStatus: status };
}

/**
 * Fire-and-forget GlitchTip forward for a genuine server defect that
 * surfaces INSIDE the open SSE producer — e.g. a Prisma failure in the
 * post-stream `appendMessage` persistence, which runs after the provider
 * call and therefore outside its try/catch. Once the stream is open the
 * route can no longer return a 500, so without this such a defect would
 * read as a generic provider outage in error tracking rather than the
 * server bug it is. Mirrors the api-handler / worker forwarders: dynamic
 * import (no cycle, no startup cost), redacted message + stack, and it
 * NEVER throws so a sink failure cannot mask the original error.
 */
async function reportCoachStreamDefect(err: unknown): Promise<void> {
  const e =
    err instanceof Error ? err : new Error("Unknown coach stream error");
  const message = redactSecrets(`[insights.coach.stream] ${e.message}`);
  console.error("[coach-stream]", message, e);
  try {
    const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] =
      await Promise.all([
        import("@/lib/monitoring-settings"),
        import("@/lib/monitoring/glitchtip"),
      ]);
    const settings = await getGlitchtipSettings();
    if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;
    await sendGlitchtipEvent({
      dsn: settings.glitchtipDsn,
      input: {
        environment: settings.glitchtipEnvironment || "production",
        message,
        level: "error",
        type: e.name || "Error",
        stack: redactOptional(e.stack),
        sourceTag: "healthlog-api-handler",
      },
    });
  } catch {
    /* the reporter must never throw */
  }
}

function streamProviderError(args: { code: string }): Response {
  const stream = createSseStream((controller) => {
    controller.enqueue(
      encodeFrame({
        type: "error",
        code: args.code,
        message: args.code,
      }),
    );
  });
  // Status 200 so the streaming client reads the SSE body and parses
  // the structured `error` frame (HTTP-status branches drop the
  // structured code on the floor).
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
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
  // v1.18.0 — same two-layer module gate as the SSE POST.
  const gate = await requireModuleEnabled(auth.user.id, "coach");
  if (!gate.enabled) return gate.response;
  // v1.4.31 — same gate as the SSE POST. Hiding the rail when
  // the operator has disabled Coach matches the FAB suppression
  // on the client.
  await requireAssistantSurface("coach");
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
