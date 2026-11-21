/**
 * The record-activity feed: the audit rows filed under one record that a
 * person performed, newest first, inside the retention window, capped.
 *
 * Two readers. The owner's own feed (`GET /api/account/activity`) leaves out
 * the owner's own rows, because it is the record of what somebody ELSE did.
 * A managed profile's feed (`GET /api/managed-profiles/{id}/activity`, #1403)
 * keeps every guardian's rows, the reader's included: nobody signs in to a
 * managed profile, so everything a person did to it was done by a guardian,
 * and "who did what" is the question the feed exists to answer.
 *
 * Rows without an actor (background work, and acts by the record's own
 * session) never appear in either. Only the action name, the actor and the
 * instant leave this module; a row's details stay in the table, except the
 * day-coalesced read counter.
 */
import { DELEGATED_ACCESS_ACTION } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { GRANT_PARTY_SELECT } from "@/lib/sharing/grant-view";

/**
 * How many rows the feed returns. One row per (delegate, day) for reads, so a
 * hundred covers months of a busy household. A display bound, not a
 * completeness claim; the response says which it hit.
 */
export const RECORD_ACTIVITY_MAX_ROWS = 100;

export interface RecordActivityEntry {
  id: string;
  /**
   * Who did it. Null when that account has since been deleted: the id on the
   * row is deliberately not a foreign key, so history is not rewritten when a
   * person leaves.
   */
  actor: { id: string; username: string; displayName: string | null } | null;
  action: string;
  /** For a coalesced read row, how many times that day; null otherwise. */
  accesses: number | null;
  createdAt: string;
}

/** The `accesses` counter, when the row is a coalesced read. */
function readAccessCount(
  action: string,
  details: string | null,
): number | null {
  if (action !== DELEGATED_ACCESS_ACTION || details === null) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { accesses?: unknown }).accesses;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    // A row whose details cannot be parsed still happened. Dropping the count
    // loses a number; dropping the row would lose the access.
    return null;
  }
}

/** The columns a feed row is built from. */
export const RECORD_ACTIVITY_SELECT = {
  id: true,
  actorUserId: true,
  action: true,
  details: true,
  createdAt: true,
} as const;

/**
 * The feed's filter: the record's rows a person performed, inside the
 * retention window. `excludeActorId` leaves the owner's own rows out of the
 * owner's feed. The window is the number the response publishes and the purge
 * job reads, so the filter and the sentence cannot disagree.
 */
export function recordActivityWhere(input: {
  recordId: string;
  excludeActorId?: string;
  retentionDays: number;
}) {
  const windowStart = new Date(Date.now() - input.retentionDays * 86_400_000);
  return {
    userId: input.recordId,
    actorUserId: { not: null },
    ...(input.excludeActorId
      ? { NOT: { actorUserId: input.excludeActorId } }
      : {}),
    // The purge job makes the window true eventually; this makes it true now.
    createdAt: { gte: windowStart },
  };
}

/** The rows, with each actor resolved, as the feed publishes them. */
export async function toRecordActivityEntries(
  rows: ReadonlyArray<{
    id: string;
    actorUserId: string | null;
    action: string;
    details: string | null;
    createdAt: Date;
  }>,
): Promise<RecordActivityEntry[]> {
  const actorIds = [
    ...new Set(rows.map((r) => r.actorUserId).filter((id) => id !== null)),
  ];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: GRANT_PARTY_SELECT,
  });
  const byId = new Map(actors.map((a) => [a.id, a]));
  return rows.map((row) => ({
    id: row.id,
    actor: row.actorUserId ? (byId.get(row.actorUserId) ?? null) : null,
    action: row.action,
    accesses: readAccessCount(row.action, row.details),
    createdAt: row.createdAt.toISOString(),
  }));
}
