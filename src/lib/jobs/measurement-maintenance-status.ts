/**
 * What the admin card shows about the measurement table maintenance: the
 * newest run and where it stands, whether the compaction-tombstone purge is
 * still at work (the run refuses to start while it is), and the table's size
 * right now.
 *
 * Read straight from `pgboss.job`, the same source `job-failures.ts` reads,
 * and fail-soft the same way: a web-only deployment has no `pgboss` schema,
 * and the card says "no background worker" instead of failing.
 */
import { prisma } from "@/lib/db";
import { MEASUREMENT_MAINTENANCE_QUEUE } from "@/lib/jobs/measurement-maintenance";

const PURGE_QUEUE = "compaction-tombstone-purge";

/** Where the newest run stands, in the words the card uses. */
export type MaintenanceRunState = "queued" | "running" | "completed" | "failed";

/**
 * How a finished run ended. `completed` did the work; the two refusals
 * finished without touching the table.
 */
export type MaintenanceRunOutcome =
  "completed" | "refused_purge_running" | "already_running";

export interface MeasurementMaintenanceStatus {
  /** False when there is no background queue to ask (web-only deployment). */
  available: boolean;
  /** The purge is queued or running; a new run would refuse to start. */
  purgePending: boolean;
  run: {
    state: MaintenanceRunState;
    requestedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /** Only for `completed`: what the finished run actually did. */
    outcome: MaintenanceRunOutcome | null;
  } | null;
  /** `measurements` with its indexes and TOAST, and its indexes alone. */
  sizes: { tableBytes: number; indexBytes: number } | null;
}

const OUTCOMES: ReadonlySet<string> = new Set([
  "completed",
  "refused_purge_running",
  "already_running",
]);

/** pg-boss's row state → the card's run state. */
export function runStateOf(state: string): MaintenanceRunState {
  if (state === "created" || state === "retry") return "queued";
  if (state === "active") return "running";
  if (state === "completed") return "completed";
  return "failed";
}

async function readSizes(): Promise<MeasurementMaintenanceStatus["sizes"]> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ table_bytes: bigint; index_bytes: bigint }>
    >`
      SELECT pg_total_relation_size('measurements'::regclass) AS table_bytes,
             pg_indexes_size('measurements'::regclass) AS index_bytes
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      tableBytes: Number(row.table_bytes),
      indexBytes: Number(row.index_bytes),
    };
  } catch {
    return null;
  }
}

export async function readMeasurementMaintenanceStatus(): Promise<MeasurementMaintenanceStatus> {
  const sizes = await readSizes();
  try {
    const [runs, purge] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          state: string;
          created_on: Date;
          started_on: Date | null;
          completed_on: Date | null;
          outcome: string | null;
        }>
      >`
        SELECT state, created_on, started_on, completed_on,
               output->'did'->>'outcome' AS outcome
        FROM pgboss.job
        WHERE name = ${MEASUREMENT_MAINTENANCE_QUEUE}
        ORDER BY created_on DESC
        LIMIT 1
      `,
      prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pgboss.job
        WHERE name = ${PURGE_QUEUE}
          AND state IN ('created', 'retry', 'active')
      `,
    ]);
    const row = runs[0];
    const state = row ? runStateOf(row.state) : null;
    return {
      available: true,
      purgePending: (purge[0]?.n ?? 0) > 0,
      run:
        row && state
          ? {
              state,
              requestedAt: row.created_on.toISOString(),
              startedAt: row.started_on?.toISOString() ?? null,
              finishedAt: row.completed_on?.toISOString() ?? null,
              outcome:
                state === "completed" &&
                row.outcome !== null &&
                OUTCOMES.has(row.outcome)
                  ? (row.outcome as MaintenanceRunOutcome)
                  : null,
            }
          : null,
      sizes,
    };
  } catch {
    // No `pgboss` schema (web-only deployment) or no permission to read it.
    return { available: false, purgePending: false, run: null, sizes };
  }
}
