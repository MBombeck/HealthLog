/**
 * The correlation block of the default analytics body: the three fixed
 * hypotheses, with the accepted ones synced to the stored patterns and
 * their decision attached.
 */
import type { Locale } from "@/lib/i18n/config";
import { computeCorrelationHypothesesFastPath } from "@/lib/analytics/correlations-fast-path";
import {
  decisionForEvidence,
  PATTERN_FAMILIES,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";
import type { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";

type Coverage = Awaited<ReturnType<typeof probeRollupCoverage>>;

export async function readCorrelationBlock(args: {
  userId: string;
  userTz: string;
  coverage: Coverage;
  locale: Locale;
}) {
  const { userId, userTz, coverage, locale } = args;
  // Three pre-defined correlation hypotheses.
  // Probe-gated helper. The 28-day scan window (down
  // from 30 to keep the cold critical path tight while still
  // satisfying the n >= 20 surface gate) reads SYS / PULSE / WEIGHT
  // per-day means from `measurement_rollups` when the user has full
  // coverage; mood and medication-intake reads always stay live (no
  // rollup equivalent). The helper emits `meta.correlations.path` +
  // `meta.correlations.window_days` so prod logs prove the branch
  // selection and the truthful window.
  const correlations = await computeCorrelationHypothesesFastPath({
    userId,
    userTz,
    now: new Date(),
    coverage,
    locale,
  });
  const fixedDefinitions = [
    {
      key: "bpCompliance" as const,
      factorKey: "HYPOTHESIS:MEDICATION_COMPLIANCE",
      outcomeKey: "BLOOD_PRESSURE_SYS",
    },
    {
      key: "moodPulse" as const,
      factorKey: "HYPOTHESIS:MOOD",
      outcomeKey: "RESTING_PULSE",
    },
    {
      key: "weightWeekday" as const,
      factorKey: "HYPOTHESIS:WEEKDAY",
      outcomeKey: "WEIGHT",
    },
  ];
  const acceptedFixed = fixedDefinitions.flatMap((definition) => {
    const result = correlations[definition.key];
    return result.status === "ok"
      ? [
          {
            factorKey: definition.factorKey,
            outcomeKey: definition.outcomeKey,
            lagDays: 0,
            sampleSize: result.n,
            effectSize: result.statistic,
            pValue: result.pValue,
            qValue: null,
          },
        ]
      : [];
  });
  const fixedDecisions = await syncAcceptedPatterns({
    userId,
    family: PATTERN_FAMILIES.fixed,
    accepted: acceptedFixed,
  });
  const correlationsWithPatterns = { ...correlations };
  for (const definition of fixedDefinitions) {
    const result = correlations[definition.key];
    if (result.status !== "ok") continue;
    const decision = decisionForEvidence(fixedDecisions, {
      factorKey: definition.factorKey,
      outcomeKey: definition.outcomeKey,
      lagDays: 0,
    });
    correlationsWithPatterns[definition.key] = decision
      ? { ...result, ...decision }
      : result;
  }
  return correlationsWithPatterns;
}
