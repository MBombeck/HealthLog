/**
 * A read-only SQLite file opened on a worker thread.
 *
 * `node:sqlite` is synchronous: a statement runs to its first row inside one
 * call, and a `GROUP BY` or an `ORDER BY` over an unindexed column of an
 * uploaded file sorts the whole table before it returns anything. On a
 * 512 MB Gadgetbridge export that was several seconds of a stalled event
 * loop, and in the default deployment the import worker shares its process
 * with the web server, so every request waited. Here the file lives on its
 * own thread; the caller awaits each answer and the event loop keeps running.
 *
 * The thread's code is the short script below, evaluated in place (`eval`),
 * so the standalone build needs no extra file. It opens the file with the
 * URL and pragmas it is given and answers four requests: `get`, `all`, and a
 * pulled iteration (`iterOpen` / `iterNext` / `iterClose`) that sends one
 * batch per request, so a large result never sits in memory whole. A failed
 * statement answers with its message; the caller sees an `Error`.
 */
import { Worker } from "node:worker_threads";

import type { SQLInputValue } from "node:sqlite";

const THREAD_SOURCE = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
let db = null;
const iterators = new Map();
let nextIter = 1;
function answer(id, fn) {
  try {
    parentPort.postMessage({ id, ok: true, value: fn() });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
}
parentPort.on("message", (msg) => {
  answer(msg.id, () => {
    switch (msg.op) {
      case "open":
        db = new DatabaseSync(new URL(workerData.url), { readOnly: true });
        if (workerData.pragmas) db.exec(workerData.pragmas);
        return null;
      case "get":
        return db.prepare(msg.sql).get(...msg.params) ?? null;
      case "all":
        return db.prepare(msg.sql).all(...msg.params);
      case "iterOpen": {
        const id = nextIter++;
        iterators.set(id, db.prepare(msg.sql).iterate(...msg.params));
        return id;
      }
      case "iterNext": {
        const it = iterators.get(msg.iter);
        const rows = [];
        let done = false;
        while (rows.length < msg.size) {
          const step = it.next();
          if (step.done) { done = true; break; }
          rows.push(step.value);
        }
        if (done) iterators.delete(msg.iter);
        return { rows, done };
      }
      case "iterClose": {
        const it = iterators.get(msg.iter);
        iterators.delete(msg.iter);
        if (it && typeof it.return === "function") it.return();
        return null;
      }
      case "close":
        iterators.clear();
        if (db) db.close();
        db = null;
        return null;
      default:
        throw new Error("unknown request");
    }
  });
});
`;

type Row = Record<string, unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface OffThreadSqlite {
  get(sql: string, params?: readonly SQLInputValue[]): Promise<Row | null>;
  all(sql: string, params?: readonly SQLInputValue[]): Promise<Row[]>;
  /** The statement's rows, `size` at a time, pulled one batch per step. */
  batches(
    sql: string,
    params: readonly SQLInputValue[],
    size: number,
  ): AsyncGenerator<Row[]>;
  /** Close the file and end the thread. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Open `url` (a `file:` URL, query parameters such as `immutable=1`
 * included) read-only on a new thread and run `pragmas` on it. Rejects when
 * the file cannot be opened or a pragma fails; the thread is ended then.
 */
export async function openSqliteOffThread(
  url: URL,
  pragmas: string,
): Promise<OffThreadSqlite> {
  const worker = new Worker(THREAD_SOURCE, {
    eval: true,
    workerData: { url: url.href, pragmas },
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let ended: Error | null = null;

  const failAll = (err: Error) => {
    ended = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.on(
    "message",
    (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error ?? "SQLite request failed"));
    },
  );
  worker.on("error", (err: Error) => failAll(err));
  worker.on("exit", () => failAll(new Error("SQLite thread ended")));

  const request = <T>(msg: Record<string, unknown>): Promise<T> => {
    if (ended) return Promise.reject(ended);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...msg, id });
    });
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await request({ op: "close" });
    } catch {
      // The thread is gone already; terminating it again is harmless.
    }
    await worker.terminate();
  };

  try {
    await request({ op: "open" });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    get: (sql, params = []) => request<Row | null>({ op: "get", sql, params }),
    all: (sql, params = []) => request<Row[]>({ op: "all", sql, params }),
    async *batches(sql, params, size) {
      const iter = await request<number>({ op: "iterOpen", sql, params });
      let done = false;
      try {
        while (!done) {
          const step = await request<{ rows: Row[]; done: boolean }>({
            op: "iterNext",
            iter,
            size,
          });
          done = step.done;
          if (step.rows.length > 0) yield step.rows;
        }
      } finally {
        if (!done) await request({ op: "iterClose", iter }).catch(() => {});
      }
    },
    close,
  };
}
