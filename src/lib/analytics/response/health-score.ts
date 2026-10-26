/**
 * The Health Score block of the default analytics body: the versioned
 * cardiometabolic reference report, recorded, with the Rest Mode framing.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import type { BpInTargetEnvelope } from "@/lib/analytics/bp-in-target-fast-path";
import type { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeAndRecordUserHealthScore } from "@/lib/analytics/score/record";
import { isModuleEnabled } from "@/lib/modules/gate";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { resolveGlucoseUnit } from "@/lib/glucose";

export async function readHealthScoreBlock(args: {
  user: SessionUser;
  userTz: string;
  clinicalBpTargets: ReturnType<typeof getBpTargets>;
  bpEnvelope: BpInTargetEnvelope | null;
  bpEnvelopePriorWeek: BpInTargetEnvelope | null;
  bpEnvelopePriorTwoWeeks: BpInTargetEnvelope | null;
}) {
  const {
    user,
    userTz,
    clinicalBpTargets,
    bpEnvelope,
    bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks,
  } = args;
  // The versioned cardiometabolic reference report. The shared reader
  // admits only evidence-backed pillars with their own windows and coverage
  // floors, then applies the three-domain breadth rule. Its BP envelopes come
  // from the same rollup/live fast path the dashboard uses; every other domain
  // resolves through the canonical reader and fails independently.
  const [
    glucoseEnabled,
    labsEnabled,
    sleepEnabled,
    mentalHealthEnabled,
    scoreSourcePriority,
  ] = await Promise.all([
    isModuleEnabled(user.id, "glucose"),
    isModuleEnabled(user.id, "labs"),
    isModuleEnabled(user.id, "sleep"),
    isModuleEnabled(user.id, "mentalHealth"),
    loadUserSourcePriority(user.id),
  ]);
  const scoredAt = new Date();
  const healthScore = await computeAndRecordUserHealthScore({
    userId: user.id,
    now: scoredAt,
    profile: {
      dateOfBirth: user.dateOfBirth,
      heightCm: user.heightCm ?? null,
      timezone: userTz,
      sourcePriorityJson: scoreSourcePriority,
      thresholdsJson: user.thresholdsJson ?? null,
      glucoseUnit: resolveGlucoseUnit(user.glucoseUnit),
    },
    modules: {
      glucose: glucoseEnabled,
      labs: labsEnabled,
      sleep: sleepEnabled,
      mentalHealth: mentalHealthEnabled,
    },
    healthScoreConfigJson: user.healthScoreConfigJson,
    bpTargets: clinicalBpTargets,
    bpEnvelope,
    bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks,
  });

  // Rest Mode annotation. When an illness/condition episode is
  // active we frame the score (not penalise it): the number above is left
  // exactly as computed and we attach a value-free "you were unwell" context.
  // Resolved server-side so iOS mirrors the same fact, never recomputing it.
  // Resolved as-of the scored window (`scoredAt`), not a fresh now.
  if (healthScore) {
    const restMode = await resolveRestMode(user.id, scoredAt);
    healthScore.restMode = restMode.active
      ? {
          active: true,
          since: restMode.since,
          episodeCount: restMode.episodeCount,
        }
      : null;
  }
  return { glucoseEnabled, healthScore };
}
