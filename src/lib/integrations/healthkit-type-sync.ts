/**
 * Per-type HealthKit arrival ledger (v1.42, #1173).
 *
 * The batch route records, per measurement type it received, when the type
 * last arrived, under which `syncTrigger`, and when it last brought a new or
 * updated sample (as opposed to duplicates only). The Apple Health card reads
 * it to show which types are actually flowing. A scoped ingest credential
 * does not write it, the same rule as `lastSyncedAt`.
 *
 * Contract stub: the signature is final; the body records nothing yet.
 */
import type { MeasurementType, Prisma } from "@/generated/prisma/client";

export type HealthKitSyncTrigger =
  "foreground" | "background" | "push" | "manual";

/** What one batch did for one type. */
export interface HealthKitTypeArrival {
  /** Entries of this type the batch accepted (inserted, updated or duplicate). */
  accepted: number;
  /** Entries of this type that were inserted or updated. */
  newSamples: number;
}

export async function recordHealthKitTypeArrivals(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    counts: ReadonlyMap<MeasurementType, HealthKitTypeArrival>;
    trigger: HealthKitSyncTrigger | null;
    at?: Date;
  },
): Promise<void> {
  void tx;
  void input;
}
