/**
 * RECON1 (D5-5) — discovered-driver block for the no-tools Coach snapshot.
 *
 * The FDR-controlled cross-metric driver pairs were reachable ONLY via the
 * `get_correlations` tool, so a local / no-tools provider (Ollama) got the
 * coincident-deviation flag but ZERO discovered drivers — the differentiating
 * cross-metric layer silently degraded, and system-prompt rule 14's fallback
 * clause ("any correlation/driver field the SNAPSHOT carries") pointed at a
 * field that did not exist on the no-tools path.
 *
 * This block closes that gap by attaching a BOUNDED slice of the SAME gated,
 * ranked output the tool serves — `readCoachCorrelations` runs the identical
 * discovery scan + quality gates (effect-size floor, family-tautology
 * exclusion, sample-size shrinkage, confidence tiering), so a local user sees
 * exactly the quality-filtered drivers a cloud user's tool would. We keep only
 * the top few by ranked effect so the no-tools prompt stays compact.
 *
 * Server-only — `readCoachCorrelations` reads `@/lib/db`. Fail-soft: a null
 * return (no surviving driver / read hiccup) attaches nothing.
 */
import { UNBOUNDED_REACH, type CoachHistoryReach } from "./history-reach";
import type { Locale } from "@/lib/i18n/config";
import {
  readCoachCorrelations,
  type CoachCorrelationDriver,
} from "./tools/correlations-read";

/** How many ranked drivers reach the no-tools snapshot floor. */
export const SNAPSHOT_DRIVER_CAP = 3;

/** One compact driver line for the snapshot — descriptive, never causal. */
export interface CorrelationsSnapshotBlock {
  /** Top discovered drivers by ranked effect, capped + descriptive. */
  drivers: CoachCorrelationDriver[];
  /** How many behaviour×outcome pairs were tested (honest footer). */
  pairsTested: number;
  /** Trailing-day window the discovery scanned. */
  windowDays: number;
}

/**
 * Build the bounded discovered-driver block for the no-tools snapshot floor, or
 * `null` when no driver survives the quality gates (or the read fails). The
 * coincident flag is intentionally NOT duplicated here — the derived block
 * already carries it; this block adds only the discovered-driver layer the
 * no-tools path was missing.
 */
export async function buildCorrelationsSnapshotBlock(
  userId: string,
  /**
   * The Coach's resolved UI locale. The driver notes go into the prompt as
   * finished sentences, and a model handed English prose for a German
   * conversation echoes English phrasings back. Required — the snapshot knows
   * the locale, so it says it.
   */
  locale: Locale,
  /** The Coach's lookback limit, applied to the scan window. */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CorrelationsSnapshotBlock | null> {
  const result = await readCoachCorrelations(userId, locale, { reach });
  if (!result.present || !result.drivers || result.drivers.length === 0) {
    return null;
  }
  // `result.drivers` arrives already ranked by the discovery engine (shrunk
  // effect magnitude, q as tie-break) and already gated (below-floor pairs
  // dropped, tautologies excluded) — so the top-N slice is the highest-signal
  // quality-filtered drivers, identical to what the tool path would surface.
  return {
    drivers: result.drivers.slice(0, SNAPSHOT_DRIVER_CAP),
    pairsTested: result.pairsTested ?? 0,
    windowDays: result.windowDays ?? 0,
  };
}
