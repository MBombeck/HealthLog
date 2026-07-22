/**
 * Keyset-paginated measurement readers for export surfaces.
 *
 * Pages are ordered by `measuredAt desc, id desc`. The `id` tie-breaker makes
 * the keyset cursor total when measurements share a timestamp. Consumers own
 * one page at a time; advancing the iterator releases the previous page before
 * the next database request begins.
 */
import type {
  Prisma,
  PrismaClient,
  SleepStage,
} from "@/generated/prisma/client";
import {
  formatMeasurementsForExport,
  type ExportableRecord,
} from "@/lib/export";
import { shapeMeasurementNotes } from "@/lib/crypto/note-cipher";
import type { GlucoseUnit } from "@/lib/glucose";
import { userDayKey } from "@/lib/tz/format";

export const MEASUREMENT_EXPORT_PAGE_SIZE = 10_000;

type MeasurementPayload<S extends Prisma.MeasurementSelect> =
  Prisma.MeasurementGetPayload<{ select: S }>;

/**
 * Yield bounded measurement pages. Empty terminal pages are not exposed.
 *
 * A full page advances with an `id` cursor and `skip: 1`; a short page ends
 * iteration without another query. Database failures are deliberately not
 * caught so response streams and backup builders observe the original error.
 */
export async function* iterateMeasurementPages<
  S extends Prisma.MeasurementSelect & { id: true },
>(
  db: PrismaClient,
  where: Prisma.MeasurementWhereInput,
  select: S,
  pageSize: number = MEASUREMENT_EXPORT_PAGE_SIZE,
): AsyncGenerator<Array<MeasurementPayload<S>>, void, void> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError(
      "Measurement export page size must be a positive integer",
    );
  }

  let cursorId: string | null = null;
  for (;;) {
    let page = (await db.measurement.findMany({
      where,
      orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
      take: pageSize,
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select,
    })) as Array<MeasurementPayload<S>>;

    if (page.length === 0) return;

    const isLastPage = page.length < pageSize;
    const lastRow: unknown = page[page.length - 1];
    if (
      lastRow === null ||
      typeof lastRow !== "object" ||
      !("id" in lastRow) ||
      typeof lastRow.id !== "string"
    ) {
      throw new TypeError("Measurement export page is missing its cursor id");
    }
    const nextCursorId = lastRow.id;
    yield page;

    // Drop the array reference before awaiting the next query. Consumers may
    // retain rows intentionally, but the pager itself never retains a prior
    // page or combines pages into an all-history result.
    page = [];
    if (isLastPage) return;
    cursorId = nextCursorId;
  }
}

const SLEEP_SESSION_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * Turn database pages into formatter-safe chunks.
 *
 * Raw exports can release every page immediately. Night-granularity exports
 * must keep all sleep sessions assigned to one local wake day together so
 * `formatMeasurementsForExport` can select the same main night and naps as the
 * historical all-at-once formatter. The carry is released once iteration has
 * moved to an older local day and more than the sleep-session gap before the
 * earliest carried sleep-segment start. Non-sleep-only pages never enter it.
 */
export async function* groupMeasurementPagesForExport<
  T extends { type: string; value: number; measuredAt: Date },
>(
  pages: AsyncIterable<readonly T[]>,
  userTz: string,
  granularity: "night" | "raw",
): AsyncGenerator<readonly T[], void, void> {
  if (granularity === "raw") {
    for await (const page of pages) {
      if (page.length > 0) yield page;
    }
    return;
  }

  let carry: T[] = [];
  let carryWakeDay: string | null = null;
  let earliestSleepStartAtMs: number | null = null;

  for await (const page of pages) {
    let ready: T[] = [];

    for (const row of page) {
      const rowAtMs = row.measuredAt.getTime();
      if (
        carry.length > 0 &&
        carryWakeDay !== null &&
        earliestSleepStartAtMs !== null &&
        earliestSleepStartAtMs - rowAtMs > SLEEP_SESSION_GAP_MS &&
        userDayKey(row.measuredAt, userTz) < carryWakeDay
      ) {
        if (ready.length > 0) {
          yield ready;
          ready = [];
        }
        yield carry;
        carry = [];
        carryWakeDay = null;
        earliestSleepStartAtMs = null;
      }

      if (carry.length === 0 && row.type !== "SLEEP_DURATION") {
        ready.push(row);
        continue;
      }

      if (ready.length > 0) {
        yield ready;
        ready = [];
      }
      carry.push(row);
      if (row.type === "SLEEP_DURATION") {
        carryWakeDay ??= userDayKey(row.measuredAt, userTz);
        const rowStartAtMs =
          rowAtMs - (Number.isFinite(row.value) ? row.value : 0) * 60_000;
        earliestSleepStartAtMs =
          earliestSleepStartAtMs === null
            ? rowStartAtMs
            : Math.min(earliestSleepStartAtMs, rowStartAtMs);
      }
    }

    if (ready.length > 0) yield ready;
  }

  if (carry.length > 0) yield carry;
}

export interface MeasurementPageFormatOptions {
  granularity: "night" | "raw";
  sourcePriorityJson: unknown;
  glucoseUnit: GlucoseUnit;
}

/**
 * Decrypt and format one safe measurement chunk at a time. Each yielded array
 * is ready for CSV or JSON framing and can be released after serialization.
 */
export async function* formatMeasurementPageChunks<
  T extends {
    type: string;
    value: number;
    unit: string;
    measuredAt: Date;
    source: string;
    notes: string | null;
    notesEncrypted: Uint8Array | null;
    glucoseContext?: string | null;
    sleepStage?: SleepStage | null;
    deviceType?: string | null;
  },
>(
  pages: AsyncIterable<readonly T[]>,
  userTz: string,
  options: MeasurementPageFormatOptions,
): AsyncGenerator<ExportableRecord[], void, void> {
  const groupedPages = groupMeasurementPagesForExport(
    pages,
    userTz,
    options.granularity,
  );
  for await (const page of groupedPages) {
    const records = formatMeasurementsForExport(
      page.map(shapeMeasurementNotes),
      userTz,
      {
        granularity: options.granularity,
        sleepTz: userTz,
        sourcePriorityJson: options.sourcePriorityJson,
        glucoseUnit: options.glucoseUnit,
      },
    );
    if (records.length > 0) yield records;
  }
}
