/**
 * One medication's intake history: `GET /api/medications/{id}/intake`.
 *
 * The route authenticates (READ over the `medications` section), runs the
 * ownership guard and parses the query; the filter, the order, the page and
 * the count are built here.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { listIntakeEventsSchema } from "@/lib/validations/medication";

export type IntakeEventListQuery = z.output<typeof listIntakeEventsSchema>;

export async function listIntakeEvents(input: {
  userId: string;
  medicationId: string;
  query: IntakeEventListQuery;
}) {
  const { userId, medicationId: id } = input;
  const { limit, offset, sortBy, sortDir, status } = input.query;

  // Translate the optional `status` filter into a Prisma
  // `where` fragment. Default `status:"all"` keeps the contract
  // byte-stable for the iOS Swift client and the dashboard tiles that
  // were on the wire before this knob existed. The detail-page
  // IntakeHistoryListV2 component opts into `status:"completed"` so
  // ambiguous "missed / never confirmed" rows
  // (`takenAt IS NULL AND skipped = false`) stay out of the user-facing
  // table — they were the source of the v1.4.36 regression where rows
  // with no takenAt rendered an "Eingenommen" chip.
  const statusFilter =
    status === "taken"
      ? { takenAt: { not: null }, skipped: false }
      : status === "skipped"
        ? { skipped: true }
        : status === "completed"
          ? {
              OR: [
                { takenAt: { not: null }, skipped: false },
                { skipped: true },
              ],
            }
          : {};
  // Exclude tombstoned rows from the per-medication
  // intake history list + its count.
  const where = {
    medicationId: id,
    userId,
    deletedAt: null,
    ...statusFilter,
  };

  // Pin NULLS LAST on the `takenAt` sort. Skipped rows
  // carry `takenAt: null`; under a bare `desc` collation Postgres
  // emits NULLS FIRST, floating skipped/planned rows to the top of
  // the history view. Pinning them last keeps the descending order
  // reading today → yesterday → … with real timestamps first. Other
  // sort columns are non-null so they keep the simple shape.
  // The trailing `{ id: sortDir }` is the unique tiebreaker. Scheduled
  // slots share an instant by construction — a twice-daily medication puts
  // every morning dose on the same `scheduledFor` — so offset paging over
  // the primary key alone can repeat a row on one page and drop another.
  const orderBy =
    sortBy === "takenAt"
      ? [
          { takenAt: { sort: sortDir, nulls: "last" as const } },
          { id: sortDir },
        ]
      : [{ [sortBy]: sortDir }, { id: sortDir }];

  const [events, total] = await Promise.all([
    prisma.medicationIntakeEvent.findMany({
      where,
      orderBy,
      take: limit,
      skip: offset,
    }),
    prisma.medicationIntakeEvent.count({ where }),
  ]);

  annotate({
    action: { name: "medication.intake.list" },
    meta: { medication_id: id, total, status },
  });

  return { events, meta: { total, limit, offset } };
}
