/**
 * The health score as the dashboard snapshot carries it: the slim pillar
 * rows and the Rest Mode annotation that frames the number.
 */
import type {
  HealthScoreReport,
  RestModeAnnotation,
  ScoreBand,
  ScorePillarId,
  ScorePillarResult,
  ScorePillarWeight,
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
import { keptHealthScoreReport } from "@/lib/analytics/score/report-cell";
import { getEvent } from "@/lib/logging/context";
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
  /** The pillar's own band, as the scorer resolved it; null when it did not count. */
  band: ScoreBand | null;
  /** Why it did not count, worded; null when it counted. */
  reason: string | null;
  /** The machine reason behind `reason`; null when it counted. */
  reasonCode: string | null;
  /**
   * The pillar's share of the number, from the composite's own `weights`;
   * null when it did not count.
   */
  weight: number | null;
}

/**
 * The slim pillar rows from a score report, worded in `locale` the way the
 * Insights panel words them, each with the weight the composite gave it
 * (`weights` is the composite's own list; nothing is re-derived here). Pure.
 */
export function snapshotScorePillars(
  pillars: readonly ScorePillarResult[],
  weights: readonly ScorePillarWeight[] | undefined,
  locale: Locale,
): DashboardSnapshotScorePillar[] {
  const { t } = getServerTranslator(locale);
  const weightOf = new Map((weights ?? []).map((w) => [w.id, w.weight]));
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
      band:
        pillar.result.status === "ok"
          ? (pillar.result.value.band ?? null)
          : null,
      reason: ok ? null : t(scorePillarReasonKey(reasonCode ?? "")),
      reasonCode: ok ? null : (reasonCode ?? "unavailable"),
      weight: weightOf.get(pillar.id) ?? null,
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
    pillars: snapshotScorePillars(report.pillars, composite.weights, locale),
  };
}

/**
 * The health score while the second phase is held back.
 *
 * The rollup tier does not yet cover a dense type the phase reads (or the
 * account has no measurements at all and its score rests on labs and
 * questionnaires). The rest of the phase waits; the score does not, because
 * `/api/analytics` answers it either way and the start page, the digest and
 * the morning must not answer "not enough data" beside it. A report computed
 * for the same day that no write has made stale since is served
 * (`report-cell.ts`); otherwise `compute` reads it live by the same function
 * analytics uses. Readings without buckets also ask for the fold that ends
 * the wait (`requestRollupHistoryFold`): a history that arrived without the
 * write hooks is otherwise only folded at the next boot. Miss path only; a
 * covered account never reaches it. Fail-soft like the rest of the snapshot:
 * a failed read leaves the score empty and says so on the wide event.
 */
export async function coldPhaseHealthScore(
  userId: string,
  userTz: string,
  coverage: RollupCoverageMap,
  now: Date,
  locale: Locale,
  compute: () => Promise<HealthScoreReport>,
): Promise<DashboardSnapshotHealthScore | null> {
  if (coverage.size > 0) {
    trackBackgroundTask(
      runDetached(() => requestRollupHistoryFold(userId)).catch(
        () => undefined,
      ),
    );
  }
  try {
    const report =
      keptHealthScoreReport(userId, userTz, now) ?? (await compute());
    return await snapshotHealthScore(report, userId, now, locale);
  } catch (err) {
    getEvent()?.addWarning(
      `held-back health score read failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
