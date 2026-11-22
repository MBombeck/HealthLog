/**
 * One live dose row per slot: which row stays when a slot holds more than one.
 *
 * Migration 0515 made `(user_id, medication_id, scheduled_for) WHERE
 * deleted_at IS NULL` unique and merged the duplicates it found with this
 * rule, in SQL (`0515_dose_state_integrity/migration.sql`, part 5). Every
 * other place that has to make rows fit that index applies the same rule
 * through this module, so a slot merged by the migration and a slot merged
 * when an older backup comes back keep the same row:
 *
 *   1. a take (`takenAt` set and not skipped) wins,
 *   2. else a skip,
 *   3. else the oldest pending row,
 *
 * and inside one rank the oldest row wins (creation time, then id). The
 * other rows are not dropped: they come back as tombstones, so the ids a
 * paired client or a seizure rescue dose holds keep resolving.
 */

/** The fields the rule reads. */
export interface SlotMergeRow {
  takenAt: Date | null;
  skipped: boolean;
  /** Absent for a row whose creation time is unknown; it then sorts last. */
  createdAt?: Date | null;
  /** Absent for a row not yet written; it then sorts after every id. */
  id?: string | null;
}

/** 0 = take, 1 = skip, 2 = pending. A lower rank wins. */
export function slotMergeRank(row: SlotMergeRow): number {
  if (row.takenAt !== null && !row.skipped) return 0;
  if (row.skipped) return 1;
  return 2;
}

/** Sort order of the rule: the row that stays sorts first. */
export function compareSlotMergeRows(a: SlotMergeRow, b: SlotMergeRow): number {
  const rank = slotMergeRank(a) - slotMergeRank(b);
  if (rank !== 0) return rank;
  const at = a.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  const aid = a.id ?? null;
  const bid = b.id ?? null;
  if (aid === bid) return 0;
  if (aid === null) return 1;
  if (bid === null) return -1;
  return aid < bid ? -1 : 1;
}

/**
 * Split rows into the ones that stay live and the ones the rule merges away.
 * Only live rows (`isLive`) take part; a row the caller already holds as a
 * tombstone is neither kept nor merged. `slotOf` names a row's slot; rows
 * whose slot is `null` never collide. The input order is kept in both lists.
 */
export function partitionSlotDuplicates<T extends SlotMergeRow>(
  rows: readonly T[],
  slotOf: (row: T) => string | null,
  isLive: (row: T) => boolean,
): { kept: Set<T>; merged: Set<T> } {
  const bySlot = new Map<string, T[]>();
  for (const row of rows) {
    if (!isLive(row)) continue;
    const slot = slotOf(row);
    if (slot === null) continue;
    const list = bySlot.get(slot);
    if (list) list.push(row);
    else bySlot.set(slot, [row]);
  }
  const kept = new Set<T>();
  const merged = new Set<T>();
  for (const list of bySlot.values()) {
    const [winner, ...rest] = [...list].sort(compareSlotMergeRows);
    kept.add(winner);
    for (const r of rest) merged.add(r);
  }
  return { kept, merged };
}
