"use client";

import { useId, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Minus, Sparkles } from "lucide-react";
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
 * v1.4.25 W8e — collapsible "Driven by" provenance accordion appended
 * below the component sub-bars. Each row shows the value bar, the
 * effective weight share, and a source pill so the user can see which
 * ingest path produced each pillar. A "mixed source" banner fires when
 * at least one component blends entries from more than one source.
 *
 * Pure presentational — the parent owns the analytics query + the
 * drawer state. The same `onAskCoach` handler is shared with the hero
 * strip's main "Ask the coach" button (different prefill string).
 */

export type HealthScoreBand = "green" | "yellow" | "red";

/**
 * v1.4.25 W8e — per-component source attribution. Mirrors the analytics
 * `HealthScoreComponentSource` type (intentional duplication so the
 * client doesn't pull a heavy analytics import for one string union).
 */
export type HealthScoreComponentSource =
  | "manual"
  | "withings"
  | "appleHealth"
  | "mixed"
  | "none";

export interface HealthScoreCardComponent {
  value: number | null;
  weight: number;
  /**
   * v1.4.25 W8e — optional source label. When omitted the row falls
   * back to `manual` for present values / `none` for null values.
   */
  source?: HealthScoreComponentSource;
  /**
   * v1.4.25 W8e — optional ISO timestamp of the freshest contributing
   * measurement. The provenance accordion surfaces it under "as of
   * {date}" on each row.
   */
  asOf?: string;
}

export interface HealthScoreCardProps {
  score: number;
  band: HealthScoreBand;
  components: {
    bp: HealthScoreCardComponent;
    weight: HealthScoreCardComponent;
    mood: HealthScoreCardComponent;
    compliance: HealthScoreCardComponent;
  };
  delta: number | null;
  onAskCoach?: (prefill: string) => void;
  /**
   * v1.4.25 W8e — opens the provenance accordion on first render.
   * The SSR tests use it to exercise the expanded markup without a
   * `useEffect` round-trip; in production the user-driven toggle
   * starts collapsed.
   */
  initiallyExpanded?: boolean;
}

type ComponentKey = keyof HealthScoreCardProps["components"];

const SOURCE_LABEL_KEY: Record<HealthScoreComponentSource, string> = {
  manual: "insights.healthScore.provenance.sources.manual",
  withings: "insights.healthScore.provenance.sources.withings",
  appleHealth: "insights.healthScore.provenance.sources.appleHealth",
  mixed: "insights.healthScore.provenance.sources.mixed",
  none: "insights.healthScore.provenance.sources.none",
};

/**
 * Per-source pill colour vocabulary — mirrors the Coach provenance
 * `<SourceChips>` accent for `withings` (dracula-cyan) so the user
 * reads "same provenance grammar across surfaces". Manual rides on
 * dracula-purple, Apple Health on dracula-pink, mixed on dracula-yellow.
 * `none` is a muted slate so the empty-state row reads as dimmed
 * without losing the pill affordance entirely.
 */
const SOURCE_PILL_CLASS: Record<HealthScoreComponentSource, string> = {
  manual: "border-dracula-purple/30 text-dracula-purple/90",
  withings: "border-dracula-cyan/30 text-dracula-cyan/90",
  appleHealth: "border-dracula-pink/30 text-dracula-pink/90",
  mixed: "border-dracula-yellow/30 text-dracula-yellow/90",
  none: "border-muted-foreground/30 text-muted-foreground",
};

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

// v1.4.25 W8e — provenance row order. Module-scope so the array is
// allocated once per process rather than on every card render; the
// downstream `.map()` is non-mutating, so a fresh copy isn't needed.
const COMPONENT_ORDER: readonly ComponentKey[] = [
  "bp",
  "weight",
  "mood",
  "compliance",
];

export function HealthScoreCard({
  score,
  band,
  components,
  delta,
  onAskCoach,
  initiallyExpanded = false,
}: HealthScoreCardProps) {
  const { t, locale } = useTranslations();
  // The asOf timestamps render under the source pill as a tooltip
  // (`title`) so the row layout stays one-line. Dates format via the
  // user's locale to honour the EU comma / dot convention; on bad input
  // we fall through to the raw ISO so the user still sees something.
  // The formatter is memoised per locale so the row map below doesn't
  // build a fresh `Intl.DateTimeFormat` instance per row.
  const asOfFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      }),
    [locale],
  );
  const formatAsOf = (asOf: string | null): string | null => {
    if (!asOf) return null;
    const parsed = new Date(asOf);
    if (Number.isNaN(parsed.getTime())) return null;
    return asOfFormatter.format(parsed);
  };
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // `useId` keeps the aria-controls/section-id pair unique even when
  // the card is mounted twice on the same page (lg+ hero strip vs
  // smaller stacked previews in tests).
  const panelId = useId();

  const componentEntries = (
    Object.keys(components) as Array<ComponentKey>
  ).map((key) => ({
    key,
    label: t(COMPONENT_LABEL_KEY[key]),
    value: components[key].value,
  }));

  // v1.4.25 W8e — sort the provenance rows by effective weight
  // descending so the biggest contributor sits first. Components with
  // null values sink to the bottom (`weight * 0 === 0`); the tie-break
  // is the alphabetical key order so determinism holds across renders.
  const provenanceRows = COMPONENT_ORDER
    .map((key) => {
      const c = components[key];
      const inferredSource: HealthScoreComponentSource =
        c.source ?? (c.value === null ? "none" : "manual");
      return {
        key,
        label: t(COMPONENT_LABEL_KEY[key]),
        value: c.value,
        weight: c.weight,
        source: inferredSource,
        asOf: c.asOf ?? null,
        effective: c.weight * (c.value !== null ? 1 : 0),
      };
    })
    .sort(
      (a, b) =>
        b.effective - a.effective || a.key.localeCompare(b.key),
    );

  const presentCount = provenanceRows.filter((r) => r.value !== null).length;
  const totalCount = provenanceRows.length;
  const hasMixed = provenanceRows.some((r) => r.source === "mixed");
  // v1.4.25 W8e — "provisional" when less than half of the configured
  // inputs have data. Subtle badge above the headline number; copy is
  // localised via `provenance.provisional`.
  const isProvisional =
    totalCount > 0 && presentCount > 0 && presentCount < totalCount / 2;

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
          <div className="flex min-w-0 items-center gap-2">
            <p
              data-slot="health-score-card-label"
              className="text-muted-foreground text-[10px] font-semibold tracking-[0.18em] uppercase"
            >
              {t("insights.healthScore.label")}
            </p>
            {isProvisional && (
              <span
                data-slot="health-score-card-provisional-badge"
                className="border-muted-foreground/30 text-muted-foreground inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase"
                title={t("insights.healthScore.provenance.provisional", {
                  count: presentCount,
                  total: totalCount,
                })}
              >
                {t("insights.healthScore.provenance.provisionalBadge")}
              </span>
            )}
          </div>
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

        {/* v1.4.25 W8e — tap-to-expand provenance accordion.
            Kept inside the card so the visual "owner" of the
            breakdown remains the score tile (concept-cohesion).
            No top border here — the components list above already
            owns the divider stride; a second border would read
            visually heavy. */}
        <div className="-mt-1">
          <button
            type="button"
            id={`${panelId}-toggle`}
            data-slot="health-score-card-provenance-toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              "flex w-full items-center justify-between gap-1 rounded text-[11px]",
            )}
          >
            <span>{t("insights.healthScore.provenance.toggle")}</span>
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>

          {expanded && (
            <section
              id={panelId}
              aria-labelledby={`${panelId}-toggle`}
              data-slot="health-score-card-provenance-panel"
              className="mt-2 space-y-1.5"
            >
              {hasMixed && (
                <p
                  data-slot="health-score-card-provenance-mixed-banner"
                  role="status"
                  className="border-dracula-yellow/30 text-dracula-yellow/90 bg-dracula-yellow/5 rounded border px-2 py-1 text-[10px] leading-snug"
                >
                  {t("insights.healthScore.provenance.mixedBanner")}
                </p>
              )}
              <ul
                data-slot="health-score-card-provenance-rows"
                className="space-y-1.5"
              >
                {provenanceRows.map((row) => {
                  const sourceLabel = t(SOURCE_LABEL_KEY[row.source]);
                  const isEmpty = row.source === "none" || row.value === null;
                  const asOfFormatted = formatAsOf(row.asOf);
                  const asOfLine = asOfFormatted
                    ? t("insights.healthScore.provenance.asOfLabel", {
                        date: asOfFormatted,
                      })
                    : null;
                  return (
                    <li
                      key={row.key}
                      data-slot="health-score-card-provenance-row"
                      data-component={row.key}
                      data-source={row.source}
                      className={cn(
                        "flex items-center gap-2 text-[11px]",
                        isEmpty && "opacity-50",
                      )}
                    >
                      <span className="text-muted-foreground w-20 shrink-0 truncate">
                        {row.label}
                      </span>
                      {/* value bar — same vocabulary as the existing
                          sub-bar row so the two stride lines align */}
                      <div
                        className="bg-muted/50 h-1 flex-1 overflow-hidden rounded-full"
                        aria-hidden="true"
                      >
                        <div
                          className={cn(
                            "h-full",
                            isEmpty ? "bg-muted" : BAND_PROGRESS_CLASS[band],
                          )}
                          style={{
                            width: isEmpty
                              ? "0%"
                              : `${Math.max(0, Math.min(100, row.value ?? 0))}%`,
                          }}
                        />
                      </div>
                      <span
                        data-slot="health-score-card-provenance-value"
                        className="text-foreground w-8 shrink-0 text-right tabular-nums"
                      >
                        {row.value === null ? "—" : Math.round(row.value)}
                      </span>
                      {/* weight share — second, narrower bar tinted
                          dracula-cyan to read "provenance grammar"
                          alongside the Coach <SourceChips> accent */}
                      <div
                        className="bg-muted/40 h-1 w-10 shrink-0 overflow-hidden rounded-full"
                        aria-hidden="true"
                      >
                        <div
                          className={cn(
                            "h-full",
                            isEmpty
                              ? "bg-muted"
                              : "bg-dracula-cyan/60",
                          )}
                          style={{
                            width: isEmpty
                              ? "0%"
                              : `${Math.max(0, Math.min(100, row.weight * 100))}%`,
                          }}
                        />
                      </div>
                      <span
                        data-slot="health-score-card-provenance-pill"
                        aria-label={t(
                          "insights.healthScore.provenance.sourceAria",
                          { source: sourceLabel },
                        )}
                        title={asOfLine ?? undefined}
                        data-as-of={row.asOf ?? undefined}
                        className={cn(
                          "inline-flex items-center rounded-full border bg-transparent px-1.5 py-0.5 text-[10px] leading-none",
                          SOURCE_PILL_CLASS[row.source],
                        )}
                      >
                        {sourceLabel}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p
                data-slot="health-score-card-provenance-footnote"
                className="text-muted-foreground text-[10px] leading-snug"
              >
                {t("insights.healthScore.provenance.footnote")}
              </p>
            </section>
          )}
        </div>

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
