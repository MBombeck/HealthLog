"use client";

import { memo } from "react";
import Link from "next/link";
import { Bot, Info, RotateCcw, Sparkles, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import {
  parseChartTokens,
  tokenToMetric,
  type ChartToken,
} from "@/lib/insights/chart-tokens";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { ProseBlocks } from "@/components/insights/prose-blocks";

import { ReminderSuggestionCard } from "./reminder-suggestion-card";
import { SuggestedActionCard } from "./suggested-action-card";
import { StreamedProse } from "./streamed-prose";
import { CoachTurnActivity } from "./turn-activity";
import { CoachInterimResults } from "./interim-results";
import {
  CoachResults,
  countResultsInSection,
  liveWithProvenance,
} from "./coach-results";
import { CoachFollowUpChips } from "./follow-up-chips";
import { SuggestedReplies, type SuggestedReply } from "./suggested-replies";
import { CoachMemoryNote } from "./memory-note";
import { CoachAssumptionLine } from "./assumption-line";
import { AssistantMessageActions, UserMessageActions } from "./message-actions";
import type {
  CoachActivity,
  CoachFollowUp,
  CoachMemoryNote as CoachMemoryNoteFrame,
  CoachProvenanceMetric,
} from "@/lib/ai/coach/types";

/**
 * Per-message bubble renderer for the Coach thread, split out of
 * `message-thread.tsx` (v1.28.26 file-size split). Owns the user + assistant
 * `ChatBubble` (steps, accompanying charts, the action row from
 * `message-actions.tsx`, and the follow-up chips under the latest answer),
 * the typing indicator, the chart-token grounding selector, and the
 * error-code → i18n resolver. `message-thread.tsx` re-exports the
 * previously public names so external call sites are unchanged.
 */

/**
 * v1.4.25 W5 — map server-emitted error codes to specific Coach i18n
 * keys. The chat route distinguishes the daily user-quota
 * (`coach.budget.exceeded`, returned as a JSON 429) from the provider
 * rate-limit (`coach.provider.rate_limited`, streamed as an SSE error
 * frame). Both used to surface as the generic provider-unavailable
 * copy; we now route each to its dedicated translation so the user
 * understands whether the limit is on their side (reset at UTC
 * midnight) or transient on the provider side (retry in ~5 min).
 *
 * Exported so the resolver can be pinned by unit tests without
 * standing up the whole thread renderer.
 */
export function errorCodeToI18nKey(code: string): string {
  switch (code) {
    case "coach.budget.exceeded":
      return "insights.coach.dailyLimitBody";
    case "coach.provider.rate_limited":
      return "insights.coach.providerRateLimitBody";
    case "coach.network":
      // v1.4.43 QoL (M6) — a dropped network is the user's local
      // problem and needs a different next action ("come back online")
      // than a provider failure ("try again in a moment"). Split out
      // so the user sees the actionable copy in the offline branch.
      return "insights.coach.errorNetwork";
    case "coach.provider.credential_expired":
      // v1.11.0 W1 — the user's primary AI provider credential is dead
      // (auth-class failure). The next action is "reconnect", not "try
      // again later", so it carries its own copy pointing at Settings.
      return "insights.coach.errorCredentialExpired";
    case "coach.provider.none":
      // v1.18.6 — no AI provider is configured anywhere, so "try again
      // in a moment" is the wrong instruction (it will 422 forever). Send
      // the user to guided setup with a one-line explainer + a Settings
      // link rendered alongside the bubble copy.
      return "insights.coach.errorNoProvider";
    case "coach.provider.unavailable":
    case "coach.provider.empty":
    case "coach.stream":
      return "insights.coach.errorProvider";
    // v1.39 — the capability refusals (`meta.errorCode` on a 403/422/503
    // before the stream opens). Each says what is off and who can change it.
    case "consent.ai.required":
      return "insights.coach.errorConsent";
    case "ai.record.notPermitted":
      return "insights.coach.errorNotPermitted";
    case "ai.unavailable":
      return "insights.coach.errorUnavailable";
    case "ai.provider.none":
      return "insights.coach.errorNoProvider";
    case "module.disabled":
      return "insights.coach.errorCoachOff";
    default:
      // The operator switched the Coach (or all AI) off on this server.
      if (code.startsWith("assistant.disabled.")) {
        return "insights.coach.errorOperatorOff";
      }
      // Forward-compat: try `insights.coach.<code>` for codes that
      // ship their own translation (e.g. legacy `errorProvider`).
      return `insights.coach.${code}`;
  }
}

/**
 * v1.22 (W5) — Coach accompanying charts, Phase 1: the renderer half.
 *
 * The chart-token mechanism (`chart-tokens.ts`) was prepared for the
 * Insights prose but its render path was never wired for the Coach —
 * `stripChartTokens` cleaned tokens out of the prose, but `parseChartTokens`
 * had no caller, so a `metric:<TYPE>` token the model emitted rendered no
 * chart. This map activates the render half for the Coach.
 *
 * Each entry pairs an allowlisted chart token with the Coach provenance
 * TOPIC that the snapshot stamps when it actually drew on that metric. A
 * chart only renders when its topic is present in `metricSource.metrics`, so
 * the series is grounded twice over: the closed allowlist drops a
 * hallucinated token, and the provenance intersect drops a metric the turn
 * never saw (and which therefore has no data). The chart itself self-fetches
 * the user's real series from `/api/measurements` — the model never emits a
 * data point.
 *
 * Only MeasurementType-backed tokens that render through the generic,
 * self-fetching `<HealthChart>` are listed. The synthetic `metric:MOOD`
 * token (served by a separate `<MoodChart>`) and the allowlist's reserved
 * score classes are intentionally omitted from Phase 1.
 *
 * The prompt clause that tells the model it MAY emit one such token is a
 * separate concern (the narrative/prompt workstream); this is render-only,
 * provider-agnostic (it reads the plain inline token, so it works for every
 * provider including the codex inline-text path), and a graceful no-op when
 * no grounded token is present.
 */
const CHART_TOKEN_PROVENANCE: Partial<
  Record<ChartToken, CoachProvenanceMetric>
> = {
  "metric:WEIGHT": "weight",
  "metric:BLOOD_PRESSURE_SYS": "bp",
  "metric:BLOOD_PRESSURE_DIA": "bp",
  "metric:PULSE": "pulse",
  "metric:BODY_FAT": "body_fat",
  "metric:SLEEP_DURATION": "sleep",
  "metric:ACTIVITY_STEPS": "steps",
  "metric:BLOOD_GLUCOSE": "glucose",
  "metric:TOTAL_BODY_WATER": "total_body_water",
  "metric:BONE_MASS": "bone_mass",
  "metric:OXYGEN_SATURATION": "spo2",
  "metric:HEART_RATE_VARIABILITY": "hrv",
  "metric:RESTING_HEART_RATE": "resting_hr",
  "metric:ACTIVE_ENERGY_BURNED": "active_energy",
  "metric:FLIGHTS_CLIMBED": "flights",
  "metric:WALKING_RUNNING_DISTANCE": "distance",
  "metric:VO2_MAX": "vo2_max",
  "metric:BODY_TEMPERATURE": "body_temp",
  "metric:FAT_FREE_MASS": "fat_free_mass",
  "metric:FAT_MASS": "fat_mass",
  "metric:MUSCLE_MASS": "muscle_mass",
  "metric:LEAN_BODY_MASS": "lean_body_mass",
  "metric:BODY_MASS_INDEX": "bmi",
  "metric:VISCERAL_FAT": "visceral_fat",
  "metric:SKIN_TEMPERATURE": "skin_temp",
  "metric:RESPIRATORY_RATE": "respiratory_rate",
  "metric:PULSE_WAVE_VELOCITY": "pulse_wave_velocity",
  "metric:VASCULAR_AGE": "vascular_age",
  "metric:WALKING_HEART_RATE_AVERAGE": "walking_hr",
  "metric:WALKING_ASYMMETRY": "walking_asymmetry",
  "metric:WALKING_DOUBLE_SUPPORT": "walking_double_support",
  "metric:WALKING_STEP_LENGTH": "walking_step_length",
  "metric:WALKING_SPEED": "walking_speed",
  "metric:AUDIO_EXPOSURE_ENV": "audio_env",
  "metric:AUDIO_EXPOSURE_HEADPHONE": "audio_headphone",
  "metric:AUDIO_EXPOSURE_EVENT": "audio_event",
  "metric:TIME_IN_DAYLIGHT": "daylight",
};

/** Max charts rendered under a single Coach turn (keeps the reply scannable). */
const MAX_COACH_CHARTS = 2;

/**
 * Pure selection of the chart tokens to render under an assistant turn:
 * allowlist-parsed, intersected with the turn's grounded provenance topics,
 * de-duplicated by metric, and capped. Exported for unit tests so the
 * grounding contract is pinned without standing up the chart component.
 *
 * v1.39.4 — `shownDomains` are the domains of the result tables the answer
 * shows under the prose; a token for one of them is dropped, since the
 * turn's own table (and its chart) already shows that metric.
 */
export function selectCoachChartTokens(
  content: string,
  metrics: readonly CoachProvenanceMetric[] | undefined,
  shownDomains?: ReadonlySet<string>,
): ChartToken[] {
  const grounded = new Set(metrics ?? []);
  const out: ChartToken[] = [];
  const seen = new Set<string>();
  for (const token of parseChartTokens(content)) {
    const topic = CHART_TOKEN_PROVENANCE[token];
    if (!topic || !grounded.has(topic)) continue;
    if (shownDomains?.has(topic)) continue;
    const metric = tokenToMetric(token);
    if (seen.has(metric)) continue;
    seen.add(metric);
    out.push(token);
    if (out.length >= MAX_COACH_CHARTS) break;
  }
  return out;
}

/**
 * Chart tokens whose canonical measurement-type label has no dedicated
 * `measurements.type*` key — route them to the closest existing key so the
 * chart header reads cleanly rather than echoing the raw enum.
 */
const CHART_TITLE_KEY_OVERRIDE: Record<string, string> = {
  BLOOD_PRESSURE_SYS: "measurements.typeBloodPressure",
  BLOOD_PRESSURE_DIA: "measurements.typeBloodPressure",
};

/** Localised chart header for a MeasurementType, mirroring the snapshot's
 *  `measurements.type<Camel>` convention with a readable fallback. */
function coachChartTitle(
  metric: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const override = CHART_TITLE_KEY_OVERRIDE[metric];
  if (override) {
    const resolved = t(override);
    if (resolved !== override) return resolved;
  }
  const camel = metric
    .toLowerCase()
    .split("_")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  const key = `measurements.type${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  const resolved = t(key);
  return resolved === key ? metric.replace(/_/g, " ").toLowerCase() : resolved;
}

interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  metricSource?: import("@/lib/ai/coach/types").CoachProvenance | null;
  /**
   * v1.18.1 (Workstream C) — live cadence suggestion from the streaming
   * hook. Persisted messages carry it on `metricSource.suggestion`
   * instead; the bubble falls back to that so the card survives reload.
   */
  suggestion?: import("@/lib/ai/coach/types").CoachSuggestion | null;
  /**
   * v1.22 (W7/W6) — live generalised confirm-card action from the streaming
   * hook. Persisted messages carry it on `metricSource.suggestedAction`; the
   * bubble falls back to that so the card survives reload.
   */
  suggestedAction?:
    import("@/lib/ai/coach/suggest-action").CoachSuggestedAction | null;
  /**
   * v1.39.4 — live steps from the streaming hook. Persisted messages carry
   * them on `metricSource.steps`; the bubble falls back to that.
   */
  steps?: import("@/lib/ai/coach/types").CoachStep[];
  /**
   * v1.39.4 — live tables from the streaming hook. A persisted message
   * lists their metadata on `metricSource.results` and the values are
   * fetched lazily, which needs the conversation id.
   */
  results?: import("@/lib/ai/coach/types").CoachResultTable[];
  conversationId?: string | null;
  providerType?: string | null;
  inProgress?: boolean;
  errorCode?: string | null;
  /**
   * v1.4.23 H7 — present only on persisted assistant messages.
   * Streaming bubbles (no message id yet) skip the thumbs row so the
   * user can't rate before the message lands on disk.
   */
  messageId?: string;
  /**
   * v1.18.9 — true for the live streaming assistant turn. Drives the
   * word-by-word prose fade (`<StreamedProse>`); persisted bubbles render
   * settled plain text.
   */
  streaming?: boolean;
  /**
   * v1.18.9 — per-turn token usage for the just-finished streaming bubble
   * (from `done.usage`). Persisted bubbles read `tokensUsed` / `model`
   * instead.
   */
  usage?: import("./use-coach").CoachUsage | null;
  /**
   * v1.18.9 — persisted per-message token count + model, for the quiet
   * token footer on reload. Null on user turns, refusals, and older rows.
   */
  tokensUsed?: number | null;
  model?: string | null;
  /**
   * v1.22 (W5) — ISO creation timestamp for the persisted bubble's
   * hover/tap timestamp tooltip. Absent on optimistic + streaming bubbles
   * (no persisted time yet), so those render no timestamp.
   */
  createdAt?: string;
  /**
   * v1.22 — bound "Try again" callback for a settled assistant turn (the
   * thread closes over the preceding user message). Absent on user / streaming
   * / refusal turns and when the surface supplies no regenerate handler.
   */
  onRegenerate?: () => void;
  /**
   * The follow-up chips, handed only to the latest assistant turn: the
   * offering message's id and its chips. They render in the answer's own
   * column, after the action row.
   */
  followUps?: FollowUpOffer | null;
  /** True while another turn is in flight; the chips step aside. */
  followUpsDisabled?: boolean;
  onFollowUp?: (followUp: CoachFollowUp, messageId: string) => void;
  /**
   * v1.41 — the reply pills the latest answer offers instead of its chips:
   * a clarifying question's choices, or the two answers to a fact or plan
   * proposal. Built by the thread; one array per offer.
   */
  replies?: ReplyOffer | null;
  /**
   * v1.41 — the live trail from the streaming hook. Persisted messages carry
   * its metadata on `metricSource.activity`; the bubble falls back to that.
   */
  activity?: CoachActivity[];
  /** v1.41 — the refs of the tables that arrived while the turn ran. */
  interimRefs?: string[];
  /** v1.41 — when the live turn started and ended on this device. */
  startedAt?: number | null;
  endedAt?: number | null;
  /** v1.41 — the live `memoryNote` frame, with the fact's words. */
  memoryNote?: CoachMemoryNoteFrame | null;
}

/** v1.41 — the reply pills one assistant message offers. */
export interface ReplyOffer {
  messageId: string;
  replies: SuggestedReply[];
}

/** The chips one assistant message offers. */
export interface FollowUpOffer {
  messageId: string;
  followUps: CoachFollowUp[];
}

function sameFollowUpOffer(
  a: FollowUpOffer | null | undefined,
  b: FollowUpOffer | null | undefined,
): boolean {
  if (!a || !b) return !a === !b;
  return a.messageId === b.messageId && a.followUps === b.followUps;
}

/**
 * v1.28.46 perf (M3) — memo comparator for `ChatBubble`. The Coach thread
 * re-renders on every streamed token (the live turn's content grows), which
 * re-runs `messages.map` and re-creates every persisted bubble. Without memo
 * each settled bubble re-runs `selectCoachChartTokens` + provenance work per
 * token; on a long thread that is tokens × messages renders and drops frames.
 *
 * Every prop that changes the bubble's output is compared by value/reference.
 * The ONE prop that is not stable across renders is `onRegenerate`: the thread
 * builds a fresh `() => onRegenerate(precedingUserContent)` closure per render
 * for each assistant message (message-thread.tsx), so a naive shallow memo
 * would never skip. Its identity does not affect rendering (the closure is only
 * invoked on click, and captures the same preceding user text on a settled
 * thread), so it is compared by PRESENCE, not identity. Result: only the
 * streaming bubble (whose `content`/`streaming` actually change) re-renders.
 *
 * The follow-up offer is compared by its message id and chip array (the
 * thread builds a fresh wrapper object per render, the array itself is the
 * provenance's or the stream's and stays put), and `onFollowUp` by identity:
 * without these the memoised bubble would keep showing stale chips.
 *
 * Exported so the contract is unit-testable without standing up the thread.
 */
export function areChatBubblePropsEqual(
  prev: ChatBubbleProps,
  next: ChatBubbleProps,
): boolean {
  return (
    prev.role === next.role &&
    prev.content === next.content &&
    prev.streaming === next.streaming &&
    prev.inProgress === next.inProgress &&
    prev.errorCode === next.errorCode &&
    prev.providerType === next.providerType &&
    prev.messageId === next.messageId &&
    prev.tokensUsed === next.tokensUsed &&
    prev.model === next.model &&
    prev.createdAt === next.createdAt &&
    prev.metricSource === next.metricSource &&
    prev.suggestion === next.suggestion &&
    prev.suggestedAction === next.suggestedAction &&
    prev.steps === next.steps &&
    prev.results === next.results &&
    prev.conversationId === next.conversationId &&
    prev.usage === next.usage &&
    sameFollowUpOffer(prev.followUps, next.followUps) &&
    prev.followUpsDisabled === next.followUpsDisabled &&
    prev.onFollowUp === next.onFollowUp &&
    prev.replies === next.replies &&
    prev.activity === next.activity &&
    prev.interimRefs === next.interimRefs &&
    prev.startedAt === next.startedAt &&
    prev.endedAt === next.endedAt &&
    prev.memoryNote === next.memoryNote &&
    // onRegenerate is a per-render closure — compare only whether it is present.
    (prev.onRegenerate === undefined) === (next.onRegenerate === undefined)
  );
}

function ChatBubbleImpl({
  role,
  content,
  metricSource,
  suggestion,
  suggestedAction,
  steps,
  results,
  conversationId,
  providerType,
  inProgress,
  errorCode,
  messageId,
  streaming,
  usage,
  tokensUsed,
  model,
  createdAt,
  onRegenerate,
  followUps,
  followUpsDisabled,
  onFollowUp,
  replies,
  activity,
  interimRefs,
  startedAt,
  endedAt,
  memoryNote,
}: ChatBubbleProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  if (role === "user") {
    // v1.5.5 — pull the user's self-hosted avatar so the user
    // bubble matches the Coach avatar in size and visual weight.
    // Falls back to initials when the user has not uploaded an
    // avatar. Replaces the Gravatar leak (v1.4.22 B3).
    const avatarUrl = user?.avatarUrl ?? null;
    const initials = user?.username
      ? user.username.slice(0, 2).toUpperCase()
      : null;
    return (
      <div
        data-slot="coach-bubble-user"
        className="flex items-start justify-end gap-2.5"
      >
        <div
          className={cn(
            // Budget the avatar column (size-8 + gap-2.5 ≈ 2.625rem) out
            // of the 80% cap so the bubble + avatar together never
            // overflow a comfortable width on a narrow phone.
            // `group/user-bubble` scopes the action row's hover/focus reveal.
            "group/user-bubble flex max-w-[calc(80%-2.625rem)] flex-col items-end gap-1",
          )}
        >
          <div
            className={cn(
              "border-dose-accent/30 bg-dose-accent/12 text-foreground",
              "rounded-xl rounded-tr-sm border px-3.5 py-2.5",
              "text-sm leading-relaxed",
            )}
          >
            {/* v1.22 (W5) — render real paragraph blocks so a multi-line
                message reads as paragraphs, not one run-on block. User text
                is verbatim: no chart-token strip, no Learn linkify. */}
            <ProseBlocks text={content} strip={false} linkify={false} />
          </div>
          {/* One row under the question: copy, remember, time. Remember
              stores the message in the self-context (Settings → AI); only a
              persisted message that fits that field offers it. */}
          <UserMessageActions
            content={content}
            messageId={messageId}
            createdAt={createdAt}
          />
        </div>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            aria-hidden="true"
            data-slot="coach-bubble-user-avatar"
            className="border-border/50 mt-0.5 size-8 shrink-0 rounded-full border object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            data-slot="coach-bubble-user-avatar"
            className="text-foreground bg-muted/60 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          >
            {initials ?? <User className="size-3.5" />}
          </div>
        )}
      </div>
    );
  }

  // #781 — the persisted cancelled-turn marker (an EMPTY assistant row the
  // server writes when the client aborts mid-generation, e.g. navigating
  // away). Rendered as a quiet interrupted note — muted meta text per
  // UI-STANDARDS §3, never an alarm colour: nothing failed, the user left —
  // plus a retry that resubmits the question that produced the turn (the
  // regenerate closure, so the resend runs through the normal send path and
  // every budget/rate gate). No provenance, feedback, copy, or token footer:
  // there is no reply to act on.
  if (providerType === "cancelled") {
    return (
      <div
        data-slot="coach-bubble-cancelled"
        className="flex items-start gap-2.5"
      >
        <div
          aria-hidden="true"
          className="from-primary to-brand-pink mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <Sparkles className="text-background size-3.5" />
        </div>
        <div className="flex max-w-[calc(80%-2.625rem)] flex-col items-start gap-2">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("insights.coach.interrupted.note")}
          </p>
          {onRegenerate && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-slot="coach-interrupted-retry"
              className="min-h-11 sm:min-h-9"
              onClick={onRegenerate}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("insights.coach.interrupted.retry")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  // v1.4.25 W5 — map server-emitted error codes to specific Coach
  // i18n keys. Distinct user-quota and provider-rate-limit copy so the
  // user understands daily-cap (resets at UTC midnight) vs. transient
  // provider load (retry in ~5 min). Codes that have no dedicated
  // translation fall back to the generic provider-unavailable copy.
  const errorKey = errorCode ? errorCodeToI18nKey(errorCode) : null;
  const errorMessage = errorKey ? t(errorKey, {}) : null;
  // When a translated message comes back unchanged (i.e. key missing)
  // we fall back to a generic provider error string so the bubble
  // doesn't surface raw `coach.http.503` text to the user.
  const safeError =
    errorMessage && errorMessage !== errorKey
      ? errorMessage
      : errorCode
        ? t("insights.coach.errorProvider")
        : null;

  const method = metricSource?.method ?? null;

  // v1.22 (W5) — Coach charts Phase 1. Render an allowlisted, provenance-
  // grounded `metric:<TYPE>` chart under a SETTLED assistant turn. Skipped
  // while streaming / in-flight / errored / on a refusal; a no-op when no
  // grounded token is present (provider-agnostic — reads the inline token).
  // v1.39.4 — the result tables this answer references and the ones it
  // only used; the metadata is enough to place and count them.
  const resultMetas = results?.length
    ? liveWithProvenance(results, metricSource?.results ?? [])
    : (metricSource?.results ?? []);
  const shownDomains = new Set(
    resultMetas
      .filter((meta) => meta.displayed)
      .map((meta) => meta.source.domain),
  );
  const dataUsedCount =
    !inProgress && !errorCode
      ? countResultsInSection(resultMetas, "dataUsed")
      : 0;
  const chartTokens =
    !streaming && !inProgress && !errorCode && providerType !== "refusal"
      ? selectCoachChartTokens(content, metricSource?.metrics, shownDomains)
      : [];
  const settled = !inProgress && !errorCode && providerType !== "refusal";
  const memoryMeta = memoryNote ?? metricSource?.memoryNote ?? null;

  // v1.32.14 — quiet per-message notice: the grounding guard withheld ≥1 figure
  // from this reply (each rewritten to the `[…]` elision mark). Shown only on a
  // SETTLED assistant turn — skipped while in-flight, on errored and refusal
  // turns — mirroring the token-footer gating. Rides `metricSource` so it survives
  // reload with no memo change (the comparator already ref-checks metricSource).
  const showUnverifiedNotice =
    !inProgress &&
    !errorCode &&
    providerType !== "refusal" &&
    !!content &&
    (metricSource?.unverifiedFigures ?? 0) > 0;

  return (
    <div
      data-slot="coach-bubble-assistant"
      className="group/assistant-bubble flex items-start gap-2.5"
    >
      <div
        aria-hidden="true"
        className="from-primary to-brand-pink mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
      >
        {providerType === "refusal" ? (
          <Bot className="text-background size-3.5" />
        ) : (
          <Sparkles className="text-background size-3.5" />
        )}
      </div>
      {/* The answer column. Below `sm` it takes the full width beside the
          avatar (at 80 % the action row could not stay on one line at
          390 px); from `sm` it keeps the 80 % measure. It is always that
          wide, whatever the answer's length, so the action row and the
          chips never move sideways as a reply streams in; the prose bubble
          inside shrink-wraps. A table or chart takes the column's width. */}
      <div
        data-slot="coach-answer-column"
        className="flex w-full max-w-full min-w-0 flex-col items-start gap-2 sm:max-w-[calc(80%-2.625rem)]"
      >
        {/* v1.41 — what the Coach is doing, one quiet line at the top of the
            answer: live from the activity frames while the turn runs, one
            calm summary once it is done. Nothing opens by itself; a tap on
            the line opens the trail, which also says how the answer was
            worked out and holds the tables the answer read. A message saved
            before v1.41 falls back to its steps, or the areas it drew on. */}
        <CoachTurnActivity
          activity={activity ?? metricSource?.activity ?? []}
          steps={steps ?? metricSource?.steps ?? []}
          active={!!inProgress}
          startedAt={startedAt}
          endedAt={endedAt}
          areas={metricSource?.metrics}
          method={inProgress || errorCode ? null : method}
          conversationId={conversationId}
          messageId={messageId}
          dataUsed={
            dataUsedCount > 0 ? (
              <CoachResults
                conversationId={conversationId ?? null}
                messageId={messageId ?? null}
                metas={metricSource?.results ?? []}
                live={results}
                section="dataUsed"
              />
            ) : null
          }
        />
        {/* v1.41 — the tables read so far, one line each, while the turn
            still runs. They give way to the answer's own charts. */}
        {inProgress && results && interimRefs && interimRefs.length > 0 ? (
          <CoachInterimResults results={results} interimRefs={interimRefs} />
        ) : null}
        {/* The prose bubble, once there is prose or an error. While the turn
            runs without prose the status line above says what is happening;
            the bubble arrives with the first token. */}
        {(content || safeError) && (
          <div
            data-slot="coach-answer-bubble"
            className={cn(
              "border-border/60 bg-muted/40 text-foreground max-w-full",
              "rounded-xl rounded-tl-sm border px-3.5 py-2.5",
              "text-sm leading-relaxed break-words whitespace-pre-wrap",
              "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300",
            )}
          >
            {/* v1.4.25 W5b — strip stray Metric/enum leak tokens from the
                assistant prose. v1.18.9 — the live turn streams in
                word-by-word with a soft fade (<StreamedProse>); a settled
                / persisted turn renders as plain text. */}
            {/* v1.16.4 — a failed turn with no streamed prose renders the
                error copy INSIDE the bubble; with partial prose the prose
                keeps the bubble and the error stays a caption. */}
            {content ? (
              <StreamedProse content={content} streaming={!!streaming} />
            ) : safeError ? (
              <span className="text-warning">{safeError}</span>
            ) : (
              ""
            )}
          </div>
        )}
        {safeError && content && (
          <p className="text-warning text-xs">{safeError}</p>
        )}
        {/* v1.32.14 — quiet grounding caveat when the guard withheld a figure.
            Muted meta (UI-STANDARDS §3), never a warning colour — it is a
            grounding caveat, not an error. Static single line, decorative icon,
            no interactivity. The `[…]` marks in the prose above point here. */}
        {showUnverifiedNotice && (
          <p
            data-slot="coach-unverified-notice"
            className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed"
          >
            <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            {t("insights.coach.unverifiedFiguresNotice")}
          </p>
        )}
        {/* v1.22 (W5) — accompanying chart(s). The token was already
            stripped from the prose by <StreamedProse>; here it mounts the
            real, self-fetching Recharts chart for the user's own series.
            The model never emits data — only a metric identifier from a
            closed allowlist, intersected with the turn's grounded metrics. */}
        {chartTokens.length > 0 && (
          <div data-slot="coach-charts" className="flex w-full flex-col gap-3">
            {chartTokens.map((token) => {
              const metric = tokenToMetric(token);
              return (
                <div
                  key={token}
                  data-slot="coach-chart"
                  className="border-border/60 bg-muted/20 rounded-xl border p-2"
                >
                  <HealthChartDynamic
                    types={[metric]}
                    title={coachChartTitle(metric, t)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {/* v1.39.4 — the tables the turn read, on a settled turn only: live
            from the result frames, or fetched lazily for a persisted
            message whose provenance lists them. */}
        {!inProgress && !errorCode && (
          <CoachResults
            conversationId={conversationId ?? null}
            messageId={messageId ?? null}
            metas={metricSource?.results ?? []}
            live={results}
            section="displayed"
          />
        )}
        {/* v1.41 — what the answer assumed instead of asking, and what the
            Coach kept from this turn: one quiet line each. */}
        {settled && (metricSource?.assumptions?.length ?? 0) > 0 ? (
          <CoachAssumptionLine
            assumptions={metricSource?.assumptions ?? []}
            changes={followUps?.followUps ?? []}
            messageId={followUps?.messageId ?? null}
            disabled={!!followUpsDisabled}
            onChange={onFollowUp}
          />
        ) : null}
        {settled && memoryMeta ? (
          <CoachMemoryNote
            note={memoryMeta}
            liveFact={memoryNote?.fact ?? null}
          />
        ) : null}
        {/* v1.18.6 — a "no provider configured anywhere" turn is a
            setup gap, not a transient failure: surface a direct link to
            Settings → AI so the Coach guides the user into BYOK / local
            setup instead of inviting an endless retry. */}
        {(errorCode === "coach.provider.none" ||
          errorCode === "ai.provider.none") && (
          <Link
            href="/settings/ai"
            data-slot="coach-no-provider-cta"
            className="text-primary text-xs font-medium underline-offset-4 hover:underline"
          >
            {t("insights.coach.errorNoProviderAction")}
          </Link>
        )}
        {/* v1.18.1 (Workstream C) — one-tap cadence-suggestion action
            card. Live from the streaming hook, or restored from the
            persisted message provenance on reload. Not shown on
            in-flight or errored turns. */}
        {!inProgress &&
          !errorCode &&
          (() => {
            const sug = suggestion ?? metricSource?.suggestion ?? null;
            return sug ? <ReminderSuggestionCard suggestion={sug} /> : null;
          })()}
        {/* v1.22 (W7/W6) — generalised confirm-card action. Live from the
            streaming hook, or restored from persisted message provenance on
            reload. Mirrors the reminder-suggestion block above. */}
        {!inProgress &&
          !errorCode &&
          (() => {
            const action =
              suggestedAction ?? metricSource?.suggestedAction ?? null;
            return action ? <SuggestedActionCard action={action} /> : null;
          })()}
        {/* The replies the latest answer offers, in its own column: a
            question's choices or a proposal's two answers when it has them,
            else its follow-up chips. One pattern for all of them. They sit
            right under the answer, above the action row: beside a pointer
            the row stays invisible until the message is hovered or holds
            focus, and above the pills it left an empty band between the
            answer and its replies. */}
        {replies && replies.replies.length > 0 ? (
          <SuggestedReplies
            replies={replies.replies}
            messageId={replies.messageId}
            disabled={!!followUpsDisabled}
          />
        ) : followUps && onFollowUp ? (
          <CoachFollowUpChips
            followUps={followUps.followUps.filter(
              (chip) => chip.kind !== "change_assumption",
            )}
            messageId={followUps.messageId}
            disabled={!!followUpsDisabled}
            onSelect={onFollowUp}
          />
        ) : null}
        {/* One row under the answer, the last thing in its column: copy,
            read aloud, try again, details and the time. Only on a settled
            reply (not while it streams, not on an error or a refusal). */}
        {settled && content && (
          <AssistantMessageActions
            content={content}
            streaming={!!streaming}
            createdAt={createdAt}
            onRegenerate={onRegenerate}
            tokens={usage?.totalTokens ?? tokensUsed}
            model={usage?.model ?? model}
          />
        )}
      </div>
    </div>
  );
}

/**
 * v1.28.46 perf (M3) — memoized bubble. Skips re-render for every settled
 * bubble while the streaming turn grows token-by-token; the streaming bubble
 * (changed `content`/`streaming`) is the only one that re-renders. `displayName`
 * is set so the name survives the memo wrapper in React DevTools.
 */
export const ChatBubble = memo(ChatBubbleImpl, areChatBubblePropsEqual);
ChatBubble.displayName = "ChatBubble";

/**
 * v1.16.1 — classic chat typing indicator: three dots pulsing in
 * sequence inside the assistant bubble, shown only between submit and
 * the first streamed token. Uses the stock `animate-pulse` keyframe
 * with staggered delays so no custom keyframe is introduced;
 * `motion-reduce` freezes the dots and the `label` stays as the
 * screen-reader text either way.
 *
 * Exported since v1.16.5: the guided clarifying-question bubble replays
 * the same indicator before a deterministic question reveals, so the
 * scripted turns share one rhythm with the streamed ones.
 */
export function TypingDots({ label }: { label: string }) {
  return (
    <span
      data-slot="coach-typing-indicator"
      // v1.21.2.1 — the pre-stream beat shows ONLY the three bouncing dots,
      // no "Thinking…" word. The label stays in an `sr-only` span so the
      // screen-reader still announces the thinking state.
      className="text-muted-foreground inline-flex items-center gap-2 py-0.5"
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="bg-primary/70 size-1.5 animate-bounce rounded-full motion-reduce:animate-none"
            style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
          />
        ))}
      </span>
    </span>
  );
}
