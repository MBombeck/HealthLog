/**
 * Stable notification tag for a medication dose slot, `(medicationId,
 * scheduledFor instant)`. A repeated reminder for the same dose replaces the
 * one already shown instead of stacking a second.
 *
 * The instant is normalised through `Date`, so an ISO string with and one
 * without milliseconds give the same tag.
 */
export function medicationDoseTag(
  medicationId: string,
  scheduledForIso: string,
): string {
  const t = Date.parse(scheduledForIso);
  const instant = Number.isNaN(t) ? scheduledForIso : new Date(t).toISOString();
  return `med:${medicationId}:${instant}`;
}
