/**
 * The health score the dashboard snapshot computes, warm or held back.
 *
 * Both arms go through `computeAndRecordUserHealthScore`, the function
 * `/api/analytics` computes the score with, from the snapshot's own resolved
 * inputs. The warm phase hands in the BP envelopes it already read; a held
 * back phase (a coverage miss) reads the score's three clinical windows
 * through the fast path, which falls back to live SQL per uncovered type, so
 * the start page never answers "not enough data" where Insights answers a
 * number.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { computeAndRecordUserHealthScore } from "@/lib/analytics/score/record";
import type { HealthScoreReport } from "@/lib/analytics/score/types";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  computeBpInTargetFastPath,
  type BpInTargetEnvelope,
} from "@/lib/analytics/bp-in-target-fast-path";
import { resolveGlucoseUnit } from "@/lib/glucose";
import type { Locale } from "@/lib/i18n/config";
import type { ModuleKey } from "@/lib/modules/gate";
import type { RollupCoverageMap } from "@/lib/rollups/measurement-coverage";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { coldPhaseHealthScore } from "@/lib/dashboard/snapshot-health-score";
import type {
  DashboardSnapshotHealthScore,
  SnapshotUserInput,
} from "@/lib/dashboard/snapshot";

/** The clinical blood-pressure inputs the health score grades against. */
interface ScoreBpInputs {
  targets: ReturnType<typeof getBpTargets>;
  envelope: BpInTargetEnvelope | null;
}

/**
 * The account's health score report through `computeAndRecordUserHealthScore`,
 * the function `/api/analytics` computes it with, from the snapshot's own
 * resolved inputs (module map, source priority, clinical BP envelopes).
 */
export function computeSnapshotScoreReport(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  userTz: string,
  now: Date,
  modules: Record<ModuleKey, boolean>,
  bp: ScoreBpInputs,
): Promise<HealthScoreReport> {
  return computeAndRecordUserHealthScore({
    prisma,
    userId: user.id,
    now,
    profile: {
      dateOfBirth: user.dateOfBirth,
      heightCm: user.heightCm,
      timezone: userTz,
      sourcePriorityJson: user.sourcePriorityJson ?? null,
      thresholdsJson: user.thresholdsJson,
      glucoseUnit: resolveGlucoseUnit(user.glucoseUnit),
    },
    modules: {
      glucose: modules.glucose !== false,
      labs: modules.labs !== false,
      sleep: modules.sleep !== false,
      mentalHealth: modules.mentalHealth !== false,
    },
    healthScoreConfigJson: user.healthScoreConfigJson,
    bpTargets: bp.targets,
    bpEnvelope: bp.envelope,
  });
}

/**
 * The score's report on a coverage miss: the clinical BP envelopes read
 * through the fast path, which falls back to live SQL per uncovered type (the
 * read-swap rule), then the same report the warm phase computes. Runs on the
 * miss path only.
 */
async function liveSnapshotScoreReport(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  userTz: string,
  coverage: RollupCoverageMap,
  now: Date,
  modules: Record<ModuleKey, boolean>,
): Promise<HealthScoreReport> {
  const targets = getBpTargets(user.dateOfBirth, userTz, now);
  const envelope = targets
    ? await computeBpInTargetFastPath({
        userId: user.id,
        targets,
        now,
        coverage,
        userTz,
      })
    : null;
  return computeSnapshotScoreReport(prisma, user, userTz, now, modules, {
    targets,
    envelope,
  });
}

/** The held-back phase's health score (`coldPhaseHealthScore`), read live. */
export function heldBackScore(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  coverage: RollupCoverageMap,
  now: Date,
  modules: Record<ModuleKey, boolean>,
  locale: Locale,
): Promise<DashboardSnapshotHealthScore | null> {
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  return coldPhaseHealthScore(user.id, userTz, coverage, now, locale, () =>
    liveSnapshotScoreReport(prisma, user, userTz, coverage, now, modules),
  );
}
