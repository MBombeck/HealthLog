/**
 * Counts the SQL statements the application sends to Postgres while a
 * function runs.
 *
 * Every statement the Prisma client sends goes through `pg`'s
 * `Client.prototype.query` (the driver adapter's pool hands out `pg`
 * clients, raw queries included, transactions' BEGIN/COMMIT included). The
 * prototype is patched once, on the `pg` instance the adapter itself
 * resolves, so a second copy of `pg` elsewhere in node_modules cannot leave
 * the counter reading zero; `countStatements` refuses a window that saw no
 * statement at all for the same reason.
 *
 * Background work a request starts and does not await (the fire-and-forget
 * tasks) is settled before the window closes, so it is counted with the
 * request that caused it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

interface PgClientPrototype {
  query: (...args: unknown[]) => unknown;
}

const requireHere = createRequire(import.meta.url);
const adapterEntry = requireHere.resolve("@prisma/adapter-pg");
const pg = createRequire(adapterEntry)("pg") as {
  Client: { prototype: PgClientPrototype };
};

const state = { active: false, statements: [] as string[] };

/**
 * Marks the async tree of the measured call when a window is scoped to it.
 * Background work started earlier (an unawaited flush of a previous test, a
 * coalescing timer that fires inside the window) runs outside that tree and
 * is not counted; work the call itself starts inherits the mark and is.
 */
const callScope = new AsyncLocalStorage<true>();
let scoped = false;
const PATCHED = Symbol.for("healthlog.queryCounter");

const proto = pg.Client.prototype as PgClientPrototype & {
  [PATCHED]?: boolean;
};
if (!proto[PATCHED]) {
  const original = proto.query;
  proto.query = function patchedQuery(this: unknown, ...args: unknown[]) {
    if (state.active && (!scoped || callScope.getStore() === true)) {
      const first = args[0] as string | { text?: string } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "?");
      state.statements.push(text.replace(/\s+/g, " ").trim().slice(0, 160));
    }
    return original.apply(this, args);
  };
  proto[PATCHED] = true;
}

export interface StatementCount<T> {
  result: T;
  count: number;
  statements: string[];
}

/**
 * `scope: "call"` counts only statements caused by `fn` itself, for a test
 * that compares two windows and must not see detached work another test or
 * setup step left running. The default counts everything in the window.
 */
export async function countStatements<T>(
  fn: () => Promise<T>,
  options: { scope?: "window" | "call" } = {},
): Promise<StatementCount<T>> {
  const { settleBackgroundTasks } =
    await import("@/lib/logging/background-tasks");
  await settleBackgroundTasks();
  state.statements = [];
  state.active = true;
  scoped = options.scope === "call";
  let result: T;
  try {
    result = await (scoped ? callScope.run(true, fn) : fn());
    await settleBackgroundTasks();
  } finally {
    state.active = false;
    scoped = false;
  }
  const statements = state.statements;
  if (statements.length === 0) {
    throw new Error(
      "countStatements saw no statement at all. Either the call reads " +
        "nothing from Postgres, or the counter is patched on a different " +
        "copy of pg than the one the Prisma adapter uses.",
    );
  }
  return { result, count: statements.length, statements };
}

/** The statements grouped by text, most frequent first, for a failure message. */
export function summariseStatements(statements: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of statements) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${String(n).padStart(4)} × ${s}`)
    .join("\n");
}
