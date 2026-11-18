import { Prisma } from "@/generated/prisma/client";

/**
 * The WHERE and ORDER BY of one type's descent of the live index
 * `measurements_live_covering_idx (user_id, type, measured_at DESC) WHERE
 * deleted_at IS NULL`, over the table aliased `m`: `typeSql` names the type,
 * and the caller adds the LIMIT. The per-type reads that stop at a cap or at
 * the first row descend through it (`newest-per-type.ts` and the dashboard's
 * `readLatestEver`); `readLatestCanonical` writes the same statement out in
 * its positional form.
 *
 * The descent is the right plan for every account and every type, but the
 * planner picks it only when its row estimates say so, and for this read
 * they cannot be trusted. The type is a lateral parameter, so one generic
 * guess stands for the densest and the sparsest type alike, and it sits far
 * below the cap of a dense stream, so the planner expects the LIMIT never to
 * stop the scan and reads every row of the type into a sort. An account whose
 * rows arrived after the last ANALYZE is absent from the statistics, so it is
 * expected to hold about one row, and statistics taken while the table held a
 * single type say the type condition removes nothing. In both the type-less
 * `(user_id, measured_at)` index looks as good as the live one, and the
 * planner walked it once per type through every row of the account. On the
 * test's account of 9,300 rows that was 33,900 row visits for 6,300 rows
 * returned, and 1.66 million for `readLiveMeasurementSpan`, which walks it
 * at both ends of every type.
 *
 * So the statement withholds the values those estimates come from:
 *
 *   - the account arrives through a scalar subquery, so the planner sizes it
 *     as an average account instead of the one row a new account gets;
 *   - the type is matched as a closed range on the one value and ordered on,
 *     so it is estimated by a fixed default rather than by column statistics,
 *     and only an index leading `(user_id, type, measured_at)` returns the
 *     rows in that order. The type-less index would need a full read and a
 *     sort, which it cannot win;
 *   - a cap above one row goes through a scalar subquery too: with a limit
 *     it cannot see, the planner costs the scan as stopping early, which a
 *     sort of every row cannot match. A LIMIT 1 probe needs no help there.
 *
 * Each of the three is needed in some state of the statistics, and
 * `tests/integration/newest-per-type-plans.test.ts` builds each state and
 * holds the plans to the cap. The range direction of the ORDER BY picks the
 * live index's own order (`type` ascending, `measured_at` descending) for the
 * newest end and its backward scan for the oldest end.
 */
export function liveTypeDescent(
  userId: string,
  typeSql: Prisma.Sql,
  end: "newest" | "oldest",
  since: Date | null,
  /** Inclusive upper bound on `measured_at`, when the read has one. */
  until: Date | null = null,
): Prisma.Sql {
  const sinceSql =
    since === null ? Prisma.empty : Prisma.sql`AND m."measured_at" >= ${since}`;
  const untilSql =
    until === null ? Prisma.empty : Prisma.sql`AND m."measured_at" <= ${until}`;
  const order =
    end === "newest"
      ? Prisma.sql`ORDER BY m."type" ASC, m."measured_at" DESC`
      : Prisma.sql`ORDER BY m."type" DESC, m."measured_at" ASC`;
  return Prisma.sql`
    WHERE m."user_id" = (SELECT ${userId}::text)
      AND m."type" >= ${typeSql}
      AND m."type" <= ${typeSql}
      AND m."deleted_at" IS NULL
      ${sinceSql}
      ${untilSql}
    ${order}`;
}
