/**
 * One entry of a bulk intake batch, start to end: the per-entry refusals,
 * the slot attribution, the injection site, the write, and what the batch
 * remembers of a row that landed. One bad entry never fails the batch; every
 * refusal is that entry's own outcome.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session-user";
import { dayKeyForScheduledFor } from "@/lib/medications/dose-day-refresh";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import {
  INTAKE_NOT_TRACKED_REASON,
  isRecordOnly,
} from "@/lib/medications/intake-tracking";
import {
  classifyExternalId,
  UNSTABLE_EXTERNAL_ID_REASON,
} from "@/lib/validations/external-id";
import type { InjectionSiteValue } from "@/lib/validations/medication";
import {
  skipEntry,
  type BatchState,
  type BulkIntakeEntry,
} from "./batch-state";
import { attributeEntry } from "./entry-attribution";
import { writeEntry } from "./entry-write";

/**
 * What the batch reads once about the medications it names: the
 * injection-tracking fields, so a per-entry `injectionSite` can be resolved +
 * validated without an extra per-entry read, and `externalSource`, so the
 * Apple-entry mirror gate needs no extra read either.
 */
export const OWNED_MEDICATION_SELECT = {
  id: true,
  deliveryForm: true,
  trackInjectionSites: true,
  allowedInjectionSites: true,
  externalSource: true,
  trackIntake: true,
} satisfies Prisma.MedicationSelect;

export type OwnedMedication = Prisma.MedicationGetPayload<{
  select: typeof OWNED_MEDICATION_SELECT;
}>;

export interface BatchContext {
  user: Pick<SessionUser, "id" | "timezone">;
  ownedSet: Set<string>;
  medById: Map<string, OwnedMedication>;
  globalExcluded: InjectionSiteValue[];
}

/**
 * The refusals decided before any slot is read. True when the entry is
 * answered (skipped, or a duplicate of a row the batch already knows).
 */
function screenEntry(
  ctx: BatchContext,
  state: BatchState,
  entry: BulkIntakeEntry,
  i: number,
): boolean {
  if (!ctx.ownedSet.has(entry.medicationId)) {
    skipEntry(state, i, "medication_not_found");
    return true;
  }

  // A record-only medication takes no new dose (iOS #116, item 15). The
  // single-dose routes answer 422 `medication.intake.notTracked`; here the
  // same decision is one entry's outcome, so the rest of the batch lands.
  if (isRecordOnly(ctx.medById.get(entry.medicationId) ?? {})) {
    skipEntry(state, i, INTAKE_NOT_TRACKED_REASON);
    return true;
  }

  // Both dedup keys on this route are only idempotent while the value
  // is STABLE across client launches: `(userId, externalId)` for the
  // Apple dose event, and the `@unique` `idempotency_key` column for
  // the replay probe. A value that rotates per process (an
  // object description carrying a memory address) never matches its
  // own earlier row, so every re-sync logs the dose again. Refused per
  // entry — one bad row must not stop the rest of the batch landing.
  const unstable =
    (entry.externalId === undefined
      ? null
      : classifyExternalId(entry.externalId)) ??
    (entry.idempotencyKey === undefined
      ? null
      : classifyExternalId(entry.idempotencyKey));
  if (unstable) {
    state.unstableShapes.push(unstable);
    skipEntry(state, i, UNSTABLE_EXTERNAL_ID_REASON);
    return true;
  }

  // Apple dose-event replay: the batch pre-check found a live
  // row already carrying this external UUID (or an earlier entry in
  // THIS batch inserted it). First-write-wins per Apple dose — report
  // `duplicate` with the existing row id so the sync cursor advances.
  if (entry.externalId !== undefined) {
    const existingRowId = state.rowIdByExternalId.get(entry.externalId);
    if (existingRowId !== undefined) {
      state.duplicates += 1;
      state.results.push({ index: i, status: "duplicate", id: existingRowId });
      return true;
    }
  }
  return false;
}

/**
 * Resolve + validate the optional per-entry injection site. A disallowed
 * site marks the entry skipped without failing the batch (per-entry
 * contract); a non-injection / tracking-off / non-taken entry silently drops
 * it.
 */
function resolveEntrySite(
  ctx: BatchContext,
  entry: BulkIntakeEntry,
  isExplicitTaken: boolean,
): { site: InjectionSiteKey | null } | { reason: string } {
  let resolvedInjectionSite: InjectionSiteKey | null = null;
  if (entry.injectionSite !== undefined) {
    const med = ctx.medById.get(entry.medicationId);
    const resolution = resolveInjectionSiteForWrite({
      submitted: entry.injectionSite,
      taken: isExplicitTaken,
      deliveryForm: med?.deliveryForm ?? "ORAL",
      trackInjectionSites: med?.trackInjectionSites ?? false,
      allowedInjectionSites: (med?.allowedInjectionSites ??
        []) as InjectionSiteKey[],
      globalExcludedInjectionSites: ctx.globalExcluded as InjectionSiteKey[],
    });
    if (resolution.kind === "disallowed") {
      return { reason: "injection_site_not_allowed" };
    }
    resolvedInjectionSite = resolution.site;
  }
  return { site: resolvedInjectionSite };
}

/** What the batch remembers of a row that landed. */
function recordLanded(
  ctx: BatchContext,
  state: BatchState,
  entry: BulkIntakeEntry,
  effectiveScheduledFor: Date,
): void {
  const dayKey = dayKeyForScheduledFor(
    effectiveScheduledFor,
    ctx.user.timezone,
  );
  state.touchedDays.set(`${entry.medicationId}|${dayKey}`, {
    medicationId: entry.medicationId,
    dayKey,
  });
  // Collect the slot for the silent cross-device sync (#22)
  // only when the row's state actually changed (inserted / updated). A
  // pending echo, duplicate, or no-downgrade no-op leaves the visible
  // dose state untouched, so it must not wake the user's other devices.
  // Register the landed row under its external dose-event
  // UUID so a repeat of the same UUID later in THIS batch dedups
  // in-memory instead of tripping the partial unique.
  const landed = state.results[state.results.length - 1];
  if (entry.externalId !== undefined && landed?.id !== undefined) {
    state.rowIdByExternalId.set(entry.externalId, landed.id);
  }
  const lastStatus = state.results[state.results.length - 1]?.status;
  if (lastStatus === "inserted" || lastStatus === "updated") {
    const scheduledForIso = effectiveScheduledFor.toISOString();
    state.syncSlots.set(`${entry.medicationId}|${scheduledForIso}`, {
      medicationId: entry.medicationId,
      scheduledFor: scheduledForIso,
    });
    if (!entry.skipped) state.snoozeClearIds.add(entry.medicationId);
  }
}

async function writeScreenedEntry(
  ctx: BatchContext,
  state: BatchState,
  entry: BulkIntakeEntry,
  i: number,
): Promise<void> {
  const incomingScheduledFor =
    entry.scheduledFor ?? entry.takenAt ?? new Date();

  // Classify the incoming write. An offline-sync replay echoes a
  // PENDING projection (no `takenAt`, `skipped:false`) for a slot the
  // user may already have actioned; that echo must NEVER clear a
  // recorded `takenAt`. An explicit `takenAt` or `skipped:true` is a
  // real user action and applies last-write-wins.
  const isExplicitTaken = !entry.skipped && entry.takenAt !== undefined;
  const isExplicitSkip = entry.skipped === true;

  const attribution = await attributeEntry(
    { user: ctx.user, entry, incomingScheduledFor },
    { isExplicitTaken, isExplicitSkip },
  );
  if ("reason" in attribution) {
    skipEntry(state, i, attribution.reason);
    return;
  }
  if (attribution.heldByAnotherDose) state.extraDosesUnscheduled += 1;

  const site = resolveEntrySite(ctx, entry, isExplicitTaken);
  if ("reason" in site) {
    skipEntry(state, i, site.reason);
    return;
  }

  const effectiveScheduledFor = await writeEntry(
    {
      user: ctx.user,
      entry,
      index: i,
      incomingScheduledFor,
      isExplicitTaken,
      isExplicitSkip,
      attribution,
      resolvedInjectionSite: site.site,
    },
    state,
  );
  if (effectiveScheduledFor === null) return;
  recordLanded(ctx, state, entry, effectiveScheduledFor);
}

/**
 * P2002 = unique-constraint violation. Two shapes reach here:
 *   1. an idempotencyKey collision on the unscheduled/PRN insert →
 *      "duplicate" (the canonical-slot path already absorbs its own
 *      same-slot P2002 race inside `applyCanonicalSlotWrite`);
 *   2. a same-slot collision on the unscheduled insert. In both
 *      cases we surface the existing row id so the cursor advances.
 */
async function answerFailedEntry(
  ctx: BatchContext,
  state: BatchState,
  entry: BulkIntakeEntry,
  i: number,
  err: unknown,
): Promise<void> {
  const { user } = ctx;
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  ) {
    const existing = entry.idempotencyKey
      ? await prisma.medicationIntakeEvent.findUnique({
          where: {
            userId_idempotencyKey: {
              userId: user.id,
              idempotencyKey: entry.idempotencyKey,
            },
          },
          select: { id: true },
        })
      : // An Apple entry that raced the partial
        // `(user_id, external_id)` unique (concurrent batches syncing
        // the same dose event) resolves to the winning live row.
        entry.externalId
        ? await prisma.medicationIntakeEvent.findFirst({
            where: {
              userId: user.id,
              externalId: entry.externalId,
              deletedAt: null,
            },
            select: { id: true },
          })
        : null;
    state.duplicates += 1;
    state.results.push({
      index: i,
      status: "duplicate",
      id: existing?.id,
    });
    return;
  }
  const reason =
    err instanceof Error ? err.message.slice(0, 120) : "create_failed";
  skipEntry(state, i, reason);
}

/** Ingest one entry into the batch state. */
export async function ingestEntry(
  ctx: BatchContext,
  state: BatchState,
  entry: BulkIntakeEntry,
  i: number,
): Promise<void> {
  if (screenEntry(ctx, state, entry, i)) return;
  try {
    await writeScreenedEntry(ctx, state, entry, i);
  } catch (err: unknown) {
    await answerFailedEntry(ctx, state, entry, i, err);
  }
}
