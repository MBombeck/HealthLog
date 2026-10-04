"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InfoPopover } from "@/components/ui/info-popover";
import { LearningGate } from "@/components/ui/learning-gate";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BAND_BORDER_CLASS,
  BAND_NUMBER_CLASS,
  BAND_PROGRESS_CLASS,
  bandForScore,
  clampScore,
} from "@/components/insights/derived/band-tokens";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import { ProvenanceExplainer } from "@/components/insights/derived/provenance-explainer";
import { HEALTH_SCORE_PROVENANCE } from "@/components/insights/derived/health-score-provenance";
import {
  pillarDetailLines,
  pillarObservedText,
  type PillarDetailContext,
} from "@/components/insights/health-score-pillar-detail";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/date-format";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { resolveGlucoseUnit } from "@/lib/glucose";
import type {
  HealthScoreReport,
  ScoreBand,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { SCORE_PILLAR_LABEL_KEYS } from "@/lib/score-config/labels";
import { cn } from "@/lib/utils";

/**
 * The Health Score panel: the hero band's right-hand column.
 *
 * The score belongs beside the greeting, not under it. It sat there for
 * eleven weeks — big number at the top of a narrow column, thin contributor
 * rows directly beneath it inside the same card — and three arrangements in
 * four days moved it away, ending in a full-width card pinned below the
 * greeting that spent most of its height on things that do not count toward
 * the number. This is the original arrangement, restored, with the eight
 * pillars the composite now carries instead of the four it had then.
 *
 * The rules the intervening work established are all kept:
 *
 *   - One mount. This panel is the only score surface on the overview.
 *   - It renders whether or not the daily briefing is switched on.
 *   - It is not a customisable section, so a saved layout cannot hide it.
 *   - The column reserves its own height while the payload is in flight,
 *     so the band does not reflow when the score lands.
 *
 * Only a pillar that carries a score gets a row. A pillar that contributes
 * nothing is one quiet line: a failed read is named with a retry, safety
 * signposting is named in full, and everything else that is simply not
 * recorded yet is counted, with the names and reasons one tap away in the
 * foot disclosure. Each pillar has exactly one home — a row, the failed-read
 * line, the safety line, or the count — and never two.
 *
 * Each contributor row is tinted by ITS OWN band. The old rows took the
 * composite's colour, which painted a pillar scoring 92 red on a red day.
 */

/**
 * v1.35.0 — the map moved to `@/lib/score-config/labels` so the settings
 * surface that decides what counts and this panel name the same pillar the
 * same way. Aliased here because every reference below reads this name.
 */
const PILLAR_LABEL_KEY = SCORE_PILLAR_LABEL_KEYS;

const REASON_KEY: Record<string, string> = {
  read_failed: "readFailed",
  not_tracked: "notTracked",
  missing_reference_profile: "missingProfile",
  missing_height: "missingHeight",
  incomplete_or_stale_panel: "incompletePanel",
  crisis_signposting: "crisis",
  below_day_floor_or_stale: "insufficientHistory",
  below_reading_floor: "insufficientHistory",
  stale_or_untracked: "insufficientHistory",
  unverified_or_stale: "insufficientHistory",
  below_reading_floor_or_stale: "insufficientHistory",
  below_night_floor_or_stale: "insufficientHistory",
  stale: "insufficientHistory",
};

/**
 * The column geometry, shared by the panel and by its loading reserve so the
 * two can never drift apart. `basis` rather than a width so the column flexes
 * inside the hero band's `md:flex-row` split (~36 % at md, ~40 % at xl), and
 * `w-full` below `md` where the column stacks under the greeting.
 */
const PANEL_COLUMN_CLASS =
  "w-full md:shrink-0 md:grow-0 md:basis-[22rem] xl:basis-[26rem]";

/** The card chrome the panel wears inside the gradient band. */
const PANEL_CHROME_CLASS =
  "bg-card/65 rounded-xl border p-4 shadow-sm backdrop-blur-sm md:p-6";

/**
 * Height the reserve holds while the payload is in flight, so the band does
 * not jump when the score lands.
 *
 * The rule, not a remembered number: the reserve sits between the shortest
 * and the tallest panel the report actually produces (three to six scored
 * rows), so a short report is not pushed down and a long one does not leave a
 * gap that collapses. It is deliberately near the middle of that range, which
 * is the best a single number can do when the panel's height depends on how
 * many pillars an account scores.
 *
 * `health-score-card-geometry.test.tsx` measures all of it in a browser
 * against the compiled stylesheet and fails if this value leaves that range —
 * and also if the value stops binding at all. It did stop: the blocks below
 * added up to more than the minimum declared here, so the reserve was
 * whatever the blocks happened to be and this constant was decoration. The
 * blocks were trimmed to sit under it again.
 */
const PANEL_RESERVE_CLASS = "min-h-[28rem]";

/**
 * v1.21.2 (A5) — readiness contributor keys the Tension Verdict surfaces.
 * Kept as a local string union so the client never imports the server
 * derived-engine types. Localised through the existing
 * `insights.derived.composite.READINESS.component.{key}` labels.
 */
export type ReadinessContributorKey =
  "rhr" | "hrv" | "sleep" | "respiratory" | "mood";

/**
 * v1.21.2 (A5) — readiness contributor key → existing localised label key.
 * Reuses the score-anatomy contributor labels so the Tension Verdict reads the
 * same names the wellness ring's anatomy view renders — no new keys.
 */
const TENSION_CONTRIBUTOR_LABEL_KEY: Record<ReadinessContributorKey, string> = {
  rhr: "insights.derived.composite.READINESS.component.rhr",
  hrv: "insights.derived.composite.READINESS.component.hrv",
  sleep: "insights.derived.composite.READINESS.component.sleep",
  respiratory: "insights.derived.composite.READINESS.component.respiratory",
  mood: "insights.derived.composite.READINESS.component.mood",
};

/**
 * v1.21.2 (A6) — `MeasurementType` → existing localised metric-name key
 * (`measurements.type*`). Only the salient deviation vitals the
 * return-to-baseline detector scans need an entry; an unmapped type falls back
 * to a prettified raw form so a new type never blanks.
 */
const RETURN_METRIC_LABEL_KEY: Record<string, string> = {
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESPIRATORY_RATE: "measurements.typeRespiratoryRate",
  WEIGHT: "measurements.typeWeight",
};

export function markAlgorithmNoticeDismissed(
  payload: unknown,
  itemKey: string,
): unknown {
  return markNoticeDismissed(payload, "algorithmNotice", itemKey);
}

/**
 * The same patch for the composition note.
 *
 * Its own entry point rather than a loop over both fields: dismissing one
 * notice must never flip the other, and the two keys live in different
 * namespaces precisely so they cannot be confused. A shared walker that
 * matched "whichever notice carries this key" would work today and would
 * quietly do the wrong thing the day the two namespaces collide.
 */
export function markCompositionNoticeDismissed(
  payload: unknown,
  itemKey: string,
): unknown {
  return markNoticeDismissed(payload, "compositionNotice", itemKey);
}

function markNoticeDismissed(
  payload: unknown,
  field: "algorithmNotice" | "compositionNotice",
  itemKey: string,
): unknown {
  if (!payload || typeof payload !== "object" || !("healthScore" in payload)) {
    return payload;
  }
  const healthScore = payload.healthScore;
  if (
    !healthScore ||
    typeof healthScore !== "object" ||
    !(field in healthScore)
  ) {
    return payload;
  }
  const notice = (healthScore as Record<string, unknown>)[field];
  if (
    !notice ||
    typeof notice !== "object" ||
    !("itemKey" in notice) ||
    notice.itemKey !== itemKey
  ) {
    return payload;
  }
  return {
    ...payload,
    healthScore: {
      ...healthScore,
      [field]: { ...notice, dismissed: true },
    },
  };
}

/** The reason a pillar was gated, or null when it carries a score. */
function gateReason(pillar: ScorePillarResult): string | null {
  return pillar.result.status === "insufficient" ? pillar.result.reason : null;
}

/**
 * Why a pillar that used to count no longer does.
 *
 * The report's own row for that pillar is the source, so the departure line
 * and the anatomy list can never say two different things about one pillar.
 * A pillar with NO row is not an error: turning its module off closes the
 * data path deliberately and the scorer stops emitting the pillar
 * altogether. The empty string falls through `REASON_KEY` to the generic
 * "not currently eligible", which is exactly what is true of it.
 */
function reasonOf(report: HealthScoreReport, id: string): string {
  const pillar = report.pillars.find((entry) => entry.id === id);
  return (pillar ? gateReason(pillar) : null) ?? "";
}

export interface HealthScoreCardProps {
  report: HealthScoreReport;
  /**
   * v1.21.2 (A5) — Tension Verdict, server-resolved + locale-agnostic. `band`
   * is the readiness composite's band; `positive` / `negative` carry the
   * readiness contributor KEYS. Null on a coherent day (or under a clinical
   * red-flag suppress).
   */
  tension?: {
    band: ScoreBand;
    positive: ReadinessContributorKey[];
    negative: ReadinessContributorKey[];
  } | null;
  /**
   * v1.21.2 (A6) — return-to-baseline, server-resolved + locale-agnostic.
   * `metricType` is a `MeasurementType` this card maps to its localised metric
   * name. Null when no salient metric returned from a genuine prior
   * out-of-band run.
   */
  returnToBand?: { metricType: string; daysInside: number } | null;
  /** Retry for a pillar whose read failed — wired to the analytics refetch. */
  onRetry?: () => void;
  className?: string;
}

export function HealthScoreCard({
  report,
  tension = null,
  returnToBand = null,
  onRetry,
  className,
}: HealthScoreCardProps) {
  const { t, locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const regionId = useId();

  const detail: PillarDetailContext = {
    t,
    glucoseUnit: resolveGlucoseUnit(user?.glucoseUnit),
  };

  function reasonText(reason: string): string {
    const key = REASON_KEY[reason] ?? "unavailable";
    return t(`insights.healthScore.reason.${key}`);
  }

  function labelsOf(pillars: ScorePillarResult[]): string {
    return pillars.map((p) => t(PILLAR_LABEL_KEY[p.id])).join(", ");
  }

  const composite = report.composite;
  // Four homes, one pillar each. A pillar that scores gets a row; a pillar
  // whose read failed joins the one coalesced failure line; a pillar gated
  // for safety signposting is named in full at rest; everything else gated
  // is counted, and named a tap away. The sets are disjoint by construction
  // and each pillar falls into exactly one of them.
  const scored = report.pillars.filter((p) => p.result.status === "ok");
  const readFailed = report.pillars.filter(
    (p) => gateReason(p) === "read_failed",
  );
  const crisis = report.pillars.filter(
    (p) => gateReason(p) === "crisis_signposting",
  );
  // A failed read is not absence, so it never joins the "not scored yet" list;
  // it gets its own line above. Safety copy is content, so it is named at rest
  // rather than counted — which is also why it is not in this list twice.
  const notScored = report.pillars.filter((p) => {
    const reason = gateReason(p);
    return (
      reason !== null &&
      reason !== "read_failed" &&
      reason !== "crisis_signposting"
    );
  });

  // Only forwarded when a real disagreement is present on BOTH sides; the
  // server resolver already enforces that, but the guard keeps the card from
  // rendering a one-sided line.
  const tensionLine =
    tension && tension.positive.length > 0 && tension.negative.length > 0
      ? t("insights.healthScore.tension", {
          positive: tension.positive
            .map((k) => t(TENSION_CONTRIBUTOR_LABEL_KEY[k]))
            .join(", "),
          negative: tension.negative
            .map((k) => t(TENSION_CONTRIBUTOR_LABEL_KEY[k]))
            .join(", "),
        })
      : null;

  const returnToBandLine = returnToBand
    ? t("insights.healthScore.returnToBand", {
        metric: RETURN_METRIC_LABEL_KEY[returnToBand.metricType]
          ? t(RETURN_METRIC_LABEL_KEY[returnToBand.metricType])
          : returnToBand.metricType.replace(/_/g, " ").toLowerCase(),
        days: returnToBand.daysInside,
      })
    : null;

  const compositeScore =
    composite.status === "ok" ? clampScore(composite.value.score) : null;
  const compositeBand = composite.status === "ok" ? composite.value.band : null;

  // v1.38 — what the number rests on, resolved on the server. A set that
  // spans the recommended breadth says nothing extra: three of three is
  // the shape the meter's axis already states, and a four-domain account
  // would read "4 of 3". Below the recommendation the line is the only
  // thing on the panel that tells a narrow score from a broad one, so it
  // is stated in the same weight as the band sentence it follows —
  // scope, not caveat. The number keeps its size and its band colour at
  // every tier; the coverage meter and the confidence band below carry
  // the quantitative caveat they were built for.
  const basis =
    composite.status === "ok" ? (composite.value.scoreBasis ?? null) : null;
  const basisLine =
    basis && basis.tier !== "full"
      ? t("insights.healthScore.basis", {
          count: basis.domains,
          recommended: basis.recommended,
        })
      : null;

  // v1.38 — why the number moved when nobody moved it. A pillar whose
  // window rolled past its floor, whose module went off or whose source
  // went quiet changes the set the mean is taken over; the delta is
  // already suppressed so the move is not narrated as a health event, and
  // until now that was the whole answer — the level changed and the panel
  // said nothing.
  //
  // One muted line, and the reason comes from the pillar's own row rather
  // than from a second vocabulary: whatever the anatomy list would say
  // about that pillar today is what this says. A pillar with no row at all
  // (its module is off, so it is not waiting for anything) falls through
  // to the same "not currently eligible" the list uses.
  //
  // Not a push, not a toast, not a badge. The person is looking at the
  // number this explains.
  const compositionNotice = report.compositionNotice ?? null;
  const compositionLine =
    compositionNotice && !compositionNotice.dismissed
      ? [
          compositionNotice.left.length > 0
            ? t("insights.healthScore.compositionNotice.left", {
                pillars: compositionNotice.left
                  .map((id) =>
                    t("insights.healthScore.compositionNotice.item", {
                      pillar: t(PILLAR_LABEL_KEY[id]),
                      reason: reasonText(reasonOf(report, id)),
                    }),
                  )
                  .join(", "),
              })
            : null,
          compositionNotice.joined.length > 0
            ? t("insights.healthScore.compositionNotice.joined", {
                pillars: compositionNotice.joined
                  .map((id) => t(PILLAR_LABEL_KEY[id]))
                  .join(", "),
              })
            : null,
        ]
          .filter((line): line is string => line !== null)
          .join(" ") || null
      : null;

  return (
    <div
      data-slot="health-score-card"
      data-status={composite.status}
      data-band={compositeBand ?? "none"}
      className={cn(
        "animate-insight-in",
        PANEL_CHROME_CLASS,
        compositeBand ? BAND_BORDER_CLASS[compositeBand] : null,
        PANEL_COLUMN_CLASS,
        // `h-full` lets the hero band's `items-stretch` equalise the column
        // against the greeting; `mt-auto` on the foot collects the slack.
        "flex h-full flex-col gap-3",
        className,
      )}
    >
      {/* 1 — the label, and the weekly gain when there is one. */}
      <div className="flex items-center justify-between gap-2">
        <p
          data-slot="health-score-card-label"
          className="text-muted-foreground text-xs font-semibold tracking-[0.18em] uppercase"
        >
          {t("insights.healthScore.label")}
        </p>
        {report.delta != null && report.delta > 0 ? (
          <span
            data-slot="health-score-card-delta-chip"
            className="bg-success/15 text-success shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
          >
            +{report.delta}
          </span>
        ) : null}
      </div>

      {/* 2 — the number. The reason the panel exists. */}
      <div className="flex items-baseline gap-1">
        <span
          data-slot="health-score-card-number"
          className={cn(
            "text-5xl leading-none font-semibold tabular-nums sm:text-6xl",
            compositeBand
              ? BAND_NUMBER_CLASS[compositeBand]
              : "text-muted-foreground",
          )}
        >
          {compositeScore == null ? "—" : Math.round(compositeScore)}
        </span>
        {compositeScore == null ? null : (
          <span
            aria-hidden="true"
            className="text-muted-foreground text-sm tabular-nums"
          >
            / 100
          </span>
        )}
      </div>

      {/* 3 — the composite bar. */}
      {compositeScore != null && compositeBand ? (
        <div
          data-slot="health-score-card-progress"
          role="progressbar"
          aria-label={t("insights.healthScore.label")}
          aria-valuenow={Math.round(compositeScore)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="bg-muted/50 h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className={cn("h-full", BAND_PROGRESS_CLASS[compositeBand])}
            style={{ width: `${compositeScore}%` }}
          />
        </div>
      ) : null}

      {/* 4 — the lines that qualify the number, one each, only when true. */}
      <div className="space-y-1">
        {compositeBand ? (
          <p data-slot="health-score-band" className="text-foreground text-xs">
            {t(`insights.healthScore.band.${compositeBand}`)}
          </p>
        ) : (
          // The gate survives for the one case that is still a refusal:
          // not a single pillar has usable data. It no longer counts
          // areas, because the count is always nothing and the meter in
          // the foot renders the same fraction honestly a few lines
          // below.
          <LearningGate
            compact
            bodySlot="health-score-insufficient"
            message={t("insights.healthScore.insufficient")}
          />
        )}
        {basisLine ? (
          <p data-slot="health-score-basis" className="text-foreground text-xs">
            {basisLine}
          </p>
        ) : null}
        {compositionLine ? (
          <p
            data-slot="health-score-composition-notice"
            className="text-muted-foreground text-xs"
          >
            {compositionLine}
          </p>
        ) : null}
        {report.delta != null ? (
          <p
            data-slot="health-score-delta"
            className="text-muted-foreground text-xs tabular-nums"
          >
            {t("insights.healthScore.delta", {
              delta: report.delta > 0 ? `+${report.delta}` : report.delta,
            })}
          </p>
        ) : report.deltaReason ? (
          <p
            data-slot="health-score-delta-reason"
            className="text-muted-foreground text-xs"
          >
            {t(`insights.healthScore.deltaReason.${report.deltaReason}`)}
          </p>
        ) : null}
        {report.restMode?.active ? (
          <p
            data-slot="health-score-rest-mode"
            className="text-muted-foreground text-xs"
          >
            {t("insights.healthScore.restMode", {
              since: report.restMode.since
                ? formatDate(
                    userDayKey(
                      new Date(report.restMode.since),
                      user?.timezone || DEFAULT_TIMEZONE,
                    ),
                    dateFormat,
                    locale,
                  )
                : t("insights.healthScore.none"),
            })}
          </p>
        ) : null}
        {tensionLine ? (
          <p
            data-slot="health-score-tension"
            className="text-muted-foreground text-xs"
          >
            {tensionLine}
          </p>
        ) : null}
        {returnToBandLine ? (
          <p
            data-slot="health-score-return-to-band"
            className="text-muted-foreground text-xs"
          >
            {returnToBandLine}
          </p>
        ) : null}
      </div>

      {/* 5 — the contributing factors, always visible, directly under the
          number. Server registry order; no re-ranking. */}
      {scored.length > 0 ? (
        <ul
          data-slot="health-score-pillars"
          className="border-border/60 space-y-2 border-t pt-3"
        >
          {scored.map((pillar) => (
            <PillarRow key={pillar.id} pillar={pillar} detail={detail} />
          ))}
        </ul>
      ) : null}

      {/* 6 — what is not contributing. One weight class, two faces: the
          failure carries the glyph and the only retry on the surface, the
          absence is muted and actionless. */}
      {readFailed.length > 0 || crisis.length > 0 || notScored.length > 0 ? (
        <div className="space-y-1.5">
          {readFailed.length > 0 ? (
            <div
              data-slot="health-score-pillar-error"
              data-pillars={readFailed.map((p) => p.id).join(",")}
              role="alert"
              className="text-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
            >
              <AlertTriangle
                aria-hidden="true"
                className="text-muted-foreground size-3.5 shrink-0"
              />
              <span className="min-w-0">
                {labelsOf(readFailed)}
                {": "}
                {reasonText("read_failed")}
              </span>
              {onRetry ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onRetry}
                  data-slot="health-score-pillar-retry"
                  className="h-7 gap-1.5 px-2 text-xs"
                >
                  <RotateCw className="size-3.5" aria-hidden="true" />
                  <span>{t("common.retry")}</span>
                </Button>
              ) : null}
            </div>
          ) : null}

          {crisis.length > 0 ? (
            <p
              data-slot="health-score-crisis"
              data-pillars={crisis.map((p) => p.id).join(",")}
              className="text-foreground text-xs"
            >
              {labelsOf(crisis)}
              {": "}
              {reasonText("crisis_signposting")}
            </p>
          ) : null}

          {notScored.length > 0 ? (
            <p
              data-slot="health-score-not-scored-count"
              data-count={notScored.length}
              className="text-muted-foreground text-xs"
            >
              {t("insights.healthScore.notScored", {
                count: notScored.length,
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 7 — the foot. `mt-auto` collects the slack here rather than under the
          number, so a short report and a long one both end on the same line. */}
      <div className="mt-auto space-y-3 pt-1">
        {/* The composite's meter names its own axis. Its fraction counts
            distinct DOMAINS against the three the score recommends. Until
            v1.38 those three were a floor every scored account had
            cleared by definition, so the default "3/3" read as full
            coverage of the person's data for everyone who had a score at
            all, and the axis stated the floor instead.

            The floor is gone, so the branch cannot be "does a score
            exist" any more: a two-domain account has a score AND a real
            fraction, and telling it that it covers the three areas the
            score recommends would be the old lie in a new place. The
            branch is the TIER — the recommendation is stated only where
            it is actually met, and everywhere else the moving number is
            shown as one. The dots and percentage are untouched either
            way: they track history depth, which does vary.

            A composite carrying no basis block at all — an older cached
            payload — takes the fraction arm, which states what it can
            count rather than a recommendation it cannot check. */}
        <CoverageMeter
          coverage={composite.coverage}
          confidence={
            composite.status === "ok" ? composite.confidence : undefined
          }
          size="sm"
          axisLabel={
            basis?.tier === "full"
              ? t("insights.healthScore.coverage.recommendedMet")
              : t("insights.healthScore.coverage.areas", {
                  present: composite.coverage.presentInputs,
                  required: composite.coverage.requiredInputs,
                })
          }
        />

        {/* Progressive disclosure. No Collapsible primitive exists in the UI
            kit, so this is the same accessible button + region shape the
            glucose panel ships: `aria-expanded` on the trigger,
            `aria-controls` + `hidden` on the region. */}
        <div className="border-border/60 border-t pt-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={regionId}
            data-slot="health-score-anatomy-toggle"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-2 rounded-sm text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="min-w-0">
              {t("insights.healthScore.anatomyToggle")}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>

          <div
            id={regionId}
            hidden={!open}
            data-slot="health-score-anatomy-region"
            className="space-y-3 pt-1 pb-1"
          >
            {notScored.length > 0 ? (
              <ul data-slot="health-score-not-scored" className="space-y-1">
                {notScored.map((pillar) => {
                  const reason = gateReason(pillar) ?? "";
                  return (
                    <li
                      key={pillar.id}
                      data-pillar={pillar.id}
                      data-reason={reason}
                      className="text-muted-foreground text-xs"
                    >
                      <span className="text-foreground font-medium">
                        {t(PILLAR_LABEL_KEY[pillar.id])}
                      </span>
                      {": "}
                      {reasonText(reason)}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <WeightGoalRow report={report} />

            <div data-slot="health-score-method" className="space-y-1">
              {composite.status === "ok" ? (
                <>
                  <p className="text-muted-foreground text-xs">
                    {t("insights.healthScore.bandSetter", {
                      pillar: composite.value.bandSetter
                        ? t(PILLAR_LABEL_KEY[composite.value.bandSetter])
                        : t("insights.healthScore.none"),
                    })}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("insights.healthScore.versionAndNoise", {
                      version: report.scoreVersion,
                      noise: composite.value.noiseFloor,
                    })}
                  </p>
                  {/*
                   * The server resolved whether this composition is the
                   * person's own; the footer states it and nothing more.
                   * Which pillars they took out is the settings surface's
                   * to show, not this one's, and re-deriving the answer
                   * from a configuration blob here would put a second
                   * decider behind one sentence.
                   */}
                  {composite.value.configured ? (
                    <p
                      data-slot="health-score-configured"
                      className="text-muted-foreground text-xs"
                    >
                      {t("insights.healthScore.configured")}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {t("insights.healthScore.methodVersion", {
                    version: report.scoreVersion,
                  })}
                </p>
              )}
              <ProvenanceExplainer
                provenance={composite.provenance}
                method={t(HEALTH_SCORE_PROVENANCE.methodKey)}
                standard={HEALTH_SCORE_PROVENANCE.standard}
                className="block"
              />
              {/* v1.35.0 — the one way into the surface that decides what
                  counts. It sits at the foot of the disclosure that already
                  explains how the score comes about, which keeps the
                  configuration owned by the score rather than by the modules
                  screen, and leaves the panel itself otherwise untouched. */}
              <Link
                href="/settings/score"
                data-slot="health-score-configure-link"
                className="text-foreground/80 hover:text-foreground inline-block text-xs underline underline-offset-2"
              >
                {t("insights.healthScore.configureLink")}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One scored pillar, one line: a truncating name, a thin fill bar, the score,
 * and the (i) that opens everything else. The bar takes the pillar's OWN band
 * colour — a pillar at 92 reads green even when the composite is red, which
 * is the point of showing the contributors at all.
 *
 * The observed value, the reference band, the personal target, the source and
 * the per-pillar confidence all live in the popover. That is one tap more
 * than the pinned card charged for the observed line, and it is what buys the
 * column back.
 */
function PillarRow({
  pillar,
  detail,
}: {
  pillar: ScorePillarResult;
  detail: PillarDetailContext;
}) {
  const { t } = useTranslations();
  if (pillar.result.status !== "ok") return null;
  const score = clampScore(pillar.result.value.score);
  const band = bandForScore(score);
  const observed = pillarObservedText(pillar, detail);
  const lines = pillarDetailLines(pillar, detail);

  return (
    <li
      data-pillar={pillar.id}
      data-status="ok"
      className="grid grid-cols-[minmax(0,7rem)_1fr_2rem_auto] items-center gap-2 text-xs"
    >
      {/* The label truncates; the row never grows. `minmax(0,…)` plus
          `min-w-0 truncate` is what makes that structural rather than a
          promise — drop either and the track grows to the longest word and
          pushes the row. Widening the column does not rescue the long names:
          the longest label in five of the six locales overruns any column
          this panel can afford, so the extra width would come off the fill
          bar and buy a few more characters of one language. */}
      <span className="text-muted-foreground min-w-0 truncate">
        {t(PILLAR_LABEL_KEY[pillar.id])}
      </span>
      <div
        className="bg-muted/50 h-1.5 min-w-0 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          data-slot="health-score-pillar-bar"
          className={cn("h-full rounded-full", BAND_PROGRESS_CLASS[band])}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-foreground text-right tabular-nums">
        {Math.round(score)}
      </span>
      <InfoPopover
        content={
          <>
            {observed ? (
              <span className="block">
                {t("insights.healthScore.observed", { value: observed })}
              </span>
            ) : null}
            {lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            <span className="mt-1.5 block">
              <CoverageMeter
                coverage={pillar.result.coverage}
                confidence={pillar.result.confidence}
                size="sm"
              />
            </span>
          </>
        }
        bodyDataSlot="health-score-pillar-detail"
      />
    </li>
  );
}

/**
 * The personal weight goal: an inner tile inside the disclosure, deliberately
 * NOT a contributor row, because it is context the user set for themselves and
 * it never moves the score. That is also why it left the at-rest column.
 */
function WeightGoalRow({ report }: { report: HealthScoreReport }) {
  const { t } = useTranslations();
  const goal = report.weightGoal;
  const units = useUnitDisplay();
  const unit = units.unitFor("WEIGHT");
  return (
    <div
      data-slot="health-score-weight-goal"
      data-status={goal.status}
      className="border-border/70 rounded-lg border p-3"
    >
      <p className="text-foreground text-sm font-medium">
        {t("insights.healthScore.weightGoal.title")}
      </p>
      {goal.status === "ok" ? (
        <>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("insights.healthScore.weightGoal.value", {
              current: units.toDisplay("WEIGHT", goal.value.currentKg),
              min: units.toDisplay("WEIGHT", goal.value.target.min),
              max: units.toDisplay("WEIGHT", goal.value.target.max),
              distance: units.toDisplayDelta("WEIGHT", goal.value.distanceKg),
              unit,
            })}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {goal.value.deltaKg == null
              ? t("insights.healthScore.weightGoal.noDelta")
              : t("insights.healthScore.weightGoal.delta", {
                  delta: units.toDisplayDelta("WEIGHT", goal.value.deltaKg),
                  unit,
                })}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("insights.healthScore.source", {
              source: goal.value.source,
              date: goal.value.asOf,
            })}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">
          {t(`insights.healthScore.weightGoal.${goal.reason}`)}
        </p>
      )}
      <CoverageMeter
        coverage={goal.coverage}
        confidence={goal.status === "ok" ? goal.confidence : undefined}
        size="sm"
        className="mt-3"
      />
      <p className="text-muted-foreground mt-2 text-xs">
        {t("insights.healthScore.weightGoal.notScored")}
      </p>
    </div>
  );
}

/**
 * The hero column's reserve while the analytics payload is in flight. Wears
 * the panel's own column classes and chrome and holds a measured minimum
 * height, so the greeting beside it does not reflow when the score lands —
 * the reason this reserve was added in the first place.
 */
export function HealthScoreCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      data-slot="health-score-card-skeleton"
      aria-hidden="true"
      className={cn(
        PANEL_CHROME_CLASS,
        "border-border/60",
        PANEL_COLUMN_CLASS,
        "flex h-full flex-col gap-3",
        PANEL_RESERVE_CLASS,
        className,
      )}
    >
      {/* Block for block, the panel above: label, number, bar, two qualifier
          lines, three contributor rows, one not-contributing line, and the
          foot with its meter and toggle. Three rows rather than five is what
          keeps these blocks under the minimum above, so the minimum is the
          thing that decides the height. */}
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-14 w-28" />
      <Skeleton className="h-2 w-full rounded-full" />
      <div className="space-y-1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="border-border/60 space-y-2 border-t pt-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
      </div>
      <Skeleton className="h-4 w-36" />
      <div className="mt-auto space-y-3 pt-1">
        <Skeleton className="h-11 w-28 rounded-sm" />
        <div className="border-border/60 border-t pt-1">
          <Skeleton className="h-11 w-full rounded-sm" />
        </div>
      </div>
    </div>
  );
}
