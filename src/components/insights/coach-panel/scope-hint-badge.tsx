"use client";

import { Sparkles, Target, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.21.2 (A2 + A3) — the Coach's visible scope/opener affordance.
 *
 * Two modes, one surface:
 *
 *  - **scope** (A2): the Coach was launched narrowed to a metric (from a
 *    metric page or an insight card). Instead of the old hidden composer
 *    prefill, render a small pill — "The Coach is already on <metric>" —
 *    plus a tappable seed question that drops the data-aware opener into
 *    the composer / sends it. This turns the built-but-invisible scope
 *    plumbing into the core ambient feeling.
 *
 *  - **seeded** (A3): the Coach opened UNSCOPED (the blank hero) and the
 *    server surfaced today's single most notable derived signal. Render it
 *    as a tappable suggested opener so the blank box is never cold. When no
 *    signal crosses the gate the caller renders nothing and the neutral
 *    greeting stands — there is no fake opener.
 *
 * Presentational + self-contained: the parent supplies the resolved label
 * and the seed question, and an `onSeed` callback wired to the composer.
 * The badge owns no data fetching.
 */
export interface ScopeHintBadgeProps {
  /**
   * Which affordance this is. `scope` shows the "already on <metric>" pill;
   * `seeded` shows the notable-signal opener. Drives the icon + the prefix
   * copy only — the tappable seed question is shared.
   */
  variant: "scope" | "seeded";
  /**
   * The visible metric / signal label, already resolved to the user's
   * locale by the caller (e.g. "blood pressure", "readiness").
   */
  label: string;
  /** The tappable seed question — the data-aware opener. */
  question: string;
  /** Fired with the seed question when the user taps the opener. */
  onSeed: (question: string) => void;
  /**
   * Dismiss the opener. Only honoured for `variant="seeded"` — the seeded
   * opener is a soft suggestion the user can wave off for the day, while the
   * A2 scope pill reflects how the chat was launched and is not dismissable.
   */
  onDismiss?: () => void;
  className?: string;
}

export function ScopeHintBadge({
  variant,
  label,
  question,
  onSeed,
  onDismiss,
  className,
}: ScopeHintBadgeProps) {
  const { t } = useTranslations();

  const Icon = variant === "scope" ? Target : Sparkles;
  const prefix =
    variant === "scope"
      ? t("insights.coach.scope.prefix", { metric: label })
      : t("insights.coach.seeded.prefix", { signal: label });

  return (
    <div
      data-slot="coach-scope-hint"
      data-variant={variant}
      className={cn("flex w-full flex-col items-center gap-2.5", className)}
    >
      {/* The scope/signal pill — the visible "already on …" line. */}
      <span
        data-slot="coach-scope-hint-pill"
        className={cn(
          "border-border/60 bg-muted/40 text-muted-foreground",
          "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1",
          "text-xs font-medium",
        )}
      >
        <Icon className="text-primary size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{prefix}</span>
      </span>

      {/* The tappable seed question — the data-aware opener. A real button so
          keyboard + screen-reader users get the same affordance. v1.25.0 — the
          opener sizes to its TEXT (intrinsic width, centred) instead of being
          stretched to the full composer width, which left a large empty tail
          that read as broken. It is guaranteed single-line: the question
          truncates with an ellipsis on a narrow phone rather than wrapping or
          forcing a horizontal scroll. The seeded variant keeps the dismiss
          control at the trailing edge. */}
      <div className="flex w-full items-center justify-center gap-1.5">
        <button
          type="button"
          data-slot="coach-scope-hint-seed"
          onClick={() => onSeed(question)}
          className={cn(
            "group border-border/70 bg-background hover:bg-muted/50 text-foreground",
            "inline-flex max-w-full min-w-0 items-center gap-2 rounded-xl border px-3.5 py-2.5 text-left",
            "transition-colors",
            "focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          <span className="min-w-0 truncate text-sm leading-snug">
            {question}
          </span>
          <span
            aria-hidden="true"
            className="text-muted-foreground group-hover:text-foreground shrink-0 text-xs whitespace-nowrap"
          >
            {t("insights.coach.scope.tap")}
          </span>
        </button>
        {variant === "seeded" && onDismiss ? (
          <button
            type="button"
            data-slot="coach-scope-hint-dismiss"
            onClick={onDismiss}
            aria-label={t("insights.coach.seeded.dismiss")}
            title={t("insights.coach.seeded.dismiss")}
            className={cn(
              "text-muted-foreground hover:bg-muted/60 hover:text-foreground shrink-0",
              "flex size-9 items-center justify-center rounded-xl transition-colors",
              "focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
