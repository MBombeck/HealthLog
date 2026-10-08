/**
 * Which measurement types an account has live rows of (v1.42).
 *
 * Several readers ask this ("which types exist?") on the request path and in
 * nightly passes. Since v1.42 they ask through this one helper, so the query
 * can move to a loose index scan over `measurements_live_covering_idx`
 * without each caller re-learning the plan.
 *
 * Contract stub: the signature is final; the body is the `groupBy` the callers
 * run today.
 */
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export async function listLiveMeasurementTypes(
  userId: string,
  options: {
    source?: MeasurementSource;
    types?: readonly MeasurementType[];
  } = {},
): Promise<MeasurementType[]> {
  const rows = await prisma.measurement.groupBy({
    by: ["type"],
    where: {
      userId,
      deletedAt: null,
      ...(options.source ? { source: options.source } : {}),
      ...(options.types ? { type: { in: [...options.types] } } : {}),
    },
    orderBy: { type: "asc" },
  });
  return rows.map((row) => row.type);
}
