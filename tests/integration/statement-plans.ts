/**
 * Every read statement a function sends to Postgres, run again under
 * `EXPLAIN (ANALYZE, BUFFERS)` and reduced to what it cost.
 *
 * `newest-per-type-plans.test.ts` explains the raw statements of one reader
 * by spying on `$queryRaw`. A tool handler issues model-API reads too
 * (`groupBy`, `findMany`, `aggregate`), and those never pass through
 * `$queryRaw`, so a spy there sees part of the cost and reports the rest as
 * zero. This helper sits one layer lower, on `pg`'s `Client.prototype.query`
 * (the same place `query-counter.ts` counts statements), so it sees every
 * statement the Prisma adapter sends, whatever API built it.
 *
 * Only `SELECT` and `WITH` statements are explained: `EXPLAIN ANALYZE`
 * executes what it explains, and a write must not run twice. Each one is
 * explained on a client of its own after the function has returned, with
 * the application's session settings (UTC, no JIT), against the same
 * database and the same parameters.
 */
import { createRequire } from "node:module";

interface PgClientPrototype {
  query: (...args: unknown[]) => unknown;
}
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const requireHere = createRequire(import.meta.url);
const adapterEntry = requireHere.resolve("@prisma/adapter-pg");
const pg = createRequire(adapterEntry)("pg") as {
  Client: {
    prototype: PgClientPrototype;
    new (config: { connectionString: string }): PgClient;
  };
};

interface Captured {
  text: string;
  values: unknown[];
}

const state = { active: false, captured: [] as Captured[] };
const PATCHED = Symbol.for("healthlog.statementPlans");

const proto = pg.Client.prototype as PgClientPrototype & {
  [PATCHED]?: boolean;
};
if (!proto[PATCHED]) {
  const original = proto.query;
  proto.query = function patchedQuery(this: unknown, ...args: unknown[]) {
    if (state.active) {
      const first = args[0] as
        string | { text?: string; values?: unknown[] } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "");
      const values =
        typeof first === "string"
          ? Array.isArray(args[1])
            ? (args[1] as unknown[])
            : []
          : (first?.values ?? []);
      if (/^\s*(SELECT|WITH)\b/i.test(text)) {
        state.captured.push({ text, values });
      }
    }
    return original.apply(this, args);
  };
  proto[PATCHED] = true;
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Alias?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Heap Fetches"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

export interface StatementPlan {
  /** The statement, whitespace-collapsed and cut to a readable length. */
  text: string;
  /** Rows the scans of `relation` produced or discarded, over all loops. */
  rowVisits: number;
  /** Shared buffers the whole statement hit or read. */
  buffers: number;
  /** Server-side execution time of the explained run. */
  ms: number;
  /** Whether any node is a sequential scan of `relation`. */
  seqScan: boolean;
  plan: unknown;
}

export interface StatementLedger<T> {
  result: T;
  plans: StatementPlan[];
  /** Sum of `rowVisits` over every statement. */
  rowVisits: number;
  /** Sum of `buffers` over every statement. */
  buffers: number;
  /** Sum of the statements' server-side execution times. */
  ms: number;
}

function walk(
  node: PlanNode,
  relation: string,
): { visits: number; seq: boolean } {
  let visits = 0;
  let seq = false;
  if (node["Relation Name"] === relation) {
    visits +=
      ((node["Actual Rows"] ?? 0) +
        (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0)) *
      (node["Actual Loops"] ?? 1);
    if (node["Node Type"] === "Seq Scan") seq = true;
  }
  for (const child of node.Plans ?? []) {
    const sub = walk(child, relation);
    visits += sub.visits;
    seq ||= sub.seq;
  }
  return { visits, seq };
}

/**
 * Run `fn`, then explain each read statement it sent. `relation` names the
 * table whose row visits are counted (measurements by default). Refuses a
 * window that saw no read at all, so a helper patched on the wrong copy of
 * `pg` cannot report a bound it never measured.
 */
export async function explainStatements<T>(
  fn: () => Promise<T>,
  relation = "measurements",
): Promise<StatementLedger<T>> {
  state.captured = [];
  state.active = true;
  let result: T;
  try {
    result = await fn();
  } finally {
    state.active = false;
  }
  const captured = state.captured;
  state.captured = [];
  if (captured.length === 0) {
    throw new Error("explainStatements saw no read statement at all.");
  }
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "",
  });
  await client.connect();
  const plans: StatementPlan[] = [];
  try {
    await client.query("SET TimeZone = 'UTC'");
    await client.query("SET jit = off");
    for (const { text, values } of captured) {
      const { rows } = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
        values,
      );
      const plan = rows[0]["QUERY PLAN"] as Array<{
        Plan: PlanNode;
        "Execution Time": number;
      }>;
      const root = plan[0].Plan;
      const { visits, seq } = walk(root, relation);
      plans.push({
        text: text.replace(/\s+/g, " ").trim().slice(0, 200),
        rowVisits: visits,
        buffers:
          (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0),
        ms: plan[0]["Execution Time"],
        seqScan: seq,
        plan,
      });
    }
  } finally {
    await client.end();
  }
  return {
    result,
    plans,
    rowVisits: plans.reduce((s, p) => s + p.rowVisits, 0),
    buffers: plans.reduce((s, p) => s + p.buffers, 0),
    ms: plans.reduce((s, p) => s + p.ms, 0),
  };
}

/** The costliest statements first, for a failure message or a report. */
export function describeLedger(
  ledger: StatementLedger<unknown>,
  top = 8,
): string {
  return [...ledger.plans]
    .sort((a, b) => b.rowVisits - a.rowVisits || b.buffers - a.buffers)
    .slice(0, top)
    .map(
      (p) =>
        `${String(p.rowVisits).padStart(8)} rows ${String(p.buffers).padStart(7)} buf ${p.ms.toFixed(1).padStart(8)} ms${p.seqScan ? " SEQ" : ""}  ${p.text}`,
    )
    .join("\n");
}
