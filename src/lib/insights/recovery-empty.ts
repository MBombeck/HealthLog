/**
 * Why the recovery page is empty, decided once on the server.
 *
 * The page charts the device-native recovery signals below. When none of
 * them has a reading, the analytics slice publishes the reason beside the
 * summaries (`recoveryEmpty`), and every client renders from it rather than
 * working it out from the connection status itself:
 *
 *  - `oura_permission`: Oura is connected and the stored grant leaves out
 *    the scope its resilience level sits behind; one reconnect fixes it.
 *  - `oura_no_resilience`: Oura is connected and no level has arrived. The
 *    server cannot always tell "the grant covers it" from "not recorded yet"
 *    (the scope note is rewritten on every reconnect from the scopes Oura
 *    reports, when it reports them, and otherwise only by a sync that
 *    reached Oura), so this case never claims coverage.
 *  - `general`: anyone else.
 *
 * `null` means the page has something to chart.
 *
 * Pure, so the page can share the type list it charts from.
 */

/** Every summary type the recovery page charts or shows as a tile. */
export const RECOVERY_SUMMARY_TYPES = [
  "ANS_CHARGE",
  "DAY_STRAIN",
  "WORKOUT_STRAIN",
  "CARDIO_LOAD",
  "BODY_BATTERY",
  "STRESS_LEVEL",
  "TRAINING_READINESS",
  "ACUTE_TRAINING_LOAD",
  "AVERAGE_HEART_RATE",
  "MAX_HEART_RATE",
  "ENERGY_EXPENDITURE_KJ",
  "RESILIENCE",
] as const;

export const RECOVERY_EMPTY_REASONS = [
  "general",
  "oura_permission",
  "oura_no_resilience",
] as const;

export type RecoveryEmptyReason = (typeof RECOVERY_EMPTY_REASONS)[number];

/** True when any recovery type has a reading. */
export function hasRecoveryData(
  summaries: Record<string, { count?: number } | null | undefined>,
): boolean {
  return RECOVERY_SUMMARY_TYPES.some(
    (type) => (summaries[type]?.count ?? 0) > 0,
  );
}

export function resolveRecoveryEmpty(
  summaries: Record<string, { count?: number } | null | undefined>,
  oura: { connected: boolean; scopeDenied: readonly string[] },
): RecoveryEmptyReason | null {
  if (hasRecoveryData(summaries)) return null;
  if (!oura.connected) return "general";
  return oura.scopeDenied.includes("resilience")
    ? "oura_permission"
    : "oura_no_resilience";
}
