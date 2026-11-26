/**
 * The health score as the dashboard snapshot carries it: the slim pillar
 * rows and the Rest Mode annotation that frames the number.
 */
import type {
  HealthScoreReport,
  RestModeAnnotation,
  ScorePillarId,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { clampScore } from "@/lib/analytics/score/shared";
import {
  healthScoreSetter,
  SCORE_PILLAR_LABEL_KEYS,
  scorePillarReasonKey,
  type HealthScoreSetter,
} from "@/lib/score-config/labels";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { lastHealthScoreReport } from "@/lib/analytics/score/report-cell";
import { requestRollupHistoryFold } from "@/lib/rollups/full-backfill";
import type { RollupCoverageMap } from "@/lib/rollups/measurement-coverage";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import type { DashboardSnapshotHealthScore } from "@/lib/dashboard/snapshot";

/** One pillar of the health score as the snapshot carries it. */
export interface DashboardSnapshotScorePillar {
  id: ScorePillarId;
  /** The pillar's name in the response language. */
  label: string;
  /** The pillar's own 0..100 score (rounded) when it counted, else null. */
  value: number | null;
  /** Why it did not count, worded; null when it counted. */
  reason: string | null;
  /** The machine reason behind `reason`; null when it counted. */
  reasonCode: string | null;
}

/**
 * The slim pillar rows from a score report, worded in `locale` the way the
 * Insights panel words them. Pure.
 */
export function snapshotScorePillars(
  pillars: readonly ScorePillarResult[],
  locale: Locale,
): DashboardSnapshotScorePillar[] {
  const { t } = getServerTranslator(locale);
  return pillars.map((pillar) => {
    const ok = pillar.result.status === "ok";
    const reasonCode =
      pillar.result.status === "insufficient" ? pillar.result.reason : null;
    return {
      id: pillar.id,
      label: t(SCORE_PILLAR_LABEL_KEYS[pillar.id]),
      value:
        pillar.result.status === "ok"
          ? clampScore(pillar.result.value.score)
          : null,
      reason: ok ? null : t(scorePillarReasonKey(reasonCode ?? "")),
      reasonCode: ok ? null : (reasonCode ?? "unavailable"),
    };
  });
}

/**
 * The pillar in a worse band than the score, worded in `locale`, or null.
 * Pure. Carried beside the score so a surface that shows the number shows
 * this too, and a sentence about the day reads the worse of the two bands.
 */
export function snapshotScoreSetter(
  report: Pick<HealthScoreReport, "composite" | "pillars">,
  locale: Locale,
): HealthScoreSetter | null {
  return healthScoreSetter(report, getServerTranslator(locale).t);
}

/**
 * The value-free Rest Mode annotation beside the score, so the
 * dashboard hero can frame (never penalise) the number, matching the
 * `/api/analytics` payload and iOS. Fail-soft inside `resolveRestMode`.
 */
export async function restModeAnnotation(
  userId: string,
  now: Date,
): Promise<RestModeAnnotation | null> {
  const ctx = await resolveRestMode(userId, now);
  return ctx.active
    ? { active: true, since: ctx.since, episodeCount: ctx.episodeCount }
    : null;
}

/**
 * The health score as the snapshot carries it, from a computed report; null
 * when the composite did not resolve. Rest Mode frames (never penalises) the
 * number, so it is read only when a score rendered, and taken from the report
 * when the analytics read already attached it.
 */
export async function snapshotHealthScore(
  report: HealthScoreReport,
  userId: string,
  now: Date,
  locale: Locale,
): Promise<DashboardSnapshotHealthScore | null> {
  if (report.composite.status !== "ok") return null;
  const composite = report.composite.value;
  const restMode =
    report.restMode !== undefined
      ? report.restMode
      : await restModeAnnotation(userId, now);
  const setter = snapshotScoreSetter(report, locale);
  return {
    score: composite.score,
    band: composite.band,
    numberBand: composite.numberBand,
    delta: report.delta,
    confidence: report.composite.confidence,
    composition: composite.composition,
    configured: composite.configured,
    scoreBasis: composite.scoreBasis,
    deltaReason: report.deltaReason,
    scoreVersion: report.scoreVersion,
    bandSetter: composite.bandSetter,
    bandSetterBand: setter?.band ?? null,
    bandSetterLine: setter?.line ?? null,
    restMode,
    pillars: snapshotScorePillars(report.pillars, locale),
  };
}

/**
 * The health score while the second phase is held back. The rollup tier does
 * not yet cover a dense type the phase reads, so the builder does not compute
 * the score itself (that would drop it into the live fallback the gate exists
 * to avoid). It serves the score another surface computed for the same day
 * (`report-cell.ts`) instead of nothing: `/api/analytics` computes without the
 * gate, and a start page that said "not enough data" beside an Insights page
 * showing a number was two answers for one day. It also asks for the fold
 * that ends the wait (`requestRollupHistoryFold`), since a history that
 * arrived without the write hooks is otherwise only folded at the next boot.
 * The score narrative stays off here: it reads the windows the gate holds back.
 */
export async function coldPhaseHealthScore(
  userId: string,
  userTz: string,
  coverage: RollupCoverageMap,
  now: Date,
  locale: Locale,
): Promise<DashboardSnapshotHealthScore | null> {
  if (coverage.size === 0) return null;
  trackBackgroundTask(
    runDetached(() => requestRollupHistoryFold(userId)).catch(() => undefined),
  );
  const report = lastHealthScoreReport(userId, userTz, now);
  return report ? snapshotHealthScore(report, userId, now, locale) : null;
}
