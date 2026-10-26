/**
 * Response parity for a route whose code moves: record what the route
 * answers, stores and reports before the move, and compare after it.
 *
 * A parity test drives a route through `callRoute` across the cases it
 * distinguishes, and pins three things per case in a committed snapshot
 * under `tests/integration/routes/parity/__snapshots__/`:
 *
 *   - the response (status, envelope);
 *   - what the request left in the database, read back by the test;
 *   - the wide event the request emitted: its action and meta, which is what
 *     the operator dashboards read.
 *
 * The snapshot is written on the code before the move, committed on its own,
 * and must come out byte-identical after it. Values that differ between two
 * runs of the same code (generated ids, server timestamps, request ids,
 * durations) are replaced by stable placeholders first, so the comparison
 * sees only what the code decides. Ids are numbered by first appearance,
 * so two references to the same row still read as the same placeholder.
 */
import { expect } from "vitest";

import type { WideEvent } from "@/lib/logging/types";

/** Generated identifiers: Prisma `cuid()` values and UUIDs. */
const GENERATED_ID =
  /^(c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * Keys whose values the clock or a random source decides on every run. Their
 * presence is kept, their value is not.
 */
const VOLATILE_KEYS = new Set([
  "requestId",
  "request_id",
  "createdAt",
  "updatedAt",
  "syncVersion",
  "duration_ms",
  "durationMs",
  "timestamp",
  "lastUsedAt",
]);

export interface StableOptions {
  /**
   * Instants inside `[since, until]` are server clock readings (a row's
   * `createdAt`, a stamp the route wrote) and read as `<now>`. Instants the
   * test sent, which lie outside that window, are kept as they are.
   */
  since: Date;
  until?: Date;
  /** Further keys to blank, for a route with a volatile field of its own. */
  volatileKeys?: readonly string[];
}

/** A copy of `value` with the run-dependent parts replaced. */
export function stable(value: unknown, options: StableOptions): unknown {
  const ids = new Map<string, string>();
  const until = (options.until ?? new Date(Date.now() + 60_000)).getTime();
  const since = options.since.getTime();
  const volatile = new Set([...VOLATILE_KEYS, ...(options.volatileKeys ?? [])]);

  const walk = (node: unknown, key: string | null): unknown => {
    if (
      key !== null &&
      volatile.has(key) &&
      node !== null &&
      node !== undefined
    ) {
      return `<${key}>`;
    }
    if (node instanceof Date) node = node.toISOString();
    // Sealed columns carry a fresh nonce on every write: keep the length.
    if (node instanceof Uint8Array) return `<bytes:${node.length}>`;
    if (typeof node === "string") {
      if (GENERATED_ID.test(node)) {
        let label = ids.get(node);
        if (!label) {
          label = `<id:${ids.size + 1}>`;
          ids.set(node, label);
        }
        return label;
      }
      if (ISO_INSTANT.test(node)) {
        const t = Date.parse(node);
        if (t >= since && t <= until) return "<now>";
      }
      return node;
    }
    if (typeof node === "bigint") return `${node}n`;
    if (Array.isArray(node)) return node.map((item) => walk(item, null));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k);
      return out;
    }
    return node;
  };
  return walk(value, null);
}

const DAY_MS = 86_400_000;
const ANCHORED_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const ANCHORED_DAY_KEY = /\b\d{4}-\d{2}-\d{2}\b/g;

/** The start of the current UTC day, the anchor `relativeToAnchor` uses. */
export function startOfUtcToday(): Date {
  return new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
}

/**
 * A fixed anchor day, for a walk whose route cuts every window on the
 * request's clock (`src/lib/analytics/request-clock-sql.ts`), so a pinned
 * `Date` reaches all of them.
 *
 * A record laid out from today is not the same record on every day: its
 * weekdays move with the date. The chronotype's work and free nights and the
 * weight-by-weekday points follow them, so a snapshot taken on a Friday
 * failed on a Saturday. A Friday, the day those walks were first recorded.
 * A walk that still meets `NOW()` keeps `startOfUtcToday`: against a fixed
 * day, the database clock would sit months away.
 */
export const FIXED_ANCHOR_DAY = new Date("2026-10-23T00:00:00.000Z");

/**
 * A copy of `value` with every ISO instant written as days and time from
 * `anchor` (`anchor-13d+06:30:00`) and every `YYYY-MM-DD` day key as days from
 * the anchor's day (`day-13`), inside any string.
 *
 * The record is laid out from the anchor day (`FIXED_ANCHOR_DAY`, or
 * `startOfUtcToday` for a walk whose route reads windows against the database
 * clock, which a pinned `Date` cannot reach), the clock is pinned to that day,
 * and the snapshot holds only positions relative to it. Keep the account in
 * UTC, so a daylight-saving change between two runs cannot move a local day
 * boundary against the anchor.
 */
export function relativeToAnchor(value: unknown, anchor: Date): unknown {
  const base = anchor.getTime();
  const instant = (iso: string) => {
    const ms = Date.parse(iso) - base;
    const days = Math.floor(ms / DAY_MS);
    const time = new Date(ms - days * DAY_MS).toISOString().slice(11, 19);
    return `anchor${days >= 0 ? "+" : ""}${days}d+${time}`;
  };
  const dayKey = (key: string) => {
    const days = Math.round((Date.parse(`${key}T00:00:00Z`) - base) / DAY_MS);
    return `day${days >= 0 ? "+" : ""}${days}`;
  };
  const walk = (node: unknown): unknown => {
    if (node instanceof Date) node = node.toISOString();
    if (typeof node === "string") {
      return node
        .replace(ANCHORED_INSTANT, instant)
        .replace(ANCHORED_DAY_KEY, dayKey);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object" && !(node instanceof Uint8Array)) {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };
  return walk(value);
}

/**
 * The wide events requests emitted, collected in order. Install with
 * `vi.mock("@/lib/logging/transports", wideEventRecorder.mockFactory)` in
 * the test file, then read `wideEventRecorder.take()` after each call.
 */
export const wideEventRecorder = {
  events: [] as WideEvent[],
  /** The events since the last call, emptied. */
  take(): WideEvent[] {
    return this.events.splice(0, this.events.length);
  },
};

/**
 * Calls the route handed to a queue or another fire-and-forget tail (a job
 * enqueue, a data-arrival emit), recorded in order with their arguments. A
 * parity test replaces those collaborators with recorders: the snapshot then
 * shows what the route asked for, and the request's wide event no longer
 * depends on whether a tail it did not await happened to finish first.
 */
export const effectRecorder = {
  calls: [] as Array<{ effect: string; args: unknown[] }>,
  record(effect: string, args: unknown[]): void {
    this.calls.push({ effect, args });
  },
  /** The calls since the last take, emptied. */
  take(): Array<{ effect: string; args: unknown[] }> {
    return this.calls.splice(0, this.calls.length);
  },
};

/** What of a wide event a parity snapshot keeps: what the code decided. */
export function eventFacts(event: WideEvent): unknown {
  return {
    status: event.http?.status ?? null,
    action: event.action ?? null,
    meta: event.meta ?? null,
    warnings: event.warnings ?? null,
    error: event.error
      ? { type: event.error.type, message: event.error.message }
      : null,
  };
}

/**
 * Compare `value` with the committed snapshot `name`, a file under
 * `__snapshots__/` beside the calling test (parity tests live in
 * `tests/integration/routes/parity/`). A missing snapshot is written outside
 * CI (the recording run); in CI a missing one fails, and a present one must
 * match everywhere.
 */
export async function expectParity(
  name: string,
  value: unknown,
): Promise<void> {
  await expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `./__snapshots__/${name}.json.snap`,
  );
}
