"use client";

/**
 * v1.16.5 — in-thread bubbles for the guided clarifying-questions flow
 * (see `guided-questions-machine.ts` for the state machine).
 *
 * Two bubbles, both deterministic (no model call) and both styled as a
 * close sibling of the assistant bubble so the sequence reads as the
 * Coach speaking — same avatar position and bubble geometry, but a
 * purple-tinted surface and a question-mark avatar so a guided turn is
 * visually distinct from AI prose:
 *
 *   - `GuidedQuestionBubble` — one clarifying question with a
 *     "question 1 of 3" progress line + dot strip. The CURRENT question
 *     briefly shows the shared typing-dots indicator before the text
 *     reveals (the classic scripted-bot rhythm) and carries the quiet
 *     skip / later / don't-ask-again actions beneath the bubble.
 *     Answered questions re-render static (no actions, no reveal),
 *     anchored above the answer that resolved them.
 *   - `GuidedSummaryBubble` — the closing recap: how many questions
 *     were answered, how many answers were adopted into the
 *     self-context, and a deep-link to Settings → AI to review it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ClipboardCheck,
  MessageCircleQuestion,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { TypingDots } from "./message-thread";

/** Shared quiet text-button styling for the per-question actions. */
const guidedActionClass = cn(
  "text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center rounded-full px-2.5 text-xs",
  "hover:bg-primary/10 focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
  "disabled:opacity-60",
);

function GuidedAvatar({ icon: Icon }: { icon: typeof ClipboardCheck }) {
  return (
    <div
      aria-hidden="true"
      className="from-primary to-brand-pink mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
    >
      <Icon className="text-background size-3.5" />
    </div>
  );
}

/**
 * Dot strip mirroring the textual progress label: filled = asked
 * (everything before the current question, answered or skipped),
 * outlined = the current one, muted = still ahead. Decorative — the
 * "question 1 of 3" text is the accessible progress signal.
 */
function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-full",
            i + 1 < current && "bg-primary",
            i + 1 === current && "ring-primary bg-primary/40 ring-1",
            i + 1 > current && "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

export interface GuidedQuestionBubbleProps {
  question: string;
  progress: { current: number; total: number };
  /** Live question: actions render and the typing reveal plays. */
  current?: boolean;
  onSkip?: () => void;
  onLater?: () => void;
  onDismissRemaining?: () => void;
  /** Disables the actions (in-flight dismiss request). */
  actionsDisabled?: boolean;
}

export function GuidedQuestionBubble({
  question,
  progress,
  current = false,
  onSkip,
  onLater,
  onDismissRemaining,
  actionsDisabled = false,
}: GuidedQuestionBubbleProps) {
  const { t } = useTranslations();

  // Scripted-bot rhythm: the current question holds the shared
  // typing-dots indicator for a beat before the text reveals. SSR and
  // reduced-motion users get the text immediately; answered bubbles
  // never replay the reveal.
  const [revealed, setRevealed] = useState<boolean>(() => {
    if (!current) return true;
    if (typeof window === "undefined") return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (revealed) return;
    const handle = window.setTimeout(() => setRevealed(true), 650);
    return () => window.clearTimeout(handle);
  }, [revealed]);

  return (
    <div
      data-slot="coach-guided-question"
      data-state={current ? "current" : "answered"}
      className="flex items-start gap-2.5"
    >
      <GuidedAvatar icon={MessageCircleQuestion} />
      <div className="flex max-w-[calc(80%-2.625rem)] min-w-0 flex-col gap-1.5">
        <div
          className={cn(
            "border-primary/30 bg-primary/10 text-foreground",
            "rounded-xl rounded-tl-sm border px-3.5 py-2.5",
            "text-sm leading-relaxed",
          )}
        >
          {revealed ? (
            <>
              <p
                data-slot="coach-guided-progress"
                className="text-primary mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase"
              >
                {t("insights.coach.guided.progress", {
                  current: progress.current,
                  total: progress.total,
                })}
                <ProgressDots
                  current={progress.current}
                  total={progress.total}
                />
              </p>
              <p className="whitespace-pre-wrap">{question}</p>
            </>
          ) : (
            <TypingDots label={t("insights.coach.thinking")} />
          )}
        </div>
        {current && revealed && (
          <div
            data-slot="coach-guided-actions"
            className="flex flex-wrap items-center gap-1"
          >
            <button
              type="button"
              data-slot="coach-guided-skip"
              disabled={actionsDisabled}
              onClick={onSkip}
              className={guidedActionClass}
            >
              {t("insights.coach.guided.skip")}
            </button>
            <button
              type="button"
              data-slot="coach-guided-later"
              disabled={actionsDisabled}
              onClick={onLater}
              className={guidedActionClass}
            >
              {t("insights.coach.guided.later")}
            </button>
            <button
              type="button"
              data-slot="coach-guided-dismiss"
              disabled={actionsDisabled}
              onClick={onDismissRemaining}
              className={guidedActionClass}
            >
              {t("insights.coach.guided.dismissRemaining")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export interface GuidedSummaryBubbleProps {
  answered: number;
  adopted: number;
  total: number;
}

export function GuidedSummaryBubble({
  answered,
  adopted,
  total,
}: GuidedSummaryBubbleProps) {
  const { t } = useTranslations();

  return (
    <div data-slot="coach-guided-summary" className="flex items-start gap-2.5">
      <GuidedAvatar icon={ClipboardCheck} />
      <div
        className={cn(
          "border-primary/30 bg-primary/10 text-foreground",
          "max-w-[calc(80%-2.625rem)] min-w-0 rounded-xl rounded-tl-sm border px-3.5 py-2.5",
        )}
      >
        <p className="text-sm font-medium">
          {t("insights.coach.guided.summaryTitle")}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("insights.coach.guided.summaryAnswered", { answered, total })}
          {" · "}
          {adopted > 0
            ? t("insights.coach.guided.summaryAdopted", { adopted })
            : t("insights.coach.guided.summaryAdoptedNone")}
        </p>
        <Link
          href="/settings/ai"
          data-slot="coach-guided-summary-link"
          className={cn(
            "text-primary mt-2 inline-flex min-h-8 items-center gap-1 text-xs font-medium",
            "focus-visible:ring-input-focus rounded hover:underline focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          {t("insights.coach.guided.summaryLink")}
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
