/**
 * The order a medication's rows are read in, ties included.
 *
 * Postgres returns rows that tie on an `ORDER BY` in no particular order, and
 * not the same order twice: the heap layout, a vacuum or a parallel plan all
 * change it. A read ordered by a column two rows can share (two schedules at
 * 08:00 on different medications, two intakes in the same slot, two
 * medications created in one import) therefore answered its client a
 * different order from one request to the next, and a "latest" lookup picked
 * either of two rows. Every medication and intake read ends its order on the
 * row id, and `medication-read-order-guard.test.ts` holds the tree to it.
 */
import type { Prisma } from "@/generated/prisma/client";

/**
 * A medication's schedules, as every reader that hands them on includes
 * them: by window, then by id, the order the backup already writes.
 */
export const MEDICATION_SCHEDULE_ORDER = [
  { windowStart: "asc" },
  { id: "asc" },
] as const satisfies Prisma.MedicationScheduleOrderByWithRelationInput[];
