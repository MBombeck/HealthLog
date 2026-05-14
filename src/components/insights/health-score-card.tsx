"use client";

import { ArrowDown, ArrowUp, Minus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.20 phase B5 — Personal Health Score panel.
 *
 * Lives on the right side of the `<HeroStrip>` band on `lg+` viewports
 * and stacks below the title block on `<lg`. Surfaces:
 *   - the composite 0..100 score with a band-coloured number
 *   - "vs last week" delta line with arrow + percentage
 *   - 4 component rows (BP / Weight / Mood / Compliance) with sub-bars
 *   - "Indicative — not a clinical assessment" disclaimer
 *   - "Ask the Coach" button that opens the B2 drawer with a prefill
 *     ("Why is my health score X out of 100?") so the user can drill
 *     into the explanation without retyping the question
 *
 * Pure presentational — the parent owns the analytics query + the
 * drawer state. The same `onAskCoach` handler is shared with the hero
 * strip's main "Ask the coach" button (different prefill string).
 */

export type HealthScoreBand = "green" | "yellow" | "red";

export interface HealthScoreCardProps {
  score: number;
  band: HealthScoreBand;
  components: {
    bp: { value: number | null; weight: number };
    weight: { value: number | null; weight: number };
    mood: { value: number | null; weight: number };
    compliance: { value: number | null; weight: number };
  };
  delta: number | null;
  onAskCoach?: (prefill: string) => void;
}

const BAND_NUMBER_CLASS: Record<HealthScoreBand, string> = {
  green: "text-dracula-green",
  yellow: "text-dracula-orange",
  red: "text-dracula-red",
};

const BAND_BORDER_CLASS: Record<HealthScoreBand, string> = {
  green: "border-dracula-green/40",
  yellow: "border-dracula-orange/40",
  red: "border-dracula-red/40",
};

const BAND_PROGRESS_CLASS: Record<HealthScoreBand, string> = {
  green: "bg-dracula-green",
  yellow: "bg-dracula-orange",
  red: "bg-dracula-red",
};

const COMPONENT_LABEL_KEY: Record<
  keyof HealthScoreCardProps["components"],
  string
> = {
  bp: "insights.healthScore.componentBp",
  weight: "insights.healthScore.componentWeight",
  mood: "insights.healthScore.componentMood",
  compliance: "insights.healthScore.componentCompliance",
};

export function HealthScoreCard({
  score,
  band,
  components,
  delta,
  onAskCoach,
}: HealthScoreCardProps) {
  const { t } = useTranslations();
  const componentEntries = (
    Object.keys(components) as Array<keyof HealthScoreCardProps["components"]>
  ).map((key) => ({
    key,
    label: t(COMPONENT_LABEL_KEY[key]),
    value: components[key].value,
  }));

  return (
    <div
      data-slot="health-score-card"
      data-band={band}
      className={cn(
        "bg-card/65 rounded-xl border px-4 py-4 shadow-sm backdrop-blur-sm",
        BAND_BORDER_CLASS[band],
        // v1.4.25 W3 — Marc reported the German "Einnahmetreue" label
        // overlapping the band-coloured component-value pill at the
        // right of each row. The original `w-[220px]` left only ~64px
        // for the label column after the bar + value chip ate the
        // rest, which fits "Mood" / "BP" but truncates the longer
        // German strings. Bumped to `w-[260px]` so the card sits
        // ~18 % wider on `lg+` without disturbing the title block's
        // visual centre of gravity; the label column is widened in
        // step with this so the breathing room actually lands on the
        // text.
        "w-full lg:w-[260px] lg:shrink-0",
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p
            data-slot="health-score-card-label"
            className="text-muted-foreground text-[10px] font-semibold tracking-[0.18em] uppercase"
          >
            {t("insights.healthScore.label")}
          </p>
          {delta !== null && delta > 0 && (
            <span
              data-slot="health-score-card-delta-chip"
              className="bg-dracula-green/15 text-dracula-green rounded-full px-2 py-0.5 text-[10px] font-semibold"
            >
              +{delta}
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-1">
          <span
            data-slot="health-score-card-number"
            className={cn(
              "text-4xl leading-none font-semibold tabular-nums",
              BAND_NUMBER_CLASS[band],
            )}
          >
            {score}
          </span>
          <span
            aria-hidden="true"
            className="text-muted-foreground text-sm tabular-nums"
          >
            / 100
          </span>
        </div>

        <div
          data-slot="health-score-card-progress"
          className="bg-muted/50 h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("insights.healthScore.progressAria")}
        >
          <div
            className={cn("h-full transition-all", BAND_PROGRESS_CLASS[band])}
            style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
          />
        </div>

        <p
          data-slot="health-score-card-delta"
          className="text-muted-foreground inline-flex items-center gap-1 text-[11px]"
        >
          {delta === null ? (
            <span>{t("insights.healthScore.deltaUnavailable")}</span>
          ) : (
            <>
              {delta > 0 && (
                <ArrowUp
                  className="text-dracula-green h-3 w-3"
                  aria-hidden="true"
                />
              )}
              {delta < 0 && (
                <ArrowDown
                  className="text-dracula-red h-3 w-3"
                  aria-hidden="true"
                />
              )}
              {delta === 0 && (
                <Minus
                  className="text-muted-foreground h-3 w-3"
                  aria-hidden="true"
                />
              )}
              <span>
                {t("insights.healthScore.deltaVsLastWeek", {
                  delta: delta > 0 ? `+${delta}` : `${delta}`,
                })}
              </span>
            </>
          )}
        </p>

        <ul
          data-slot="health-score-card-components"
          className="space-y-1.5 border-t pt-3"
        >
          {componentEntries.map(({ key, label, value }) => (
            <li
              key={key}
              data-slot="health-score-card-component-row"
              data-component={key}
              className="flex items-center gap-2 text-[11px]"
            >
              {/* v1.4.25 W3 — widened label column from w-16 (64px) to
                  w-24 (96px) so the longest German label
                  ("Einnahmetreue" — 13 chars at 11px) sits inside the
                  column without spilling into the bar/value chip. */}
              <span className="text-muted-foreground w-24 shrink-0 truncate">
                {label}
              </span>
              <div
                className="bg-muted/50 h-1 flex-1 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <div
                  className={cn(
                    "h-full",
                    value === null ? "bg-muted" : BAND_PROGRESS_CLASS[band],
                  )}
                  style={{
                    width:
                      value === null
                        ? "0%"
                        : `${Math.max(0, Math.min(100, value))}%`,
                  }}
                />
              </div>
              <span
                data-slot="health-score-card-component-value"
                className="text-foreground w-8 shrink-0 text-right tabular-nums"
              >
                {value === null ? "—" : Math.round(value)}
              </span>
            </li>
          ))}
        </ul>

        <p
          data-slot="health-score-card-disclaimer"
          className="text-muted-foreground text-[10px] leading-snug"
        >
          {t("insights.healthScore.disclaimer")}
        </p>

        {onAskCoach && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-slot="health-score-card-ask-coach"
            className="w-full gap-1.5"
            onClick={() =>
              onAskCoach(t("insights.healthScore.coachPrompt", { score }))
            }
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("insights.healthScore.askCoach")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
