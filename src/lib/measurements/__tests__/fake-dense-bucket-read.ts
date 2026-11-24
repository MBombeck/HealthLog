/**
 * An in-memory stand-in for `dense-bucket-read.ts`, for unit tests that hand
 * their readings to a mocked `measurement.findMany`.
 *
 * The real module folds in Postgres. This fake asks the test's own row source
 * for the rows the statement would scan (the same `where` shape a row read of
 * that window would send) and folds them with the same rules in JavaScript:
 * raw rows only for the bucket reads, and the account's wall clock for local
 * placement. A unit test
 * keeps its fixture of rows and still exercises the caller's logic; the SQL
 * itself is pinned against a real database in
 * `tests/integration/dense-day-readers.test.ts`.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type {
  DenseBucket,
  ElapsedBucket,
  HourCell,
  LocalMinuteBucket,
} from "@/lib/measurements/dense-bucket-read";
import { formatInUserTz, userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

interface FakeRow {
  value: number;
  measuredAt: Date;
  externalId?: string | null;
  source?: string;
  deviceType?: string | null;
}

type RowSource = (args: {
  where: Record<string, unknown>;
}) => Promise<FakeRow[]> | FakeRow[];

const isRaw = (r: FakeRow) => !r.externalId?.startsWith("stats:");

function fold<K>(rows: readonly FakeRow[], keyOf: (r: FakeRow) => K) {
  const out = new Map<K, DenseBucket>();
  for (const r of rows) {
    const k = keyOf(r);
    const b = out.get(k);
    if (b) {
      b.n += 1;
      b.sum += r.value;
      b.min = Math.min(b.min, r.value);
      b.max = Math.max(b.max, r.value);
    } else {
      out.set(k, { n: 1, sum: r.value, min: r.value, max: r.value });
    }
  }
  return out;
}

function minuteOfDay(d: Date, tz: string): number {
  const [, clock] = formatInUserTz(d, tz, "datetime").split(" ");
  const [hh, mm] = clock.split(":");
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

export function makeFakeDenseBucketRead(source: RowSource) {
  const read = async (where: Record<string, unknown>) =>
    (await source({ where })) ?? [];
  return {
    async readLocalDayMinuteBuckets(opts: {
      userId: string;
      type: MeasurementType;
      dateKey: string;
      timeZone: string;
      bucketMinutes: number;
      sources?: readonly string[];
    }): Promise<LocalMinuteBucket[]> {
      const { dayStart, dayEnd } = localDayWindow(opts.dateKey, opts.timeZone);
      const rows = (
        await read({
          userId: opts.userId,
          type: opts.type,
          deletedAt: null,
          measuredAt: { gte: dayStart, lt: dayEnd },
        })
      )
        .filter(isRaw)
        // A fixture row without a source stands for a sample.
        .filter(
          (r) =>
            !opts.sources ||
            r.source === undefined ||
            opts.sources.includes(r.source),
        )
        .filter(
          (r) => userDayKey(r.measuredAt, opts.timeZone) === opts.dateKey,
        );
      const buckets = fold(
        rows,
        (r) =>
          Math.floor(
            minuteOfDay(r.measuredAt, opts.timeZone) / opts.bucketMinutes,
          ) * opts.bucketMinutes,
      );
      return [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([startMinute, b]) => ({ startMinute, ...b }));
    },

    async readElapsedBuckets(opts: {
      userId: string;
      type: MeasurementType;
      from: Date;
      to: Date;
      originMs: number;
      spanSec: number;
      bucketSec: number;
    }): Promise<{ buckets: ElapsedBucket[]; windowCount: number }> {
      const rows = (
        await read({
          userId: opts.userId,
          type: opts.type,
          deletedAt: null,
          measuredAt: { gte: opts.from, lte: opts.to },
        })
      ).filter(isRaw);
      const inSession = rows.filter((r) => {
        const rel = r.measuredAt.getTime() - opts.originMs;
        return rel >= 0 && rel < opts.spanSec * 1000;
      });
      const buckets = fold(inSession, (r) =>
        Math.floor(
          (r.measuredAt.getTime() - opts.originMs) / (opts.bucketSec * 1000),
        ),
      );
      return {
        windowCount: rows.length,
        buckets: [...buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, b]) => ({ index, ...b })),
      };
    },

    async readHourCells(opts: {
      userId: string;
      type: MeasurementType;
      since: Date;
      timeZone: string;
      summed: boolean;
      bySource: boolean;
    }): Promise<HourCell[]> {
      const rows = [
        ...(await read({
          userId: opts.userId,
          type: opts.type,
          deletedAt: null,
          measuredAt: { gte: opts.since },
        })),
      ].sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
      const cells = new Map<
        string,
        { first: FakeRow; n: number; sum: number }
      >();
      for (const r of rows) {
        const hour = formatInUserTz(
          r.measuredAt,
          opts.timeZone,
          "datetime",
        ).slice(0, 13);
        const key = opts.bySource
          ? `${hour}|${r.source ?? ""}|${r.deviceType ?? ""}`
          : hour;
        const cell = cells.get(key);
        if (cell) {
          cell.n += 1;
          cell.sum += r.value;
        } else {
          cells.set(key, { first: r, n: 1, sum: r.value });
        }
      }
      return [...cells.values()].map(({ first, n, sum }) => ({
        measuredAt: first.measuredAt,
        value: opts.summed ? sum : sum / n,
        n,
        source: opts.bySource
          ? ((first.source ?? null) as HourCell["source"])
          : null,
        deviceType: opts.bySource ? (first.deviceType ?? null) : null,
      }));
    },

    async countReadingsUpTo(opts: {
      userId: string;
      type: MeasurementType;
      since: Date;
      cap: number;
    }): Promise<number> {
      const rows = await read({
        userId: opts.userId,
        type: opts.type,
        deletedAt: null,
        measuredAt: { gte: opts.since },
      });
      return Math.min(rows.length, opts.cap + 1);
    },
  };
}
