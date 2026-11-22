/**
 * Admission for the native client's heavy ingest routes.
 *
 * A phone's first Apple Health sync sends hundreds of 500-entry batches,
 * dozens of ECG strips and the day logs of years in a few minutes, over as
 * many connections as it likes. Each request holds its parsed body, its
 * prepared rows and its share of the database pool while it runs, and the
 * pool is far smaller than the number of requests that can arrive, so
 * without a gate the requests the pool cannot serve yet wait inside the heap.
 * On a 1 GB container that was enough to end the process for every account
 * on the instance (a V8 out-of-memory during a first sync).
 *
 * The gate bounds that: at most {@link INGEST_SLOTS} heavy ingests run at
 * once in the process, at most {@link INGEST_SLOTS_PER_CALLER} of them for one
 * caller, and a request that finds no free slot waits in line, in arrival
 * order, for up to {@link INGEST_MAX_WAIT_MS}. A request that cannot get a
 * slot in that time, or that would be one too many in line, is answered 429
 * with `Retry-After` and `X-RateLimit-Reset`, the two headers the native
 * client already backs off against, before its body is read. Nothing about a
 * request that is admitted changes.
 *
 * The caller is the credential the request carries (its bearer token or
 * session cookie), hashed, because the gate runs before the route
 * authenticates: a refused request costs no database round trip. A request
 * without one shares a single caller, so it cannot take more than that
 * caller's share either.
 *
 * Process-local by construction, like the memory it protects: two app
 * containers each run their own gate.
 */
import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { rateLimitResponseHeaders } from "@/lib/rate-limit-context";

/** Heavy ingests that run at once in one process. */
export const INGEST_SLOTS = 4;

/** Of those, how many one caller may hold. */
export const INGEST_SLOTS_PER_CALLER = 2;

/** How long a request waits in line for a slot before it is refused. */
export const INGEST_MAX_WAIT_MS = 5_000;

/** Requests one caller may have waiting in line at once. */
export const INGEST_MAX_QUEUED_PER_CALLER = 4;

/** Requests that may wait in line at once, over every caller. */
export const INGEST_MAX_QUEUED = 32;

interface Waiter {
  caller: string;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GateState {
  slots: number;
  slotsPerCaller: number;
  running: number;
  runningByCaller: Map<string, number>;
  queue: Waiter[];
  /** Mean time a slot is held, for the `Retry-After` estimate. */
  meanHoldMs: number;
}

// Pinned on `globalThis` for the reason `server-cache.ts` gives: a module
// shared by several bundler layers is instantiated once per layer, and a
// gate per layer would admit a multiple of its limit.
const GATE_SLOT = Symbol.for("healthlog.ingestAdmission");
const globalForGate = globalThis as unknown as {
  [key: symbol]: GateState | undefined;
};

function gate(): GateState {
  return (globalForGate[GATE_SLOT] ??= {
    slots: INGEST_SLOTS,
    slotsPerCaller: INGEST_SLOTS_PER_CALLER,
    running: 0,
    runningByCaller: new Map(),
    queue: [],
    meanHoldMs: 1_000,
  });
}

function canRun(state: GateState, caller: string): boolean {
  return (
    state.running < state.slots &&
    (state.runningByCaller.get(caller) ?? 0) < state.slotsPerCaller
  );
}

function take(state: GateState, caller: string): void {
  state.running += 1;
  state.runningByCaller.set(
    caller,
    (state.runningByCaller.get(caller) ?? 0) + 1,
  );
}

function give(state: GateState, caller: string): void {
  state.running -= 1;
  const held = (state.runningByCaller.get(caller) ?? 1) - 1;
  if (held > 0) state.runningByCaller.set(caller, held);
  else state.runningByCaller.delete(caller);
  // The first waiter whose caller has room goes next: arrival order, except
  // that a caller at its own limit does not hold up everyone behind it.
  const next = state.queue.findIndex((w) => canRun(state, w.caller));
  if (next < 0) return;
  const [waiter] = state.queue.splice(next, 1);
  clearTimeout(waiter!.timer);
  take(state, waiter!.caller);
  waiter!.grant();
}

/** The seconds a refused request should wait, from the line ahead of it. */
function retryAfterSeconds(state: GateState): number {
  const ahead = state.queue.length + state.running;
  const seconds = Math.ceil((ahead * state.meanHoldMs) / state.slots / 1000);
  return Math.min(30, Math.max(1, seconds));
}

type Admission =
  | { admitted: true; release: () => void }
  | { admitted: false; retryAfter: number; reason: "queue_full" | "timeout" };

/** Take a slot for `caller`, waiting in line for one if need be. */
export function admitIngest(caller: string): Promise<Admission> {
  const state = gate();
  const started = Date.now();
  const admitted = (): Admission => {
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        state.meanHoldMs =
          state.meanHoldMs * 0.8 + (Date.now() - started) * 0.2;
        give(state, caller);
      },
    };
  };
  // Straight in when there is room, unless someone already waiting could
  // take it: a caller at its own limit waits, and does not hold up a caller
  // behind it that has room.
  if (
    canRun(state, caller) &&
    !state.queue.some((waiter) => canRun(state, waiter.caller))
  ) {
    take(state, caller);
    return Promise.resolve(admitted());
  }
  const queuedForCaller = state.queue.filter((w) => w.caller === caller).length;
  if (
    state.queue.length >= INGEST_MAX_QUEUED ||
    queuedForCaller >= INGEST_MAX_QUEUED_PER_CALLER
  ) {
    return Promise.resolve({
      admitted: false,
      retryAfter: retryAfterSeconds(state),
      reason: "queue_full",
    });
  }
  return new Promise((resolve) => {
    const waiter: Waiter = {
      caller,
      grant: () => resolve(admitted()),
      timer: setTimeout(() => {
        const at = state.queue.indexOf(waiter);
        if (at >= 0) state.queue.splice(at, 1);
        resolve({
          admitted: false,
          retryAfter: retryAfterSeconds(state),
          reason: "timeout",
        });
      }, INGEST_MAX_WAIT_MS),
    };
    // The timer must not hold the process open on shutdown.
    waiter.timer.unref?.();
    state.queue.push(waiter);
  });
}

/** The credential a request carries, hashed: who the gate's caller is. */
export function ingestCallerKey(request: Request | NextRequest): string {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  const credential = authorization ?? cookie;
  if (!credential) return "anonymous";
  return createHash("sha256").update(credential).digest("hex").slice(0, 32);
}

/**
 * Wrap a heavy ingest handler in the gate. Goes inside `apiHandler` (so a
 * refusal is logged on the request's wide event) and outside everything that
 * reads the body, `withIdempotency` included.
 */
export function withIngestAdmission<
  A extends [Request | NextRequest, ...unknown[]],
>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const admission = await admitIngest(ingestCallerKey(args[0]));
    if (!admission.admitted) {
      annotate({
        meta: {
          ingest_admission: admission.reason,
          ingest_retry_after_s: admission.retryAfter,
        },
      });
      const response = apiError(
        "The server is busy with other uploads; try again shortly",
        429,
      );
      for (const [name, value] of Object.entries(
        rateLimitResponseHeaders({
          limit: INGEST_SLOTS_PER_CALLER,
          remaining: 0,
          resetAt: Date.now() + admission.retryAfter * 1000,
        }),
      )) {
        response.headers.set(name, value);
      }
      return response;
    }
    try {
      return await handler(...args);
    } finally {
      admission.release();
    }
  };
}

/** Test escape hatch: an empty gate. */
export function __resetIngestAdmissionForTests(): void {
  const state = gate();
  for (const waiter of state.queue) clearTimeout(waiter.timer);
  globalForGate[GATE_SLOT] = undefined;
}

/**
 * Test escape hatch: widen or narrow the gate. The memory guard runs the same
 * burst with the gate opened wide, to show its budget is one the ungated
 * burst does not fit.
 */
export function __setIngestSlotsForTests(
  slots: number,
  slotsPerCaller: number,
): void {
  const state = gate();
  state.slots = slots;
  state.slotsPerCaller = slotsPerCaller;
}

/** Test and diagnostic view of the gate. */
export function ingestAdmissionState(): {
  running: number;
  queued: number;
} {
  const state = gate();
  return { running: state.running, queued: state.queue.length };
}
