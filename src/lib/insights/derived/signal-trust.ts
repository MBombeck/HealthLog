/**
 * v1.22 (W9, C3) — which-signal-to-trust snapshot block.
 *
 * Reads the recent `RECOVERY_SCORE` rows (all sources) and, when two sources
 * materially diverge for the most recent night, surfaces the canonical pick +
 * the honest alternative so the Coach can NARRATE which it reads and why
 * ("I'm reading recovery from your band — the direct measure; the computed
 * estimate lags it by a few points"), instead of silently averaging or
 * flip-flopping. Below the materiality threshold the sources agree and the
 * block is omitted — the Coach never narrates trivial noise.
 *
 * Recovery is the only multi-source metric with a canonical resolver today
 * (`resolveCanonicalRecovery`); C3 is scoped to it for v1.22. Weight-from-two-
 * scales and HR-from-two-wearables are follow-ons once they grow a resolver.
 *
 * Server-only — reads Prisma. Fault-isolation is the caller's (the snapshot
 * wraps the call in `.catch`).
 */
import { prisma } from "@/lib/db";
import {
  describeRecoveryDivergence,
  type RecoveryDivergence,
} from "@/lib/insights/derived/recovery-resolve";

/** How far back the divergence read looks for a comparable two-source night. */
export const SIGNAL_TRUST_WINDOW_DAYS = 10;

/** The snapshot block shape — small, descriptive, never a number the model recites. */
export interface SignalTrustBlock {
  metric: "RECOVERY_SCORE";
  chosenSource: string;
  alternativeSource: string;
  chosenValue: number;
  alternativeValue: number;
  divergence: number;
  chosenIsDirect: boolean;
}

/**
 * Build the signal-trust block for recovery. Returns `null` when there is no
 * recent night with two materially-diverging sources (the common case).
 */
export async function buildSignalTrust(
  userId: string,
  timezone: string | null,
  now: Date = new Date(),
): Promise<SignalTrustBlock | null> {
  const since = new Date(
    now.getTime() - SIGNAL_TRUST_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "RECOVERY_SCORE",
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "desc" },
    select: { value: true, measuredAt: true, source: true },
  });
  if (rows.length === 0) return null;

  const divergence: RecoveryDivergence | null = describeRecoveryDivergence(
    rows.map((r) => ({
      value: r.value,
      measuredAt: r.measuredAt,
      source: r.source,
    })),
    timezone,
  );
  if (!divergence) return null;

  return {
    metric: "RECOVERY_SCORE",
    chosenSource: divergence.chosenSource,
    alternativeSource: divergence.alternativeSource,
    chosenValue: divergence.chosenValue,
    alternativeValue: divergence.alternativeValue,
    divergence: divergence.divergence,
    chosenIsDirect: divergence.chosenIsDirect,
  };
}
