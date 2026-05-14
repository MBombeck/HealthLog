/**
 * v1.4.25 W21 Fix-N — shared Research Mode status DTO.
 *
 * Both `<DrugLevelChart>` (medication detail page) and the Settings →
 * Advanced surface (`<AdvancedSection>`) query the same
 * `/api/auth/me/research-mode` endpoint to gate the drug-level chart on
 * acknowledged disclaimer version. Until Fix-N both surfaces hand-rolled
 * the same `ResearchModeStatus` interface; this module is now the single
 * source of truth so the two readers can never disagree on shape.
 *
 * Contract mirrors the API response under the `data` key:
 *   { enabled, acknowledgedAt, acknowledgedVersion, currentDisclaimerVersion }
 *
 * `enabled === true && acknowledgedVersion === currentDisclaimerVersion`
 * is the only gate-open shape; every other permutation (off, stale-on)
 * renders the gated placeholder UI.
 */
export interface ResearchModeStatus {
  /** User opt-in flag — false unless the user has acknowledged at least once. */
  enabled: boolean;
  /** ISO timestamp of the most recent acknowledgment, null when never acknowledged. */
  acknowledgedAt: string | null;
  /** Disclaimer version the user last acknowledged; null when never acknowledged. */
  acknowledgedVersion: string | null;
  /** Disclaimer version the server is currently serving. Drives the re-prompt branch. */
  currentDisclaimerVersion: string;
}

/**
 * Tri-state helper — narrow the raw status into one of the three UI
 * branches: off, stale (acknowledged-but-server-bumped-version), or
 * open. The DrugLevelChart and the Settings re-prompt banner both use
 * this so the rules stay aligned.
 */
export type ResearchModeGateState = "off" | "stale" | "open";

export function researchModeGateState(
  status: ResearchModeStatus | null | undefined,
): ResearchModeGateState {
  if (!status || !status.enabled) return "off";
  if (status.acknowledgedVersion !== status.currentDisclaimerVersion) {
    return "stale";
  }
  return "open";
}
