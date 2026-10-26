/**
 * What a bulk intake batch accumulates while its entries are walked: the
 * per-entry results and counters the response carries, and the distinct
 * days, slots and medications the tails after the loop act on.
 */
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
 * `updated` joins the per-entry status vocabulary: a write that snaps onto
 * an existing scheduled-slot row (e.g. the pending REMINDER row) updates it
 * in place rather than inserting. The iOS sync engine treats `updated` the
 * same as `inserted` for cursor advancement — both mean "the server accepted
 * this entry and produced a row id".
 */
type EntryStatus = "inserted" | "updated" | "duplicate" | "skipped";
export interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
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
  syncSlots: Map<string, { medicationId: string; scheduledFor: string }>;
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
}

export function createBatchState(
  rowIdByExternalId: Map<string, string>,
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
  };
}

/** Record an entry the batch skipped, with its reason. */
export function skipEntry(state: BatchState, index: number, reason: string) {
  state.skipped.push({ index, reason });
  state.results.push({ index, status: "skipped", reason });
}
