/**
 * One batch of the Android Health Connect sync: records, aggregates and
 * deletes onto rows, through the export import's own mapper and write path
 * (`@/lib/import/health-connect/{records,sink}`).
 *
 * Every item answers one result at its index. A record that becomes several
 * rows (a blood-pressure pair, a heart-rate series, a sleep session's stages)
 * answers once: `inserted` when any row was new, else `updated`, else
 * `unchanged`, else `skipped` with the first reason.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import {
  HealthConnectSink,
  HC_SOURCE,
  type PendingRow,
  type RowOutcome,
} from "@/lib/import/health-connect/sink";
import {
  DAILY_METRIC_TYPE,
  mapHourlyPulse,
  mapLiveRecord,
} from "@/lib/import/health-connect/records";
import { importValue } from "@/lib/integrations/import-value";
import { hcExternalId } from "@/lib/import/health-connect/mapper";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import {
  HC_SYNC_RECORD_TYPES,
  hcAggregateSchema,
  hcRecordId,
  hcRecordSchema,
  type HcItemStatus,
} from "@/lib/validations/health-connect-sync";
import { deleteSourceWorkouts } from "@/lib/workouts/delete-by-external-ids";

/** Rows per write statement batch, as the export import writes them. */
const WRITE_BATCH = 500;

export interface HcItemResult {
  kind: "record" | "aggregate" | "delete";
  index: number;
  status: HcItemStatus;
  reason?: string;
}

export interface HcBatchInput {
  userId: string;
  timezone: string;
  records: readonly unknown[];
  aggregates: readonly unknown[];
  deletes: readonly unknown[];
  /** Packages whose records arrive through a direct integration. */
  skipPackages: ReadonlySet<string>;
}

export interface HcBatchOutcome {
  results: HcItemResult[];
  accepted: number;
  rejected: number;
  /** Whether a row of a type the stall rule counts landed or was confirmed. */
  delivered: boolean;
}

const WANTED = new Set<string>(HC_SYNC_RECORD_TYPES);

/** The verdict of a record from the verdicts of its rows. */
function combine(outcomes: readonly RowOutcome[], extraSkips: string[]) {
  if (outcomes.some((o) => o.status === "inserted"))
    return { status: "inserted" as const };
  if (outcomes.some((o) => o.status === "updated"))
    return { status: "updated" as const };
  if (outcomes.some((o) => o.status === "unchanged"))
    return { status: "unchanged" as const };
  const reason =
    outcomes.find(
      (o): o is Extract<RowOutcome, { status: "skipped" }> =>
        o.status === "skipped",
    )?.reason ??
    extraSkips[0] ??
    "no_value";
  return { status: "skipped" as const, reason };
}

/** One batch's shared state while its three parts are written. */
interface BatchRun {
  sink: HealthConnectSink;
  input: HcBatchInput;
  results: HcItemResult[];
  touched: Array<{ type: MeasurementType; measuredAt: Date }>;
  delivered: boolean;
}

export async function ingestHealthConnectBatch(
  input: HcBatchInput,
  prisma: PrismaClient = defaultPrisma,
): Promise<HcBatchOutcome> {
  const run: BatchRun = {
    sink: new HealthConnectSink(prisma, input.userId),
    input,
    results: [],
    touched: [],
    delivered: false,
  };
  await writeRecords(run);
  await writeAggregates(run);
  await writeDeletes(run, prisma);
  const { results, touched, delivered } = run;

  if (touched.length > 0) {
    await afterMeasurementMutation(input.userId, touched, { source: "sync" });
  }

  const order = { record: 0, aggregate: 1, delete: 2 } as const;
  results.sort((a, b) => order[a.kind] - order[b.kind] || a.index - b.index);
  const rejected = results.filter((r) => r.status === "rejected").length;
  return { results, accepted: results.length - rejected, rejected, delivered };
}

async function writeRecords(run: BatchRun): Promise<void> {
  // ── Records ───────────────────────────────────────────────────────────
  // Rows of every record, written in two streams (spot readings take the
  // cross-source check, dense rows do not), each remembered by its record.
  const spot: Array<{ row: PendingRow; record: number }> = [];
  const dense: Array<{ row: PendingRow; record: number }> = [];
  const workouts: Array<{
    index: number;
    workout: Parameters<HealthConnectSink["writeWorkouts"]>[0][number];
  }> = [];
  const pendingRecords = new Map<number, string[]>();
  run.input.records.forEach((raw, index) => {
    const type =
      typeof raw === "object" && raw !== null && "type" in raw
        ? (raw as { type: unknown }).type
        : undefined;
    if (typeof type === "string" && !WANTED.has(type)) {
      run.results.push({
        kind: "record",
        index,
        status: "skipped",
        reason: "type_not_wanted",
      });
      return;
    }
    const parsed = hcRecordSchema.safeParse(raw);
    if (!parsed.success) {
      run.results.push({
        kind: "record",
        index,
        status: "rejected",
        reason: "malformed",
      });
      return;
    }
    const record = parsed.data;
    if (record.package && run.input.skipPackages.has(record.package)) {
      run.results.push({
        kind: "record",
        index,
        status: "skipped",
        reason: "skipped_package",
      });
      return;
    }
    const mapped = mapLiveRecord(record);
    if (mapped.kind === "workout") {
      if (mapped.workout.end <= mapped.workout.start) {
        run.results.push({
          kind: "record",
          index,
          status: "rejected",
          reason: "malformed",
        });
        return;
      }
      workouts.push({ index, workout: mapped.workout });
      return;
    }
    pendingRecords.set(index, mapped.skipped);
    const target = mapped.sameReadingCheck ? spot : dense;
    for (const row of mapped.rows) target.push({ row, record: index });
  });

  const rowOutcomes = new Map<number, RowOutcome[]>();
  const note = (record: number, outcome: RowOutcome, row: PendingRow) => {
    const list = rowOutcomes.get(record) ?? [];
    list.push(outcome);
    rowOutcomes.set(record, list);
    if (outcome.status === "inserted" || outcome.status === "updated") {
      run.touched.push({ type: row.type, measuredAt: row.measuredAt });
    }
    if (outcome.status !== "skipped") run.delivered = true;
  };
  for (const [stream, sameReadingCheck] of [
    [spot, true],
    [dense, false],
  ] as const) {
    for (let at = 0; at < stream.length; at += WRITE_BATCH) {
      const chunk = stream.slice(at, at + WRITE_BATCH);
      const outcomes = await run.sink.writeRows(
        chunk.map((c) => c.row),
        { sameReadingCheck, hourlyPulse: false },
      );
      chunk.forEach((c, i) => note(c.record, outcomes[i]!, c.row));
    }
  }
  for (const [index, skipped] of pendingRecords) {
    run.results.push({
      kind: "record",
      index,
      ...combine(rowOutcomes.get(index) ?? [], skipped),
    });
  }
  if (workouts.length > 0) {
    const outcomes = await run.sink.writeWorkouts(
      workouts.map((w) => w.workout),
    );
    workouts.forEach((w, i) => {
      const o = outcomes[i]!;
      run.results.push({
        kind: "record",
        index: w.index,
        status: o.status as HcItemStatus,
      });
      if (o.status !== "skipped") run.delivered = true;
    });
    if (outcomes.some((o) => o.status === "inserted")) {
      invalidateUserMeasurements(run.input.userId);
    }
  }
}

async function writeAggregates(run: BatchRun): Promise<void> {
  // ── Aggregates ────────────────────────────────────────────────────────
  const days = new Map<
    MeasurementType,
    Array<{ index: number; dayKey: string; value: number; computedAt?: Date }>
  >();
  const hourly: Array<{ index: number; row: PendingRow }> = [];
  run.input.aggregates.forEach((raw, index) => {
    const parsed = hcAggregateSchema.safeParse(raw);
    if (!parsed.success) {
      const metric =
        typeof raw === "object" && raw !== null && "metric" in raw
          ? (raw as { metric: unknown }).metric
          : undefined;
      const known =
        metric === "HEART_RATE_BPM" ||
        (typeof metric === "string" && metric in DAILY_METRIC_TYPE);
      run.results.push(
        typeof metric === "string" && !known
          ? {
              kind: "aggregate",
              index,
              status: "skipped",
              reason: "type_not_wanted",
            }
          : {
              kind: "aggregate",
              index,
              status: "rejected",
              reason: "malformed",
            },
      );
      return;
    }
    const agg = parsed.data;
    if (agg.metric === "HEART_RATE_BPM") {
      hourly.push({ index, row: mapHourlyPulse(agg) });
      return;
    }
    const { type, factor } = DAILY_METRIC_TYPE[agg.metric];
    const list = days.get(type) ?? [];
    list.push({
      index,
      dayKey: agg.day,
      value: importValue(agg.value * factor),
      ...(agg.computedAt ? { computedAt: new Date(agg.computedAt) } : {}),
    });
    days.set(type, list);
  });
  for (const [type, list] of days) {
    for (let at = 0; at < list.length; at += WRITE_BATCH) {
      const chunk = list.slice(at, at + WRITE_BATCH);
      const { outcomes, measuredAt } = await run.sink.writeDayTotals(
        type,
        chunk,
        run.input.timezone,
      );
      chunk.forEach((d, i) => {
        const o = outcomes[i]!;
        run.results.push({ kind: "aggregate", index: d.index, ...o });
        if (o.status === "inserted" || o.status === "updated") {
          run.touched.push({ type, measuredAt: measuredAt[i]! });
        }
        if (o.status !== "skipped") run.delivered = true;
      });
    }
  }
  for (let at = 0; at < hourly.length; at += WRITE_BATCH) {
    const chunk = hourly.slice(at, at + WRITE_BATCH);
    const outcomes = await run.sink.writeRows(
      chunk.map((h) => h.row),
      { sameReadingCheck: false, hourlyPulse: true },
    );
    chunk.forEach((h, i) => {
      const o = outcomes[i]!;
      run.results.push({ kind: "aggregate", index: h.index, ...o });
      if (o.status === "inserted" || o.status === "updated") {
        run.touched.push({ type: h.row.type, measuredAt: h.row.measuredAt });
      }
    });
  }
}

async function writeDeletes(
  run: BatchRun,
  prisma: PrismaClient,
): Promise<void> {
  // ── Deletes ───────────────────────────────────────────────────────────
  const ids: Array<{ index: number; id: string }> = [];
  run.input.deletes.forEach((raw, index) => {
    const parsed = hcRecordId.safeParse(raw);
    if (parsed.success) ids.push({ index, id: parsed.data });
    else
      run.results.push({
        kind: "delete",
        index,
        status: "rejected",
        reason: "malformed",
      });
  });
  if (ids.length > 0) {
    const deleted = await deleteRecords(
      prisma,
      run.input.userId,
      ids.map((d) => d.id),
      run.touched,
    );
    for (const { index, id } of ids) {
      run.results.push({
        kind: "delete",
        index,
        status: deleted.has(id) ? "deleted" : "not_found",
      });
    }
  }
}

/**
 * Soft-delete the rows the listed records became: `hc:<uuid>` and every
 * `hc:<uuid>:<n>` row (heart-rate samples, sleep stages) of this source, and
 * the workout of that id. Answers the ids that removed anything; pushes the
 * removed rows' identities onto `touched` for the rollup tail.
 */
async function deleteRecords(
  prisma: PrismaClient,
  userId: string,
  uuids: readonly string[],
  touched: Array<{ type: MeasurementType; measuredAt: Date }>,
): Promise<Set<string>> {
  const unique = [...new Set(uuids)];
  const where = {
    userId,
    source: HC_SOURCE,
    deletedAt: null,
    OR: unique.flatMap((uuid) => [
      { externalId: hcExternalId(uuid) },
      { externalId: { startsWith: `${hcExternalId(uuid)}:` } },
    ]),
  };
  const rows = await prisma.measurement.findMany({
    where,
    select: { id: true, type: true, measuredAt: true, externalId: true },
  });
  const hit = new Set<string>();
  if (rows.length > 0) {
    await prisma.measurement.updateMany({
      where: { userId, id: { in: rows.map((r) => r.id) }, deletedAt: null },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    invalidateUserMeasurements(userId);
    for (const r of rows) {
      touched.push({ type: r.type, measuredAt: r.measuredAt });
      // `hc:<uuid>` or `hc:<uuid>:<n>`: the uuid is the second segment.
      const uuid = r.externalId?.split(":")[1];
      if (uuid) hit.add(uuid);
    }
  }
  const workouts = await deleteSourceWorkouts(
    userId,
    unique.map((uuid) => hcExternalId(uuid)),
    HC_SOURCE,
  );
  for (const externalId of workouts.deletedExternalIds) {
    const uuid = externalId.split(":")[1];
    if (uuid) hit.add(uuid);
  }
  return hit;
}
