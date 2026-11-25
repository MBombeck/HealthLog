/**
 * The health score as the dashboard snapshot carries it: the slim pillar
 * rows (1.50) and the Rest Mode annotation that frames the number.
 */
import type {
  RestModeAnnotation,
  ScorePillarId,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { clampScore } from "@/lib/analytics/score/shared";
import {
  SCORE_PILLAR_LABEL_KEYS,
  scorePillarReasonKey,
} from "@/lib/score-config/labels";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { resolveRestMode } from "@/lib/illness/rest-mode";

/** One pillar of the health score as the snapshot carries it (1.50). */
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
 * v1.18.1 — the value-free Rest Mode annotation beside the score, so the
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
