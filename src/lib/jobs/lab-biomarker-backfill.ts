/**
 * v1.18.1 — one-shot backfill that links legacy `LabResult` rows to a
 * user-scoped `Biomarker` catalog entry.
 *
 * Before the catalog existed, every lab reading carried its own free-text
 * `analyte` / `unit` / `reference*`. Recording "LDL" three times forked the
 * "same" marker into "LDL" / "ldl" / "LDL-C" with possibly diverging units
 * and ranges. This pass heals that at the source: for each user, it groups
 * every un-linked live reading by `lower(analyte)`, creates ONE `Biomarker`
 * per group (using the most-recently-taken reading's spelling / unit /
 * reference bounds — "last lab report wins"), and stamps `biomarkerId` on
 * every row in the group.
 *
 * Idempotent across reboots: the discovery predicate is "the user has at
 * least one live reading with `biomarkerId IS NULL`". A completed pass leaves
 * every reading linked, so the user drops out of the discovery set. A reboot
 * mid-pass re-runs from scratch — `Biomarker` creation upserts on
 * `(userId, name)` and the row-link `updateMany` is `biomarkerId: null`-gated,
 * so the result converges. A reading whose marker already exists (e.g. the
 * user defined it by hand) re-uses that row rather than minting a duplicate.
 *
 * Modelled on `sleep-timeline-backfill.ts` / `whoop-backfill.ts`. The queue
 * name MUST be registered in `allQueues` in `src/lib/jobs/reminder-worker.ts`
 * or pg-boss never provisions it and the boot enqueue silently never drains
 * (the v1.4.37 dead-queue class).
 */
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { annotate } from "@/lib/logging/context";

export const LAB_BIOMARKER_BACKFILL_QUEUE = "lab-biomarker-backfill";

/**
 * Serial concurrency — the per-user pass is a short burst of grouped writes;
 * concurrency-1 keeps it off the request pool, matching the other backfill
 * queues.
 */
export const LAB_BIOMARKER_BACKFILL_CONCURRENCY = 1;

export interface LabBiomarkerBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/** A single legacy reading the grouping reads. */
interface LegacyRow {
  id: string;
  analyte: string;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  panel: string | null;
  takenAt: Date;
}

interface AnalyteGroup {
  /** Canonical spelling = the most-recently-taken reading's `analyte`. */
  name: string;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  panel: string | null;
  ids: string[];
}

/**
 * Reduce the user's un-linked rows into one group per `lower(analyte)`. The
 * canonical name / unit / range come from the most-recently-TAKEN reading in
 * each group ("last lab report wins"); every row id rides into the group so a
 * single `updateMany` can link them. Exported for unit testing.
 */
export function groupRowsByAnalyte(rows: LegacyRow[]): AnalyteGroup[] {
  const byKey = new Map<string, LegacyRow[]>();
  for (const r of rows) {
    const key = r.analyte.trim().toLowerCase();
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const groups: AnalyteGroup[] = [];
  for (const bucket of byKey.values()) {
    // Newest reading defines the canonical name / unit / range.
    const newest = bucket.reduce((a, b) =>
      b.takenAt.getTime() >= a.takenAt.getTime() ? b : a,
    );
    groups.push({
      name: newest.analyte.trim(),
      unit: newest.unit,
      referenceLow: newest.referenceLow,
      referenceHigh: newest.referenceHigh,
      panel: newest.panel,
      ids: bucket.map((r) => r.id),
    });
  }
  return groups;
}

/**
 * Backfill one user: group un-linked live readings, create/reuse a Biomarker
 * per group, link the rows. Returns the count of markers touched + rows
 * linked.
 */
export async function runLabBiomarkerBackfillForUser(
  userId: string,
): Promise<{ markers: number; linked: number }> {
  const rows = await prisma.labResult.findMany({
    where: { userId, deletedAt: null, biomarkerId: null },
    select: {
      id: true,
      analyte: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      panel: true,
      takenAt: true,
    },
  });

  if (rows.length === 0) {
    return { markers: 0, linked: 0 };
  }

  const groups = groupRowsByAnalyte(rows);

  let markers = 0;
  let linked = 0;
  for (const group of groups) {
    // Re-use a hand-defined marker of the same name if one exists; otherwise
    // mint it. `(userId, name)` is unique, so a concurrent re-run converges.
    const biomarker = await prisma.biomarker.upsert({
      where: { userId_name: { userId, name: group.name } },
      // An existing marker keeps its own (possibly user-tuned) unit / range.
      update: {},
      create: {
        userId,
        name: group.name,
        unit: group.unit,
        lowerBound: group.referenceLow,
        upperBound: group.referenceHigh,
        panel: group.panel,
      },
    });
    markers += 1;

    const { count } = await prisma.labResult.updateMany({
      where: { id: { in: group.ids }, userId, biomarkerId: null },
      data: { biomarkerId: biomarker.id },
    });
    linked += count;
  }

  annotate({
    action: {
      name: "labs.biomarker.backfill.complete",
      details: { markers, linked },
    },
  });
  return { markers, linked };
}

/**
 * Boot-time discovery. Finds every user holding at least one un-linked live
 * lab reading and enqueues one job each. Idempotent across reboots: a
 * completed pass links every reading, dropping the user from the discovery
 * set. `singletonKey` coalesces duplicate sends.
 *
 * Best-effort: errors come back through the result value so worker boot never
 * fails because of a backfill miss.
 */
export async function enqueueBootTimeLabBiomarkerBackfill(
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // v1.28.46 perf (H4) — DB-level SELECT DISTINCT, not Prisma `distinct`
    // (which fetches every matching row then de-dupes in JS at boot). The
    // migration-0243 partial index over `(user_id) WHERE deleted_at IS NULL
    // AND biomarker_id IS NULL` makes this an index-only scan that converges
    // to empty as rows are linked.
    const rows = await prisma.$queryRaw<{ user_id: string }[]>`
      SELECT DISTINCT user_id FROM lab_results
      WHERE deleted_at IS NULL AND biomarker_id IS NULL`;

    if (rows.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { user_id: userId } of rows) {
      const payload: LabBiomarkerBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        LAB_BIOMARKER_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `lab-biomarker-backfill|${userId}`,
          startAfterSeconds,
        ),
      );
      if (jobId) enqueued += 1;
      else skipped += 1;
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
