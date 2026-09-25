/**
 * The start of a medication's LIVE schedule era: the instant from which its
 * current `MedicationSchedule` rows are in force.
 *
 * A schedule replace, or switching intake tracking off or back on, archives
 * the previous era as a `MedicationScheduleRevision` ending "now". The newest
 * active revision's `validUntil` is therefore where the live rows began. A
 * slot the live rows would produce BEFORE that instant was never expected:
 * the day's earlier doses belonged to the previous era (or to no era at all,
 * while tracking was off). Minting it would put a dose on the card that the
 * person could not have taken on this schedule, and the auto-miss pass would
 * later stamp it a miss.
 *
 * Every path that mints or displays a slot from the live rows floors on this
 * one instant: the today projector, the reminder worker, the next-due read
 * (doses card, medication list, MCP) and the auto-miss pass. `null` means the
 * medication has never had a schedule revision: the live rows have been in
 * force since it was created, and the callers' own creation handling applies.
 */

/**
 * Prisma relation args selecting the newest ACTIVE revision's boundary.
 * Superseded revisions are audit records whose `validUntil` may sit past a
 * later correction, so only active rows count.
 */
export const LIVE_ERA_REVISION_ARGS = {
  where: { supersededByRevisionId: null },
  orderBy: { validUntil: "desc" },
  take: 1,
  select: { validUntil: true },
} as const;

/** The live era start from revisions read with {@link LIVE_ERA_REVISION_ARGS}. */
export function liveEraStart(
  revisions: readonly { validUntil: Date }[] | null | undefined,
): Date | null {
  if (!revisions || revisions.length === 0) return null;
  let newest = revisions[0].validUntil;
  for (const r of revisions) {
    if (r.validUntil.getTime() > newest.getTime()) newest = r.validUntil;
  }
  return newest;
}

/**
 * Live era starts per medication from a `medicationScheduleRevision.groupBy`
 * over active revisions with `_max: { validUntil: true }`.
 */
export function liveEraStartsByMedication(
  rows: readonly {
    medicationId: string;
    _max: { validUntil: Date | null };
  }[],
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.validUntil) out.set(row.medicationId, row._max.validUntil);
  }
  return out;
}

/** True when a slot anchored at `slot` predates the live era. */
export function isBeforeLiveEra(slot: Date, eraStart: Date | null): boolean {
  return eraStart !== null && slot.getTime() < eraStart.getTime();
}
