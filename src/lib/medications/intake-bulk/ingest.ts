/**
 * Ingest one bulk intake batch: `POST /api/medications/intake/bulk`.
 *
 * The route authenticates, meters its own bulk bucket, reads the body and
 * answers the size and schema refusals; the ownership read, the Apple mirror
 * gate, the batch pre-reads, the per-entry loop and every tail after it run
 * here, in the order they always ran. The outcome is the batch refusal the
 * route answers with `apiError`, or the always-200 batch envelope.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import type { SessionUser } from "@/lib/auth/session-user";
import { markSyncCheckpoint } from "@/lib/sync/checkpoint";
import {
  BACKFILL_SYNC_TRIGGER,
  MEDICATION_DOSE_ARRIVAL_TYPE,
  recordHealthKitTypeArrivals,
  type HealthKitRequestSyncTrigger,
} from "@/lib/integrations/healthkit-type-sync";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { refreshDoseDay } from "@/lib/medications/dose-day-refresh";
import { unstableExternalIdMeta } from "@/lib/validations/external-id";
import type { InjectionSiteValue } from "@/lib/validations/medication";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { dispatchMedicationIntakeWebClearBulk } from "@/lib/notifications/web-push-clear";
import { countOutstandingDosesToday } from "@/lib/medications/outstanding-doses";
import {
  createBatchState,
  type BatchState,
  type BulkIntakeEntry,
} from "./batch-state";
import {
  ingestEntry,
  OWNED_MEDICATION_SELECT,
  type BatchContext,
} from "./entry";

interface BatchInput {
  user: Pick<SessionUser, "id" | "timezone">;
  /**
   * A narrow, single-purpose credential (a bridge, an ingest token) is no
   * Apple Health sync, so it never writes the dose arrival record.
   */
  scoped: boolean;
  entries: BulkIntakeEntry[];
  syncTrigger: HealthKitRequestSyncTrigger | undefined;
  ipAddress: string | null;
  originDeviceToken: string | null;
}

export type BulkIntakeOutcome =
  | { kind: "refused"; message: string; errorCode: string }
  | { kind: "ingested"; body: Record<string, unknown> };

/**
 * Idempotent re-sync dedup: one read collects every live row already
 * carrying one of the batch's external dose-event UUIDs; the per-entry loop
 * reports those entries as `duplicate` (first-write-wins per Apple dose)
 * without touching the DB again. Fresh inserts register into the same map so
 * an intra-batch repeat of a UUID dedups too. The partial
 * `(user_id, external_id)` unique (migration 0239) is the race backstop.
 */
async function loadKnownExternalIds(
  userId: string,
  entries: BulkIntakeEntry[],
): Promise<Map<string, string>> {
  const batchExternalIds = Array.from(
    new Set(
      entries
        .map((e) => e.externalId)
        .filter((id): id is string => id !== undefined),
    ),
  );
  const rowIdByExternalId = new Map<string, string>();
  if (batchExternalIds.length > 0) {
    const existingExternalRows = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        externalId: { in: batchExternalIds },
        deletedAt: null,
      },
      select: { id: true, externalId: true },
    });
    for (const row of existingExternalRows) {
      if (row.externalId) rowIdByExternalId.set(row.externalId, row.id);
    }
  }
  return rowIdByExternalId;
}

/**
 * The user's global exclusion deny-list, loaded once for the whole batch (it
 * is user-scoped, not per-medication). Only read when at least one entry
 * actually carries an `injectionSite`, so the hot sync path (no site) pays
 * for zero extra round-trips.
 */
async function loadGlobalExcluded(
  userId: string,
  entries: BulkIntakeEntry[],
): Promise<InjectionSiteValue[]> {
  const batchHasInjectionSite = entries.some(
    (e) => e.injectionSite !== undefined,
  );
  let globalExcluded: InjectionSiteValue[] = [];
  if (batchHasInjectionSite) {
    const userRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { globalExcludedInjectionSites: true },
    });
    globalExcluded = (userRow?.globalExcludedInjectionSites ??
      []) as InjectionSiteValue[];
  }
  return globalExcluded;
}

/** The audit row and the event of the batch. */
async function recordBatch(input: BatchInput, state: BatchState) {
  const { entries } = input;
  const { inserted, updated, duplicates, skipped, unstableShapes } = state;
  await auditLog("medications.intake.bulk.ingest", {
    userId: input.user.id,
    ipAddress: input.ipAddress,
    details: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "medications.intake.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped: skipped.length,
      extra_doses_unscheduled: state.extraDosesUnscheduled,
      ...(unstableShapes.length > 0
        ? unstableExternalIdMeta("medication.intake.bulk", unstableShapes)
        : {}),
    },
  });
}

/**
 * The caches, the dose days, the snooze, and the cross-device and web-push
 * tails of the rows the batch landed.
 */
async function settleLandedRows(input: BatchInput, state: BatchState) {
  const { user } = input;
  // Bust per-user medications + compliance + achievement caches when at
  // least one row landed so the next read reflects the ingested batch.
  // Hard-evict: this bulk endpoint is the iOS user's INTERACTIVE intake path
  // (a dose taken / skipped on the phone syncs through here), so the very
  // next read must show the user their own action — a marked-stale SWR cell
  // would hand back the pre-dose payload. The genuinely background writers
  // (the auto-miss cron in `intake-auto-skip.ts`, slot dedup in
  // `intake-slot-dedup.ts`) keep the default mark-stale at their own call
  // sites.
  if (state.inserted > 0 || state.updated > 0) {
    invalidateUserMedications(user.id, { evict: true });
  }

  // Refresh the derived rows of each distinct `(medicationId, dayKey)` the
  // batch touched. Best-effort: the refresh reports its own failures and
  // never fails the ingest.
  for (const { medicationId, dayKey } of state.touchedDays.values()) {
    await refreshDoseDay({
      userId: user.id,
      medicationId,
      dayKey,
      tz: user.timezone,
    });
  }

  // Silent cross-device intake sync (#22). ONE queued fan-out
  // for the whole batch regardless of how many slots it touched (the
  // per-user coalescer folds bursts further), excluding the originating
  // device (`X-Device-Id` = registered `Device.token`). APNs-only,
  // best-effort, fire-and-forget: the canonical rows are already
  // persisted, so a sync-push miss never affects the batch response.
  // The single-intake routes reset a medication's snooze on every recorded
  // take; a drained offline batch must quiet the snooze the same way, or a
  // dose synced in later keeps counting as snoozed although it was taken.
  if (state.snoozeClearIds.size > 0) {
    await prisma.medication.updateMany({
      where: { id: { in: [...state.snoozeClearIds] }, userId: user.id },
      data: { snoozedUntil: null },
    });
  }

  if (state.syncSlots.size > 0) {
    queueMedicationIntakeSync({
      userId: user.id,
      originDeviceToken: input.originDeviceToken,
    });

    // PWA-only counterpart: close the still-pending dose-due
    // reminders for every affected slot over Web Push and refresh the app
    // badge once with the post-batch outstanding-dose count. Best-effort,
    // fire-and-forget — a clear miss never affects the batch response.
    const affectedSlots = Array.from(state.syncSlots.values());
    void (async () => {
      const badgeCount = await countOutstandingDosesToday(
        user.id,
        user.timezone,
      );
      await dispatchMedicationIntakeWebClearBulk({
        userId: user.id,
        slots: affectedSlots,
        badgeCount,
      });
    })();
  }
}

/**
 * Apple Health doses get the per-type arrival record the measurement batch
 * keeps for its types: when they last arrived, under which trigger, when a
 * sync last brought a new or changed dose, and when a background sync last
 * carried them. Entries sent with `source: "APPLE_HEALTH"` only; a dose taken
 * in the app is not an Apple Health arrival. Replays answered `duplicate`
 * alone are not one (#1259), the same rule as the batch route. Then the
 * SyncMode checkpoint, which belongs to the push that moved the data, not to
 * the `/api/sync/state` handshake that reports it. This endpoint is one of
 * the three domains that handshake summarises, so an intake drain advances
 * it. A `backfill` catch-up does not: it is history, not a sync.
 */
async function recordSyncArrival(input: BatchInput, state: BatchState) {
  const { user, entries, syncTrigger } = input;
  const doseArrival = { accepted: 0, newSamples: 0 };
  for (const result of state.results) {
    if (entries[result.index]?.source !== "APPLE_HEALTH") continue;
    if (result.status === "skipped") continue;
    doseArrival.accepted += 1;
    if (result.status !== "duplicate") doseArrival.newSamples += 1;
  }
  if (doseArrival.accepted > 0 && !input.scoped) {
    await recordHealthKitTypeArrivals(prisma, {
      userId: user.id,
      counts: new Map([[MEDICATION_DOSE_ARRIVAL_TYPE, doseArrival]]),
      trigger: syncTrigger ?? null,
    });
  }

  if (syncTrigger !== BACKFILL_SYNC_TRIGGER) {
    await markSyncCheckpoint(user.id);
  }
}

export async function ingestBulkIntake(
  input: BatchInput,
): Promise<BulkIntakeOutcome> {
  const { user, entries } = input;

  // Up-front ownership check — the user can only POST intake events
  // against medications they own. One read covers every medicationId
  // in the batch.
  const medicationIds = Array.from(new Set(entries.map((e) => e.medicationId)));
  const ownedMedications = await prisma.medication.findMany({
    where: { id: { in: medicationIds }, userId: user.id },
    select: OWNED_MEDICATION_SELECT,
  });
  const ownedSet = new Set(ownedMedications.map((m) => m.id));
  const medById = new Map(ownedMedications.map((m) => [m.id, m]));

  // Source-exclusive Apple-mirrored medications: an APPLE_HEALTH
  // dose event may only attach to a medication mirrored from Apple Health
  // (`Medication.externalSource === "APPLE_HEALTH"`). Targeting a native
  // medication is a client contract violation (the iOS sync maps HK dose
  // events onto the meds it mirrored itself), not a per-entry data
  // problem, so the whole batch 422s with a stable errorCode the client
  // can branch on. Unowned medicationIds keep the per-entry
  // `medication_not_found` skip.
  const appleMismatch = entries.some(
    (e) =>
      e.source === "APPLE_HEALTH" &&
      ownedSet.has(e.medicationId) &&
      medById.get(e.medicationId)?.externalSource !== "APPLE_HEALTH",
  );
  if (appleMismatch) {
    return {
      kind: "refused",
      message:
        "An APPLE_HEALTH entry may only target a medication mirrored from Apple Health",
      errorCode: "medications.intake.bulk.apple_health_not_mirrored",
    };
  }

  const state = createBatchState(await loadKnownExternalIds(user.id, entries));
  const ctx: BatchContext = {
    user,
    ownedSet,
    medById,
    globalExcluded: await loadGlobalExcluded(user.id, entries),
  };

  for (let i = 0; i < entries.length; i++) {
    await ingestEntry(ctx, state, entries[i], i);
  }

  await recordBatch(input, state);
  await settleLandedRows(input, state);
  await recordSyncArrival(input, state);

  return {
    kind: "ingested",
    body: {
      processed: entries.length,
      inserted: state.inserted,
      updated: state.updated,
      duplicates: state.duplicates,
      skipped: state.skipped,
      entries: state.results,
    },
  };
}
