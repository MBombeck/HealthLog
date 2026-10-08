/**
 * Operator-triggered maintenance of the `measurements` table (v1.42).
 *
 * `VACUUM (ANALYZE)` and a `REINDEX INDEX CONCURRENTLY` per index, largest
 * first, after the compaction-tombstone purge has shrunk the table. Neither
 * statement can run inside a transaction, so this is a job rather than a
 * Prisma migration. Started only from `POST /api/admin/maintenance/measurements`
 * (cookie-only admin), never on a schedule: the operator picks a quiet window.
 * Runbook: `docs/ops/measurement-maintenance.md`.
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
 */
import { Client } from "pg";
import type { Job } from "pg-boss";
import { sessionOptionsDisabled } from "@/lib/db";

import { withJobLock } from "@/lib/jobs/job-lock";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
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

/** Which steps the operator asked for. */
export interface MeasurementMaintenancePayload {
  vacuum: boolean;
  reindex: boolean;
}

/** Session settings of the maintenance connection. */
export const MAINTENANCE_SESSION_OPTIONS =
  "-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c maintenance_work_mem=128MB -c lock_timeout=300000";

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

/** The only shape an index name may have before it is spliced into SQL. */
const INDEX_NAME = /^[a-z0-9_]{1,63}$/;

/** Postgres's suffixes for the copies a concurrent rebuild leaves behind. */
const CONCURRENT_COPY = /_ccnew\d*$|_ccold\d*$/;

const PURGE_QUEUE = "compaction-tombstone-purge";

export interface MaintenanceStep {
  step: "vacuum" | "reindex" | "drop_invalid";
  target: string;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface MeasurementMaintenanceSummary {
  outcome: "completed" | "refused_purge_running" | "already_running" | "failed";
  steps: MaintenanceStep[];
  tableBytesBefore: number;
  tableBytesAfter: number;
  indexBytesBefore: number;
  indexBytesAfter: number;
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
 * The pass itself, on a connection the caller opened with
 * {@link MAINTENANCE_SESSION_OPTIONS}. Exported for the integration test.
 */
export async function runMeasurementMaintenance(
  db: MaintenanceConnection,
  payload: MeasurementMaintenancePayload,
  options: { shouldStop?: () => boolean } = {},
): Promise<MeasurementMaintenanceSummary> {
  const before = await relationSizes(db);
  const steps: MaintenanceStep[] = [];
  const summary = (
    outcome: MeasurementMaintenanceSummary["outcome"],
    after = before,
  ): MeasurementMaintenanceSummary => ({
    outcome,
    steps,
    tableBytesBefore: before.table,
    tableBytesAfter: after.table,
    indexBytesBefore: before.indexes,
    indexBytesAfter: after.indexes,
  });

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
    await dropInvalidCopies(db, steps);
    const targets = (await measurementIndexes(db)).filter(
      (index) => index.valid && !CONCURRENT_COPY.test(index.name),
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
        await dropInvalidCopies(db, steps);
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
  const payload: MeasurementMaintenancePayload = {
    vacuum: job?.data?.vacuum ?? true,
    reindex: job?.data?.reindex ?? true,
  };
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
          return await runMeasurementMaintenance(client, payload);
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
    const result: MeasurementMaintenanceSummary = guarded.ran
      ? guarded.result
      : {
          outcome: "already_running",
          steps: [],
          tableBytesBefore: 0,
          tableBytesAfter: 0,
          indexBytesBefore: 0,
          indexBytesAfter: 0,
        };

    evt.addMeta("maintenance_outcome", result.outcome);
    evt.addMeta("maintenance_vacuum", payload.vacuum);
    evt.addMeta("maintenance_reindex", payload.reindex);
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
      duration_ms: Date.now() - startedAt,
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
