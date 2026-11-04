/**
 * Maintenance of the `measurements` table (v1.42).
 *
 * `VACUUM (ANALYZE)` and a `REINDEX INDEX CONCURRENTLY` per index, largest
 * first, after the compaction-tombstone purge has shrunk the table. Neither
 * statement can run inside a transaction, so this is a job rather than a
 * Prisma migration. Runbook: `docs/ops/measurement-maintenance.md`.
 *
 * Two ways in:
 *   - The operator, from `POST /api/admin/maintenance/measurements`
 *     (cookie-only admin), with the steps named; the rebuild only ever runs
 *     this way, in a window the operator picks.
 *   - The nightly check (`MEASUREMENT_MAINTENANCE_CRON`, a tick without
 *     steps). It measures and never acts. Vacuuming the table is
 *     autovacuum's job, at the 5 % dead-row threshold migration 0412 gives
 *     the table; a second trigger here at 10 % never fired before autovacuum
 *     had already run, and two mechanisms for one task only hide which of
 *     them is doing it. The check warns when the dead rows pass
 *     `AUTOVACUUM_BEHIND_SHARE`, which means autovacuum is not keeping up
 *     (a long transaction holding it back, too few workers), and when the
 *     heap has grown past its live rows (`TableHealth.bloatFactor`) further
 *     than `TABLE_BLOAT_WARN_FACTOR`, which only a rewrite (`VACUUM FULL`,
 *     which locks the table) gives back.
 *
 * Why the indexes: after the purge the heap is small, but a B-tree does not
 * give back the pages its deleted entries held. VACUUM marks the heap space
 * reusable and refreshes the planner statistics; only a rebuild returns the
 * index space. `CONCURRENTLY` keeps reads and writes going during the
 * rebuild; the price is a second pass over the table and, for a while, the
 * disk for one more copy of the index being rebuilt.
 *
 * Safeguards:
 *   - One run at a time: the queue is `exclusive` on a fixed singleton key,
 *     and the run holds a session advisory lock besides (`withJobLock`), so a
 *     delivery that outlived its expiry never runs beside its retry.
 *   - It refuses to start while the compaction-tombstone purge is queued or
 *     running: rebuilding indexes under a bulk delete rebuilds them twice.
 *   - It runs on a connection of its own with no statement timeout (the app
 *     pool's 60 s would kill the first REINDEX), a session-only
 *     `maintenance_work_mem`, and a lock timeout, so a rebuild that cannot get
 *     its lock fails instead of queueing writers behind it.
 *   - One index at a time, largest first. A failed rebuild leaves an invalid
 *     `<index>_ccnew` copy behind; it is dropped at once, and the pass stops
 *     there rather than trying the next index on a disk that just ran out.
 *     Leftover invalid copies from an earlier, interrupted run are dropped
 *     before the first rebuild.
 *   - Every step's size before and after, and its duration, are on the run's
 *     wide event; the totals are job facts.
 *
 * Retired indexes. An index the schema no longer declares is dropped by the
 * migration that retires it only when the lock is there at once (a `DO`
 * block with a two-second `lock_timeout` that swallows the timeout), so the
 * boot never waits on a long reader of the table. Where the migration had to
 * leave it, every run of this job, the nightly tick included, drops it with
 * `DROP INDEX CONCURRENTLY IF EXISTS` under a bounded lock wait and tries
 * again the next night if the wait runs out. Runbook:
 * `docs/ops/measurement-maintenance.md`, "Retired indexes".
 */
import { Client } from "pg";
import type { Job } from "pg-boss";
import { sessionOptionsDisabled } from "@/lib/db";

import { withJobLock } from "@/lib/jobs/job-lock";
import {
  CONCURRENT_COPY,
  RETIRED_MEASUREMENT_INDEXES as RETIRED_INDEXES_SHARED,
} from "@/lib/jobs/retired-measurement-indexes.mjs";
import {
  jobDone,
  jobFailed,
  percentFact,
  wholeFact,
  type JobOutcome,
} from "@/lib/jobs/job-outcome";
import { reportJobRun, type JobRunCandidate } from "@/lib/jobs/job-run-report";
import { withBackgroundEvent } from "@/lib/logging/background";
import { logCaught } from "@/lib/logging/signal";

export const MEASUREMENT_MAINTENANCE_QUEUE = "measurement-maintenance";

/** The singleton key every send carries (the queue is `exclusive`). */
export const MEASUREMENT_MAINTENANCE_SINGLETON_KEY = "measurement-maintenance";

/**
 * A REINDEX of the largest index on a big instance takes well past pg-boss's
 * default fifteen minutes. One-shot: a retry would start the pass over beside
 * a half-finished one, so the operator re-triggers instead.
 */
export const MEASUREMENT_MAINTENANCE_SEND_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 6 * 60 * 60,
  singletonKey: MEASUREMENT_MAINTENANCE_SINGLETON_KEY,
} as const;

/** Which steps the operator asked for. The nightly tick names none. */
export interface MeasurementMaintenancePayload {
  vacuum?: boolean;
  reindex?: boolean;
}

/** The steps a run takes, once resolved. */
export interface MaintenanceSteps {
  vacuum: boolean;
  reindex: boolean;
}

/** 03:40 Europe/Berlin, inside the nightly maintenance band. */
export const MEASUREMENT_MAINTENANCE_CRON = "40 3 * * *";

/** The dead-row share at which autovacuum starts on the table (0412). */
export const AUTOVACUUM_SCALE_FACTOR = 0.05;

/**
 * Dead rows, as a share of live ones, past which the nightly check warns
 * that autovacuum is behind: four times its own threshold.
 */
export const AUTOVACUUM_BEHIND_SHARE = 4 * AUTOVACUUM_SCALE_FACTOR;

/** Fewer dead rows than this are never worth a warning. */
export const DEAD_ROW_WARN_FLOOR = 10_000;

/**
 * Heap size against what the live rows need, past which the run warns that
 * only a rewrite gives the space back.
 */
export const TABLE_BLOAT_WARN_FACTOR = 3;

/** Bytes a heap row costs beyond its data: header, item pointer, alignment. */
const ROW_OVERHEAD_BYTES = 28;

/** The fill factor migration 0412 gives the table. */
const FILL_FACTOR = 0.85;

/** What the statistics say about the table's heap. */
export interface TableHealth {
  liveRows: number;
  deadRows: number;
  heapBytes: number;
  /**
   * Heap bytes over what the live rows need at the planner's average row
   * width and the table's fill factor; null before the table has statistics.
   */
  bloatFactor: number | null;
}

/**
 * Session settings of the maintenance connection.
 *
 * `max_parallel_maintenance_workers=0` keeps VACUUM and the index rebuild in
 * one process. A parallel run shares its `maintenance_work_mem` through
 * dynamic shared memory in `/dev/shm`, which Docker caps at 64 MB unless the
 * container sets `shm_size`; a 128 MB budget then fails at once with
 * "could not resize shared memory segment ... No space left on device".
 * One process needs no shared segment, so the run works on any host,
 * whatever its container settings.
 */
export const MAINTENANCE_SESSION_OPTIONS =
  "-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c maintenance_work_mem=128MB -c max_parallel_maintenance_workers=0 -c lock_timeout=300000 -c TimeZone=UTC";

/**
 * The same settings as `SET` statements, for a host behind a connection
 * pooler that refuses the `options` startup parameter
 * (`DATABASE_SESSION_OPTIONS_DISABLED`). Built from the constant above, whose
 * every value is a literal, so nothing user-supplied reaches the SQL.
 */
export function maintenanceSessionStatements(): string[] {
  return MAINTENANCE_SESSION_OPTIONS.split(/\s*-c\s+/)
    .filter(Boolean)
    .map((pair) => {
      const [name, value] = pair.trim().split("=");
      return `SET ${name} = '${value}'`;
    });
}

/**
 * Indexes on `measurements` the schema no longer declares, which a run drops
 * when the migration that retired them could not. The list lives in a plain
 * module because the boot step `scripts/db-app-role.mjs` reads it too.
 */
export const RETIRED_MEASUREMENT_INDEXES: readonly string[] =
  RETIRED_INDEXES_SHARED;

/** How long a run waits for the locks that drop a retired index. */
export const RETIRED_INDEX_LOCK_TIMEOUT = "60s";

const LOCK_TIMEOUT_VALUE = /^\d{1,6}(ms|s)$/;

/** The only shape an index name may have before it is spliced into SQL. */
const INDEX_NAME = /^[a-z0-9_]{1,63}$/;

const PURGE_QUEUE = "compaction-tombstone-purge";

export interface MaintenanceStep {
  step: "vacuum" | "reindex" | "drop_invalid" | "drop_retired";
  target: string;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface MeasurementMaintenanceSummary {
  outcome:
    | "completed"
    | "nothing_due"
    | "refused_purge_running"
    | "already_running"
    | "failed";
  steps: MaintenanceStep[];
  tableBytesBefore: number;
  tableBytesAfter: number;
  indexBytesBefore: number;
  indexBytesAfter: number;
  /**
   * Retired indexes and invalid rebuild copies the run found but may not
   * drop, because it does not connect as the table's owner. The next start
   * drops them as the owner (`scripts/db-app-role.mjs`).
   */
  dropsLeftForBoot: string[];
}

interface IndexRow {
  name: string;
  bytes: string;
  valid: boolean;
}

/** What the pass needs from a connection: one query method. */
export type MaintenanceConnection = Pick<Client, "query">;

async function relationSizes(
  db: MaintenanceConnection,
): Promise<{ table: number; indexes: number }> {
  const { rows } = await db.query<{ table: string; indexes: string }>(
    `SELECT pg_total_relation_size('measurements'::regclass)::text AS "table",
            pg_indexes_size('measurements'::regclass)::text AS "indexes"`,
  );
  return {
    table: Number(rows[0]?.table ?? 0),
    indexes: Number(rows[0]?.indexes ?? 0),
  };
}

/** The table's heap as the statistics collector and the planner see it. */
export async function tableHealth(
  db: MaintenanceConnection,
): Promise<TableHealth> {
  const { rows } = await db.query<{
    live: string;
    dead: string;
    heap: string;
    width: string | null;
  }>(
    `SELECT s.n_live_tup::text AS live,
            s.n_dead_tup::text AS dead,
            pg_relation_size('measurements'::regclass)::text AS heap,
            (SELECT sum(avg_width)::text FROM pg_stats
              WHERE schemaname = s.schemaname AND tablename = 'measurements') AS width
       FROM pg_stat_user_tables s
      WHERE s.relid = 'measurements'::regclass`,
  );
  const liveRows = Number(rows[0]?.live ?? 0);
  const heapBytes = Number(rows[0]?.heap ?? 0);
  const width = Number(rows[0]?.width ?? 0);
  const needed = (liveRows * (width + ROW_OVERHEAD_BYTES)) / FILL_FACTOR;
  return {
    liveRows,
    deadRows: Number(rows[0]?.dead ?? 0),
    heapBytes,
    bloatFactor:
      liveRows > 0 && width > 0
        ? Math.round((heapBytes / needed) * 10) / 10
        : null,
  };
}

/** Whether the dead rows say autovacuum is not keeping up with the table. */
export function autovacuumBehind(health: TableHealth): boolean {
  return (
    health.deadRows >= DEAD_ROW_WARN_FLOOR &&
    health.deadRows > health.liveRows * AUTOVACUUM_BEHIND_SHARE
  );
}

/**
 * The steps a delivery takes: the operator's as asked, none for the nightly
 * tick, which only measures.
 */
export function resolveSteps(
  payload: MeasurementMaintenancePayload | undefined,
): MaintenanceSteps {
  const named =
    typeof payload?.vacuum === "boolean" ||
    typeof payload?.reindex === "boolean";
  if (!named) return { vacuum: false, reindex: false };
  return { vacuum: payload?.vacuum ?? true, reindex: payload?.reindex ?? true };
}

async function measurementIndexes(
  db: MaintenanceConnection,
): Promise<IndexRow[]> {
  const { rows } = await db.query<IndexRow>(
    `SELECT c.relname AS name,
            pg_relation_size(c.oid)::text AS bytes,
            i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'measurements'::regclass
      ORDER BY pg_relation_size(c.oid) DESC, c.relname`,
  );
  return rows;
}

async function indexBytes(
  db: MaintenanceConnection,
  name: string,
): Promise<number> {
  const { rows } = await db.query<{ bytes: string | null }>(
    `SELECT pg_relation_size(to_regclass($1))::text AS bytes`,
    [name],
  );
  return Number(rows[0]?.bytes ?? 0);
}

function quoted(name: string): string {
  // Whitelist-spliced: catalog names only, checked against a closed shape.
  if (!INDEX_NAME.test(name)) {
    throw new Error(`refusing to splice index name of unexpected shape`);
  }
  return `"${name}"`;
}

function errorText(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return typeof code === "string" ? `${code}: ${message}` : message;
}

/**
 * Whether this connection may drop indexes on `measurements`, which only the
 * table's owner (or a member of the owning role) may. The app's restricted
 * role may not: it holds MAINTAIN on the table, which covers `VACUUM` and
 * `REINDEX` but not `DROP INDEX`. Under it the drops wait for the next start,
 * which runs them as the owner (`scripts/db-app-role.mjs`).
 */
export async function mayDropMeasurementIndexes(
  db: MaintenanceConnection,
): Promise<boolean> {
  const { rows } = await db.query<{ owns: boolean }>(
    `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS owns
       FROM pg_class c WHERE c.oid = 'measurements'::regclass`,
  );
  return rows[0]?.owns === true;
}

/** The droppable indexes present on the table: retired ones and invalid copies. */
async function indexesToDrop(db: MaintenanceConnection): Promise<string[]> {
  return (await measurementIndexes(db))
    .filter(
      (index) =>
        RETIRED_MEASUREMENT_INDEXES.includes(index.name) ||
        (!index.valid && CONCURRENT_COPY.test(index.name)),
    )
    .map((index) => index.name);
}

/** Drop the invalid copies an interrupted concurrent rebuild left behind. */
async function dropInvalidCopies(
  db: MaintenanceConnection,
  steps: MaintenanceStep[],
): Promise<void> {
  for (const index of await measurementIndexes(db)) {
    if (index.valid || !CONCURRENT_COPY.test(index.name)) continue;
    const startedAt = Date.now();
    const bytesBefore = Number(index.bytes);
    try {
      await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoted(index.name)}`);
      steps.push({
        step: "drop_invalid",
        target: index.name,
        bytesBefore,
        bytesAfter: 0,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
    } catch (err) {
      logCaught("measurements.maintenance.drop_invalid_failed", err);
      steps.push({
        step: "drop_invalid",
        target: index.name,
        bytesBefore,
        bytesAfter: bytesBefore,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: errorText(err),
      });
    }
  }
}

/**
 * Drop every retired index still present. `DROP INDEX CONCURRENTLY` takes no
 * lock that stops reads or writes, but it waits for every transaction that
 * may use the index, so the wait is bounded for the statement and the
 * session's own setting is put back after it. A timed-out drop may leave the
 * index marked invalid; the next run's `IF EXISTS` drop finishes it.
 */
export async function dropRetiredIndexes(
  db: MaintenanceConnection,
  steps: MaintenanceStep[],
  lockTimeout: string = RETIRED_INDEX_LOCK_TIMEOUT,
): Promise<void> {
  if (!LOCK_TIMEOUT_VALUE.test(lockTimeout)) {
    throw new Error(`refusing lock timeout of unexpected shape`);
  }
  for (const name of RETIRED_MEASUREMENT_INDEXES) {
    const bytesBefore = await indexBytes(db, name);
    const { rows } = await db.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [name],
    );
    if (!rows[0]?.present) continue;
    const { rows: setting } = await db.query<{ value: string }>(
      `SELECT current_setting('lock_timeout') AS value`,
    );
    const startedAt = Date.now();
    try {
      await db.query(`SET lock_timeout = '${lockTimeout}'`);
      await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoted(name)}`);
      steps.push({
        step: "drop_retired",
        target: name,
        bytesBefore,
        bytesAfter: 0,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
    } catch (err) {
      logCaught("measurements.maintenance.drop_retired_failed", err);
      steps.push({
        step: "drop_retired",
        target: name,
        bytesBefore,
        bytesAfter: await indexBytes(db, name),
        durationMs: Date.now() - startedAt,
        ok: false,
        error: errorText(err),
      });
    } finally {
      await db.query(`SELECT set_config('lock_timeout', $1, false)`, [
        setting[0]?.value ?? "0",
      ]);
    }
  }
}

/**
 * The pass itself, on a connection the caller opened with
 * {@link MAINTENANCE_SESSION_OPTIONS}. Exported for the integration test.
 */
export async function runMeasurementMaintenance(
  db: MaintenanceConnection,
  payload: MaintenanceSteps,
  options: { shouldStop?: () => boolean; retiredLockTimeout?: string } = {},
): Promise<MeasurementMaintenanceSummary> {
  const before = await relationSizes(db);
  const steps: MaintenanceStep[] = [];
  const mayDrop = await mayDropMeasurementIndexes(db);
  const summary = async (
    outcome: MeasurementMaintenanceSummary["outcome"],
    after = before,
  ): Promise<MeasurementMaintenanceSummary> => ({
    outcome,
    steps,
    tableBytesBefore: before.table,
    tableBytesAfter: after.table,
    indexBytesBefore: before.indexes,
    indexBytesAfter: after.indexes,
    dropsLeftForBoot: mayDrop ? [] : await indexesToDrop(db),
  });

  // Every run, the nightly tick included: a retired index costs every write
  // until it is gone, and the drop blocks no reader or writer.
  if (mayDrop) {
    await dropRetiredIndexes(db, steps, options.retiredLockTimeout);
  }

  if (!payload.vacuum && !payload.reindex) return summary("nothing_due");

  // The queue table exists wherever a worker has started; a database without
  // one has no purge to wait for.
  const { rows: queueTable } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
  );
  if (queueTable[0]?.present) {
    const { rows: purge } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pgboss.job
        WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
      [PURGE_QUEUE],
    );
    if (Number(purge[0]?.n ?? 0) > 0) return summary("refused_purge_running");
  }

  if (payload.vacuum) {
    const startedAt = Date.now();
    try {
      await db.query(`VACUUM (ANALYZE) "measurements"`);
      const after = await relationSizes(db);
      steps.push({
        step: "vacuum",
        target: "measurements",
        bytesBefore: before.table,
        bytesAfter: after.table,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
    } catch (err) {
      logCaught("measurements.maintenance.vacuum_failed", err);
      steps.push({
        step: "vacuum",
        target: "measurements",
        bytesBefore: before.table,
        bytesAfter: before.table,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: errorText(err),
      });
      return summary("failed", await relationSizes(db));
    }
  }

  if (payload.reindex) {
    if (mayDrop) await dropInvalidCopies(db, steps);
    const targets = (await measurementIndexes(db)).filter(
      (index) =>
        index.valid &&
        !CONCURRENT_COPY.test(index.name) &&
        !RETIRED_MEASUREMENT_INDEXES.includes(index.name),
    );
    for (const index of targets) {
      if (options.shouldStop?.()) break;
      const startedAt = Date.now();
      const bytesBefore = Number(index.bytes);
      try {
        await db.query(`REINDEX INDEX CONCURRENTLY ${quoted(index.name)}`);
        steps.push({
          step: "reindex",
          target: index.name,
          bytesBefore,
          bytesAfter: await indexBytes(db, index.name),
          durationMs: Date.now() - startedAt,
          ok: true,
        });
      } catch (err) {
        logCaught("measurements.maintenance.reindex_failed", err);
        steps.push({
          step: "reindex",
          target: index.name,
          bytesBefore,
          bytesAfter: bytesBefore,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: errorText(err),
        });
        // A failed concurrent rebuild leaves its half-built copy behind,
        // holding disk. Drop it and stop: the likeliest cause is the disk.
        // Without the owner's right to drop it, the copy stays until the next
        // start and the summary names it.
        if (mayDrop) await dropInvalidCopies(db, steps);
        return summary("failed", await relationSizes(db));
      }
    }
  }

  return summary("completed", await relationSizes(db));
}

export async function handleMeasurementMaintenance(
  jobs: Job<MeasurementMaintenancePayload>[],
): Promise<JobOutcome> {
  const job = jobs[0];
  return withBackgroundEvent("job.measurement_maintenance", async (evt) => {
    const startedAt = Date.now();
    const guarded = await withJobLock(
      MEASUREMENT_MAINTENANCE_QUEUE,
      async () => {
        const viaStatements = sessionOptionsDisabled();
        const client = new Client({
          connectionString: process.env.DATABASE_URL,
          options: viaStatements ? undefined : MAINTENANCE_SESSION_OPTIONS,
          keepAlive: true,
        });
        client.on("error", () => {});
        await client.connect();
        try {
          if (viaStatements) {
            for (const statement of maintenanceSessionStatements()) {
              await client.query(statement);
            }
          }
          const health = await tableHealth(client);
          const steps = resolveSteps(job?.data);
          const summary = await runMeasurementMaintenance(client, steps);
          return { summary, health, steps };
        } finally {
          await client
            .end()
            .catch((err) =>
              logCaught(
                "measurements.maintenance.connection_close_failed",
                err,
              ),
            );
        }
      },
    );
    if (!guarded.ran) {
      evt.addMeta("maintenance_outcome", "already_running");
      return jobDone({ outcome: "already_running" });
    }
    const { summary: result, health, steps } = guarded.result;

    evt.addMeta("maintenance_outcome", result.outcome);
    evt.addMeta("maintenance_vacuum", steps.vacuum);
    evt.addMeta("maintenance_reindex", steps.reindex);
    evt.addMeta("maintenance_live_rows", health.liveRows);
    evt.addMeta("maintenance_dead_rows", health.deadRows);
    evt.addMeta("maintenance_heap_bytes", health.heapBytes);
    if (autovacuumBehind(health)) {
      evt.addMeta("maintenance_autovacuum_behind", true);
      evt.addWarning(
        `measurements holds ${health.deadRows} dead rows against ${health.liveRows} live; autovacuum starts at ${AUTOVACUUM_SCALE_FACTOR * 100} % and is not keeping up (look for a long-open transaction or too few autovacuum workers)`,
      );
    }
    if (health.bloatFactor !== null) {
      evt.addMeta("maintenance_bloat_factor", health.bloatFactor);
      if (health.bloatFactor > TABLE_BLOAT_WARN_FACTOR) {
        evt.addWarning(
          `measurements heap is ${health.bloatFactor}x what its live rows need; only VACUUM FULL in a maintenance window gives the space back`,
        );
      }
    }
    if (result.dropsLeftForBoot.length > 0) {
      evt.addMeta(
        "maintenance_drops_left_for_boot",
        result.dropsLeftForBoot.length,
      );
      evt.addWarning(
        `index ${result.dropsLeftForBoot.join(", ")} on measurements is due to be dropped, which only the table's owner may do; the next start drops it as the owner`,
      );
    }
    const retiredLeft = result.steps.filter(
      (s) => s.step === "drop_retired" && !s.ok,
    );
    if (retiredLeft.length > 0) {
      evt.addMeta("maintenance_retired_index_pending", true);
      evt.addWarning(
        `retired index ${retiredLeft.map((s) => s.target).join(", ")} could not be dropped within ${RETIRED_INDEX_LOCK_TIMEOUT} (a long transaction on measurements); the next nightly run tries again`,
      );
    }
    evt.addMeta("maintenance_table_bytes_before", result.tableBytesBefore);
    evt.addMeta("maintenance_table_bytes_after", result.tableBytesAfter);
    evt.addMeta("maintenance_index_bytes_before", result.indexBytesBefore);
    evt.addMeta("maintenance_index_bytes_after", result.indexBytesAfter);
    // Catalog names and sizes only: nothing account- or value-shaped.
    evt.addMeta(
      "maintenance_steps",
      JSON.stringify(
        result.steps.map((s) => ({
          step: s.step,
          target: s.target,
          before: s.bytesBefore,
          after: s.bytesAfter,
          ms: s.durationMs,
          ok: s.ok,
        })),
      ),
    );

    const candidates: JobRunCandidate[] = result.steps.map((s) => ({
      key: `${s.step}:${s.target}`,
      outcome: s.ok ? "ok" : "failed",
      ...(s.ok ? {} : { cause: s.error?.slice(0, 120) }),
    }));
    reportJobRun({
      queue: MEASUREMENT_MAINTENANCE_QUEUE,
      runId: job?.id ?? "unknown",
      candidates,
    });

    const facts = {
      outcome: result.outcome,
      processed: result.steps.filter((s) => s.ok).length,
      failed: result.steps.filter((s) => !s.ok).length,
      duration_ms: wholeFact(Date.now() - startedAt),
      dead_rows: health.deadRows,
      // In whole percent: a fact is a whole number and the factor a ratio
      // (1.3). Reported as the ratio itself it failed every run's outcome
      // validation (#1271). Zero before the table has statistics.
      bloat_percent: percentFact(health.bloatFactor),
    };
    if (result.outcome === "failed") {
      const firstError = result.steps.find((s) => !s.ok);
      return jobFailed(
        `measurement maintenance stopped at ${firstError?.step ?? "a step"} of ${firstError?.target ?? "measurements"}`,
        firstError?.error,
        facts,
      );
    }
    if (result.outcome === "refused_purge_running") {
      evt.addWarning(
        "measurement maintenance refused: the compaction-tombstone purge is still queued or running",
      );
    }
    return jobDone(facts);
  });
}
