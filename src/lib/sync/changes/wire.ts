/**
 * The wire rows of `GET /api/sync/changes`, one upsert and one tombstone
 * shape per domain. Tombstone identity follows the iOS §7.3 table:
 * measurements key on `externalId` (the cross-device key); mood and intakes
 * key on the server `id` (the client mirrors those by server id); cycle days
 * key on `externalId` when present (HealthKit-origin rows are
 * externalId-keyed cross-device, like measurements) else the server `id`;
 * cycles key on the server `id` (computed rows carry no externalId).
 */
import type { MoodContextWire } from "@/lib/mood/context";
import type { CycleDayLogDTO, MenstrualCycleDTO } from "@/lib/cycle/dto";

export interface MeasurementUpsert {
  id: string;
  externalId: string | null;
  type: string;
  value: number;
  unit: string;
  measuredAt: string;
  source: string;
  notes: string | null;
  /** Whether the app writes the reading into Apple Health (#1272). */
  appleHealthMirror: boolean;
  syncVersion: number;
  updatedAt: string;
}

export interface MeasurementTombstone {
  id: string;
  externalId: string | null;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

export interface MoodUpsert {
  id: string;
  date: string;
  mood: string;
  score: number;
  /**
   * The five level-A self-state values, each 0-10 and each nullable. `a2` is
   * inverse-oriented: a higher number means more stress, and a client that
   * wants "up is better" flips the sign itself rather than the server
   * storing a flipped value.
   *
   * Server-authoritative: `a1` is derived from the five-point label on every
   * write, so a client that sends only `mood` still mirrors a complete row.
   */
  a1: number | null;
  a2: number | null;
  a3: number | null;
  a4: number | null;
  a5: number | null;
  /**
   * The day's context, or null when the entry carries none. Null and an
   * object of nulls are different answers and the feed keeps them apart.
   */
  context: MoodContextWire | null;
  tags: string | null;
  note: string | null;
  moodLoggedAt: string;
  source: string;
  syncVersion: number;
  updatedAt: string;
}

/** The tombstone of a domain keyed on the server id alone. */
export interface IdTombstone {
  id: string;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

export interface IntakeUpsert {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: string;
  /** Recorded by the server (`autoMarkTaken`), not the person. */
  autoRecorded: boolean;
  syncVersion: number;
  updatedAt: string;
}

export interface CycleDayTombstone {
  id: string;
  externalId: string | null;
  syncVersion: number;
  deletedAt: string;
  updatedAt: string;
}

export interface DomainBlock<U, T> {
  upserts: U[];
  tombstones: T[];
}

/**
 * A reading whose Apple Health write-back changed because its token's
 * setting did (#1272). The reading itself did not change and is not re-sent.
 */
export interface MeasurementMirrorUpsert {
  id: string;
  appleHealthMirror: boolean;
}

export interface SyncChanges {
  measurements: DomainBlock<MeasurementUpsert, MeasurementTombstone>;
  mood: DomainBlock<MoodUpsert, IdTombstone>;
  intakes: DomainBlock<IntakeUpsert, IdTombstone>;
  cycleDays: DomainBlock<CycleDayLogDTO, CycleDayTombstone>;
  cycles: DomainBlock<MenstrualCycleDTO, IdTombstone>;
  /** Never carries tombstones: a deleted reading is a measurement tombstone. */
  measurementMirror: DomainBlock<MeasurementMirrorUpsert, never>;
}

export interface SyncChangesBody {
  serverNow: string;
  cursor: string | null;
  hasMore: boolean;
  cursorExpired: boolean;
  changes: SyncChanges;
}
