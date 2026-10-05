/**
 * Assemble everything a Coach turn tells the model: the user's prefs, the
 * snapshot, the self-context, the scheduled doses, the system prompt, the
 * conversation window, an optional pinned workout, and the fenced provider
 * prompts. Also starts the per-turn memory capture off the request path.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { Locale } from "@/lib/i18n/config";
import { localeLanguageNames as LANGUAGE_NAMES } from "@/lib/i18n/config";
import type { CoachScope } from "@/lib/ai/coach/types";
import { enqueueCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-shared";
import { instructionLocale } from "@/lib/ai/prompts/output-language";
import { storeDeterministicFacts } from "@/lib/ai/coach/facts";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import {
  openerArchetypeHint,
  shouldUseNameForTurn,
  firstNameFromDisplayName,
} from "@/lib/ai/prompts/opener-archetype";
import { getSelfContextTextForUser } from "@/lib/ai/coach/about-me";
import {
  buildCoachSnapshot,
  type CoachSnapshotResult,
} from "@/lib/ai/coach/snapshot";
import {
  buildCoachProviderPrompts,
  buildCoachTurnContext,
  type CoachTurnContext,
} from "@/lib/ai/coach/chat-request-builder";
import { buildWorkoutEvidenceSection } from "@/lib/ai/coach/workout-evidence-builder";
import { getScheduledDoseValues } from "@/lib/medications/scheduled-doses";
import { buildRememberAddendum } from "@/lib/ai/coach/reminders";
import { buildSuggestActionAddendum } from "@/lib/ai/coach/suggest-action";
import {
  parseCoachPrefs,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";
import {
  clampWindow,
  reachFromPrefs,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";

import type { TurnConversation } from "./types";

export interface TurnContext {
  coachPrefs: CoachPrefs;
  /**
   * How far back this turn may read: the saved `defaultWindow` as a limit.
   * Every snapshot build and tool call of the turn honours it.
   */
  reach: CoachHistoryReach;
  /**
   * v1.22 (#89) — the upstream timeout for THIS turn's provider call. On the
   * streaming (local) path it is the per-idle-gap ceiling; on the buffered
   * path it is the whole-call ceiling.
   */
  aiResponseTimeoutMs: number;
  effectiveScope: CoachScope | undefined;
  snapshot: CoachSnapshotResult;
  aboutMe: string | null;
  scheduleDoses: Awaited<ReturnType<typeof getScheduledDoseValues>>;
  turnContext: CoachTurnContext;
  workoutEvidence: Record<string, unknown> | null;
  systemPrompt: string;
  userPrompt: string;
}

export async function assembleTurnContext(args: {
  userId: string;
  locale: Locale;
  message: string;
  scope: CoachScope | undefined;
  guidedQuestion: string | undefined;
  workoutId: string | undefined;
  conversation: TurnConversation;
}): Promise<TurnContext> {
  const { userId, locale, message, scope, guidedQuestion, workoutId } = args;
  const { conversationId, priorTurns, priorSummary } = args.conversation;

  // Build the prompt: system + (optional) snapshot + recent history +
  // the new user message. v1.4.23 H4 — fold per-user prefs into the
  // system-prompt prefix; the snapshot builder reads the same prefs
  // separately so excluded metrics never even leave the DB.
  //
  // v1.4.25 W5 — `coachPrefs.defaultWindow` is the user's saved
  // analysis-window preference, merged into the snapshot scope when the
  // client didn't supply a per-conversation window.
  const prefsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      coachPrefsJson: true,
      displayName: true,
      // v1.22 (#89) — per-user response timeout (seconds), mainly for slow
      // local/self-hosted backends. Threaded onto the provider call.
      aiResponseTimeoutSeconds: true,
    },
  });
  const coachPrefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  // v1.22 (#89) — a generous ~180 s default replaces the legacy 60 s client
  // default that timed the Coach out on an MLX/exo backend whose first
  // request loads the model. Clamped to sane bounds at write-time.
  const aiResponseTimeoutMs =
    prefsRow?.aiResponseTimeoutSeconds != null
      ? prefsRow.aiResponseTimeoutSeconds * 1000
      : 180_000;
  // The saved window is a limit as well as the default: a
  // client-sent window (header pill, deep link) may narrow it, never widen it.
  const reach = reachFromPrefs(coachPrefs);
  const requestedWindow = scope?.window ?? coachPrefs.defaultWindow;
  const effectiveScope: CoachScope = {
    ...(scope ?? {}),
    ...(requestedWindow !== undefined
      ? { window: clampWindow(requestedWindow, reach) }
      : {}),
  };
  const snapshot = await buildCoachSnapshot(userId, effectiveScope, { reach });
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
  const { isFirstTurn } = turnContext;
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
    conversationId,
    userId,
    message,
    locale,
  }).catch(() => {
    // Fact capture must never break the chat turn; the >TURN_CAP LLM
    // extraction remains as the catch-all on long conversations.
  });
  if (turnContext.historyElided) {
    void enqueueCoachMemoryRefresh({
      conversationId,
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
      ? await buildWorkoutEvidenceSection(userId, workoutId, reach)
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

  return {
    coachPrefs,
    reach,
    aiResponseTimeoutMs,
    effectiveScope,
    snapshot,
    aboutMe,
    scheduleDoses,
    turnContext,
    workoutEvidence,
    systemPrompt,
    userPrompt,
  };
}
