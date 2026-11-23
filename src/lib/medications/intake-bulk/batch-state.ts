/**
 * What a bulk intake batch accumulates while its entries are walked: the
 * per-entry results and counters the response carries, and the distinct
 * days, slots and medications the tails after the loop act on.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import type { IntakeRecordedEvent } from "@/lib/notifications/medication-intake-recorded";
import type { UnstableExternalIdShape } from "@/lib/validations/external-id";
import type { InjectionSiteValue } from "@/lib/validations/medication";

/**
 * One entry of `POST /api/medications/intake/bulk`, as the route's schema
 * parses it.
 */
export interface BulkIntakeEntry {
  medicationId: string;
  scheduledFor?: Date;
  takenAt?: Date;
  skipped: boolean;
  idempotencyKey?: string;
  injectionSite?: InjectionSiteValue;
  forceSlotInstant?: Date;
  doseTaken?: string;
  source?: "APPLE_HEALTH";
  externalId?: string;
}

/**
 * A `skipped` with reason `deleted_in_healthlog` is a re-post of a dose the
 * person deleted in HealthLog: nothing was written (`tombstone-repost.ts`).
 *
 * `updated` joins the per-entry status vocabulary: a write that snaps onto
 * an existing scheduled-slot row (e.g. the pending REMINDER row) updates it
 * in place rather than inserting. The iOS sync engine treats `updated` the
 * same as `inserted` for cursor advancement — both mean "the server accepted
 * this entry and produced a row id".
 */
type EntryStatus =
  "inserted" | "updated" | "duplicate" | "alreadyTaken" | "skipped";
export interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
  /**
   * The landed row's `syncVersion` once the batch has settled, so the client
   * can undo the entry with `expectedSyncVersion` (absent on skips).
   */
  syncVersion?: number;
  /** On `alreadyTaken`: the recorded row and the take it holds. */
  intake?: MedicationIntakeEvent;
  /**
   * On `alreadyTaken` and on a `force_slot_occupied` skip: when and how the
   * take that holds the slot was recorded (both null when a skip holds it).
   */
  takenAt?: string | null;
  takenVia?: string | null;
  /**
   * The slot the entry's row is on, as the single route's `slotInstant`
   * says it: the canonical slot of a scheduled dose, null for a row on no
   * slot (an ad-hoc take, an extra dose) and for an entry that stored
   * nothing. A `force_slot_occupied` skip names the slot it was refused.
   * Set on every entry once the batch settled (`ingest.ts`).
   */
  slotInstant?: string | null;
}

export interface BatchState {
  results: EntryResult[];
  inserted: number;
  updated: number;
  duplicates: number;
  /**
   * External dose records kept as their own unscheduled dose because their
   * band slot already carried a different one.
   */
  extraDosesUnscheduled: number;
  skipped: Array<{ index: number; reason: string }>;
  unstableShapes: UnstableExternalIdShape[];
  /**
   * Distinct `(medicationId, dayKey)` pairs touched by the batch, so one
   * dose-day refresh fires per pair after all inserts complete. A per-row
   * refresh would balloon a 500-entry batch into 500 sequential refreshes.
   */
  touchedDays: Map<string, { medicationId: string; dayKey: string }>;
  /**
   * Distinct `(medicationId, scheduledFor)` slots whose state actually
   * changed in this batch (#22: a row inserted / updated), so the silent
   * cross-device sync fires once per affected slot — not once per row, and
   * not for pending echoes / duplicates that changed nothing.
   */
  syncSlots: Map<
    string,
    {
      medicationId: string;
      scheduledFor: string;
      /** The take or skip it recorded, for the visible confirmation. */
      recorded?: IntakeRecordedEvent;
    }
  >;
  /**
   * A landed non-skipped dose quiets an active snooze, exactly like the
   * single-intake routes (they null `snoozedUntil` on every recorded take).
   * Collected per medication here, cleared once after the loop.
   */
  snoozeClearIds: Set<string>;
  /**
   * Live rows already carrying one of the batch's external dose-event UUIDs,
   * and the rows this batch landed under one, so an intra-batch repeat of a
   * UUID dedups too.
   */
  rowIdByExternalId: Map<string, string>;
  /**
   * Apple Health dose-event UUIDs of doses deleted earlier with no live row
   * under them: their entries are refused (`tombstone-repost.ts`).
   */
  tombstonedExternalIds: Set<string>;
}

export function createBatchState(
  rowIdByExternalId: Map<string, string>,
  tombstonedExternalIds: Set<string> = new Set(),
): BatchState {
  return {
    results: [],
    inserted: 0,
    updated: 0,
    duplicates: 0,
    extraDosesUnscheduled: 0,
    skipped: [],
    unstableShapes: [],
    touchedDays: new Map(),
    syncSlots: new Map(),
    snoozeClearIds: new Set<string>(),
    rowIdByExternalId,
    tombstonedExternalIds,
  };
}

/**
 * Record an entry the batch skipped, with its reason and, for an occupied
 * pin, what holds the slot.
 */
export function skipEntry(
  state: BatchState,
  index: number,
  reason: string,
  held?: Pick<EntryResult, "slotInstant" | "takenAt" | "takenVia">,
) {
  state.skipped.push({ index, reason });
  state.results.push({ index, status: "skipped", reason, ...held });
}
