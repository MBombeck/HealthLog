/**
 * Test double for `readLatestCanonical` over a mocked Prisma client: the
 * newest live row per requested type, read through
 * `prisma.measurement.findFirst`, so a test that serves its rows from a
 * mocked `findFirst` keeps serving the latest reading the same way. The
 * source ladder is the real reader's business and is not modelled here.
 */
import type { LatestCanonicalRow } from "@/lib/measurements/latest-canonical";

export async function fakeReadLatestCanonical(
  userId: string,
  _priorityJson: unknown,
  _since: Date | null = null,
  types: readonly string[] = [],
): Promise<LatestCanonicalRow[]> {
  const { prisma } = await import("@/lib/db");
  const rows: LatestCanonicalRow[] = [];
  for (const type of types) {
    const row = (await prisma.measurement.findFirst({
      where: { userId, type, deletedAt: null },
      orderBy: { measuredAt: "desc" },
      select: { value: true, measuredAt: true },
    } as never)) as { value: number; measuredAt: Date } | null;
    if (row) rows.push({ type, value: row.value, measured_at: row.measuredAt });
  }
  return rows;
}
