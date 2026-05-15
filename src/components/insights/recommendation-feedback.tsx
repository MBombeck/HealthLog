"use client";

/**
 * v1.4.16 phase B5e — RecommendationFeedback.
 *
 * Two small icon buttons (thumb-up / thumb-down) under each rec card,
 * surfaced in the `data-slot="rec-feedback-slot"` slot reserved by
 * B5c's `<RecommendationCard>`.
 *
 * UX states:
 *   - default       → both buttons rendered, neither pressed
 *   - submitting    → buttons disabled, the chosen verdict spinner-tinted
 *   - submitted-up  → confirmation row replaces the buttons + the
 *                     pressed thumb is highlighted; "Thanks for your
 *                     feedback" text
 *   - submitted-down → mirror of submitted-up for the negative verdict
 *   - already-rated-up / -down → quiet state when the server returned
 *     409 (the user already rated this rec text in a previous session)
 *
 * Local cache: a `(userId, recId, recText)` tuple is keyed in
 * localStorage so a refresh doesn't allow re-rating. Server-side dedup
 * via the unique constraint on `recommendation_feedback` is the source
 * of truth — the local cache is just a UX nicety.
 *
 * Keyboard accessible: both buttons are real `<button type="button">`
 * elements, focusable, Enter/Space-activatable. aria-label translates.
 */

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ThumbsUp, ThumbsDown, Loader2, Check } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import type { RecommendationFeedbackRequest } from "@/lib/validations/recommendation-feedback";

// v1.4.16 phase D reconcile (simplify F5) — re-export the canonical
// types from the validation schema instead of hand-maintaining the
// same enum vocabulary. Drift between the two used to be a real risk
// (a future "last180days" added to the schema would silently break
// the component without a compile error).
export type RecommendationFeedbackSeverity =
  RecommendationFeedbackRequest["recommendationSeverity"];

export type RecommendationFeedbackTimeRange =
  RecommendationFeedbackRequest["metricSourceTimeRange"];

export interface RecommendationFeedbackProps {
  recId: string;
  recText: string;
  recSeverity: RecommendationFeedbackSeverity;
  metricSourceType: string;
  metricSourceTimeRange: RecommendationFeedbackTimeRange;
  /**
   * Override the local-cache lookup so SSR tests can pin a state
   * deterministically. Production callers leave this `undefined`;
   * the component reads localStorage on mount.
   */
  initialState?: FeedbackState;
}

type FeedbackState =
  | "default"
  | "submitting-up"
  | "submitting-down"
  | "submitted-up"
  | "submitted-down"
  | "already-rated-up"
  | "already-rated-down";

const LOCAL_STORAGE_PREFIX = "healthlog-rec-feedback";

interface FeedbackEnvelope {
  data: { id: string; createdAt: string } | null;
  error?: string | null;
}

function localCacheKey(userId: string, recId: string, recText: string): string {
  // recText is part of the key because the server-side dedup also
  // includes it — a regeneration that rewrites the same id with new
  // text counts as a different row, and we want the UX to match.
  // Hash via a length-bounded slice so the localStorage key stays
  // small (the cache is best-effort; collisions on truncated text are
  // extremely rare in practice).
  const textKey = recText.slice(0, 80).replace(/\s+/g, " ").trim();
  return `${LOCAL_STORAGE_PREFIX}:${userId}:${recId}:${textKey}`;
}

function readLocalState(
  userId: string,
  recId: string,
  recText: string,
): FeedbackState {
  if (typeof window === "undefined") return "default";
  try {
    const raw = window.localStorage.getItem(
      localCacheKey(userId, recId, recText),
    );
    if (raw === "up" || raw === "down") return `submitted-${raw}` as const;
    if (raw === "already-rated-up" || raw === "already-rated-down") {
      return raw;
    }
  } catch {
    // Private mode / quota exceeded → fall through to default.
  }
  return "default";
}

function writeLocalState(
  userId: string,
  recId: string,
  recText: string,
  verdict: "up" | "down" | "already-rated-up" | "already-rated-down",
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localCacheKey(userId, recId, recText), verdict);
  } catch {
    // Best-effort — server dedup is the source of truth.
  }
}

export function RecommendationFeedback({
  recId,
  recText,
  recSeverity,
  metricSourceType,
  metricSourceTimeRange,
  initialState,
}: RecommendationFeedbackProps) {
  const { t } = useTranslations();
  const { user } = useAuth();

  const [state, setState] = useState<FeedbackState>(() => {
    if (initialState) return initialState;
    if (!user) return "default";
    return readLocalState(user.id, recId, recText);
  });

  // Track which userId the state corresponds to. When auth resolves
  // after mount (fetch was in-flight on first render), we recompute
  // state from the local cache during render — never via useEffect,
  // which would trip the `react-hooks/set-state-in-effect` rule.
  const [hydratedFor, setHydratedFor] = useState<string | null>(() =>
    user ? user.id : null,
  );
  if (!initialState && user && hydratedFor !== user.id) {
    const fromLocal = readLocalState(user.id, recId, recText);
    setState(fromLocal);
    setHydratedFor(user.id);
  }

  const mutation = useMutation({
    mutationFn: async (helpful: boolean) => {
      const res = await fetch("/api/insights/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId: recId,
          recommendationText: recText,
          recommendationSeverity: recSeverity,
          metricSourceType,
          metricSourceTimeRange,
          helpful,
        }),
      });
      const body = (await res.json()) as FeedbackEnvelope;
      if (res.status === 409) {
        return { duplicate: true, helpful } as const;
      }
      if (!res.ok) {
        throw new Error(body.error ?? "feedback_failed");
      }
      return { duplicate: false, helpful } as const;
    },
    onSuccess: (result) => {
      if (!user) return;
      if (result.duplicate) {
        const verdict = result.helpful
          ? "already-rated-up"
          : "already-rated-down";
        writeLocalState(user.id, recId, recText, verdict);
        setState(verdict);
        return;
      }
      const verdict = result.helpful ? "up" : "down";
      writeLocalState(user.id, recId, recText, verdict);
      setState(`submitted-${verdict}` as const);
      // v1.4.16 phase D reconcile (code-review H6) — feedback doesn't
      // affect the displayed insight content, so invalidating the entire
      // ["insights"] tree (8 queries: comprehensive + 7 per-status)
      // would force expensive refetches on a stale cache. The user-
      // visible state lives in localStorage + the local React state
      // above. The v1.4.17 ratchet that consumes feedback into the
      // next generation will scope its own invalidation.
    },
    onError: () => {
      // Optimistic-rollback: drop back to default so the user can
      // retry. We don't surface a toast — the parent rec card already
      // crowded enough; a silent reset is the friendlier UX here.
      setState("default");
    },
  });

  const submit = useMemo(
    () => (helpful: boolean) => {
      setState(helpful ? "submitting-up" : "submitting-down");
      mutation.mutate(helpful);
    },
    [mutation],
  );

  // ── Render ──────────────────────────────────────────────────────

  if (state === "submitted-up" || state === "submitted-down") {
    const verdict = state === "submitted-up" ? "up" : "down";
    return (
      <div
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        data-slot="rec-feedback-confirmation"
      >
        <Check className="text-dracula-green h-3.5 w-3.5" aria-hidden="true" />
        <span data-feedback-confirmed={verdict}>
          {t("insights.recommendation.feedbackThanks")}
        </span>
      </div>
    );
  }

  if (state === "already-rated-up" || state === "already-rated-down") {
    const verdict = state === "already-rated-up" ? "up" : "down";
    return (
      <div
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        data-slot="rec-feedback-already-rated"
      >
        {verdict === "up" ? (
          <ThumbsUp
            className="text-dracula-green h-3.5 w-3.5"
            aria-hidden="true"
          />
        ) : (
          <ThumbsDown
            className="text-dracula-orange h-3.5 w-3.5"
            aria-hidden="true"
          />
        )}
        <span data-feedback-already-rated={verdict}>
          {t("insights.recommendation.feedbackAlreadyRated")}
        </span>
      </div>
    );
  }

  const submittingUp = state === "submitting-up";
  const submittingDown = state === "submitting-down";
  const disabled = submittingUp || submittingDown;

  return (
    <div className="flex items-center gap-1.5" data-slot="rec-feedback-buttons">
      <button
        type="button"
        data-feedback-thumb="up"
        aria-label={t("insights.recommendation.feedbackHelpful")}
        title={t("insights.recommendation.feedbackHelpful")}
        disabled={disabled}
        onClick={() => submit(true)}
        className="text-muted-foreground hover:text-dracula-green disabled:hover:text-muted-foreground focus-visible:ring-ring/50 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        {submittingUp ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        data-feedback-thumb="down"
        aria-label={t("insights.recommendation.feedbackNotHelpful")}
        title={t("insights.recommendation.feedbackNotHelpful")}
        disabled={disabled}
        onClick={() => submit(false)}
        className="text-muted-foreground hover:text-dracula-orange disabled:hover:text-muted-foreground focus-visible:ring-ring/50 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        {submittingDown ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
