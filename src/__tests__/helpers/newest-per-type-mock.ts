/**
 * A stand-in for `@/lib/measurements/newest-per-type` in unit tests whose
 * Prisma mock serves measurement rows through `measurement.findMany`.
 *
 * The real read is one raw statement (a capped index descent per type), which
 * a `findMany` mock never sees. These suites were written against the
 * `findMany` the reads used before, routing rows by `where.type` and counting
 * calls, so the stand-in issues exactly that call, once per read, and applies
 * what the statement does in memory: the requested types only, newest first
 * up to the cap per type, the fair cut to the total when one is given, then
 * oldest first. The span probe answers from the
 * rows the same build's read was served, without a second call, so call counts
 * stay what the suites pin.
 *
 * Use as
 *   vi.mock("@/lib/measurements/newest-per-type", async () =>
 *     (await import("@/__tests__/helpers/newest-per-type-mock")).newestPerTypeMock(),
 *   );
 */
import { prisma } from "@/lib/db";
import type {
  NewestPerTypeRead,
  NewestPerTypeRow,
} from "@/lib/measurements/newest-per-type";
import type { MeasurementType } from "@/generated/prisma/client";

type LooseRow = Partial<NewestPerTypeRow> & {
  type: string;
  value: number;
  measuredAt: Date;
};

export function newestPerTypeMock() {
  let lastServed: Promise<NewestPerTypeRow[]> = Promise.resolve([]);

  async function readNewestRowsPerType(
    userId: string,
    types: readonly MeasurementType[],
    options: { perTypeCap: number; totalCap?: number; since?: Date | null },
  ): Promise<NewestPerTypeRead> {
    const wanted = [...new Set(types)];
    if (wanted.length === 0) {
      lastServed = Promise.resolve([]);
      return { rows: [], cappedTypes: [] };
    }
    const since = options.since ?? null;
    const served = (
      prisma.measurement.findMany({
        where: {
          userId,
          type: { in: wanted },
          deletedAt: null,
          ...(since ? { measuredAt: { gte: since } } : {}),
        },
        orderBy: { measuredAt: "desc" },
        // A read with a total returns at most that many rows.
        ...(options.totalCap !== undefined ? { take: options.totalCap } : {}),
      }) as unknown as Promise<LooseRow[] | undefined>
    ).then((rows) =>
      (rows ?? []).map((r): NewestPerTypeRow => ({
        type: r.type as MeasurementType,
        value: r.value,
        measuredAt: r.measuredAt,
        source: r.source ?? ("MANUAL" as NewestPerTypeRow["source"]),
        deviceType: r.deviceType ?? null,
        sleepStage: r.sleepStage ?? null,
        glucoseContext: r.glucoseContext ?? null,
      })),
    );
    lastServed = served;
    const rows = await served;
    const perType = new Map<string, NewestPerTypeRow[]>();
    for (const row of rows) {
      if (!wanted.includes(row.type)) continue;
      const list = perType.get(row.type) ?? [];
      list.push(row);
      perType.set(row.type, list);
    }
    const ranked: Array<{ row: NewestPerTypeRow; rank: number }> = [];
    const readOf = new Map<string, number>();
    for (const type of wanted) {
      const list = [...(perType.get(type) ?? [])]
        .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime())
        .slice(0, options.perTypeCap);
      readOf.set(type, list.length);
      list.forEach((row, i) => ranked.push({ row, rank: i + 1 }));
    }
    if (options.totalCap !== undefined) {
      ranked.sort(
        (a, b) =>
          a.rank - b.rank ||
          b.row.measuredAt.getTime() - a.row.measuredAt.getTime() ||
          a.row.type.localeCompare(b.row.type),
      );
      ranked.splice(options.totalCap);
    }
    const kept = ranked.map((r) => r.row);
    const keptOf = new Map<string, number>();
    for (const row of kept) {
      keptOf.set(row.type, (keptOf.get(row.type) ?? 0) + 1);
    }
    const cappedTypes = wanted.filter((t) => {
      const n = keptOf.get(t) ?? 0;
      return n >= options.perTypeCap || n < (readOf.get(t) ?? 0);
    });
    kept.sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
    return { rows: kept, cappedTypes };
  }

  async function readLiveMeasurementSpan(): Promise<{
    oldest: Date | null;
    newest: Date | null;
  }> {
    const rows = await lastServed;
    if (rows.length === 0) return { oldest: null, newest: null };
    const times = rows.map((r) => r.measuredAt.getTime());
    return {
      oldest: new Date(Math.min(...times)),
      newest: new Date(Math.max(...times)),
    };
  }

  return { readNewestRowsPerType, readLiveMeasurementSpan };
}
