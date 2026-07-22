import type { AggregatedFeatures } from "@/lib/insights/features";
import type { Glp1SnapshotBlock } from "../glp1-snapshot";
import type { CoachProvenanceMetric, CoachScopeSource } from "../types";

interface ProfileContextBlocksContext {
  excludesMedications: boolean;
  excludesAnthropometrics: boolean;
  glp1Block: Glp1SnapshotBlock | null;
  profile: AggregatedFeatures["context"] | undefined;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

export function buildProfileContextBlocks(
  ctx: Readonly<ProfileContextBlocksContext>,
): void {
  if (!ctx.excludesMedications && ctx.glp1Block) {
    ctx.snapshot.weeklyContext = { glp1: ctx.glp1Block };
    ctx.metrics.add("compliance");
    ctx.registerBlock("weeklyContext", "compliance");
  }

  const profile = ctx.profile;
  if (
    !ctx.excludesAnthropometrics &&
    profile &&
    (profile.heightCm !== null ||
      profile.ageYears !== null ||
      profile.gender !== null)
  ) {
    ctx.snapshot.anthropometrics = {
      heightCm: profile.heightCm,
      ageYears: profile.ageYears,
      gender: profile.gender,
    };
  }
}

interface DayStrainBlockContext {
  rows: ReadonlyArray<{ value: number; measuredAt: Date }> | null;
  recentCutoff: Date;
  snapshot: Record<string, unknown>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

export function buildDayStrainBlock(
  ctx: Readonly<DayStrainBlockContext>,
): void {
  if (!ctx.rows || ctx.rows.length === 0) return;

  const latest = ctx.rows[ctx.rows.length - 1];
  const recent = ctx.rows.filter((row) => row.measuredAt >= ctx.recentCutoff);
  const recentMean =
    recent.length > 0
      ? Math.round(
          (recent.reduce((sum, row) => sum + row.value, 0) / recent.length) *
            10,
        ) / 10
      : Math.round(latest.value * 10) / 10;

  ctx.snapshot.dayStrain = {
    source: "WHOOP-native",
    scale: "0-21",
    latest: Math.round(latest.value * 10) / 10,
    recentMean,
    days: ctx.rows.length,
    note: "Device-native day strain; prefer over derived.STRAIN_SCORE (computed 0-100 proxy).",
  };
  ctx.registerBlock("dayStrain", "hrv");
}
