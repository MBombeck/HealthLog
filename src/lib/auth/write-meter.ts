/**
 * The shared per-account write ceiling, applied where the caller is resolved.
 *
 * `checkRecordWriteRateLimit` (300 writes a minute per acting account) used to
 * be called by hand in a dozen create routes, and the other mutating routes
 * had no ceiling at all: of 364 mutating handlers, 169 met no limiter, every
 * PATCH and DELETE on an `[id]` among them. A positive list of routes that
 * remember to call it can only fall behind the routes that exist, so the
 * ceiling now sits on the path every authenticated write already takes: the
 * identity resolvers in `src/lib/auth/guards/` call {@link meterAccountWrite}
 * once the caller is known, and it charges the bucket for any request whose
 * method writes.
 *
 * What it does not do:
 *
 *   - charge a read. GET, HEAD and OPTIONS pass untouched, and so does a POST a
 *     route declared `readOverPost` (a search whose query must not stand in a
 *     URL).
 *   - charge one request twice. A route that resolves the caller through two
 *     helpers (step-up on top of a session) is charged once.
 *   - meter a route that declared its own bucket. The bulk ingest endpoints
 *     the native client syncs through have dedicated ceilings sized for that
 *     volume; charging the shared bucket as well would let a large HealthKit
 *     backfill lock the person out of logging a single dose by hand. Declaring
 *     `writeBucket: "own"` is frozen per route by
 *     `src/__tests__/write-rate-limit-guard.test.ts`, which also requires the
 *     route to call its own limiter.
 *
 * The bucket is keyed on the ACTING account, the precedent from the delegable
 * medication routes: a delegate spends their own allowance rather than the
 * record owner's, and cannot collect a fresh one by switching records. A
 * refused request is counted too, since the charge happens before the body is
 * read.
 *
 * The bucket fails open. It cuts off a runaway loop; it is not what decides
 * who may write, which the resolver that called it has already settled. So
 * when the bucket itself cannot be read (the upsert fails: a lock on
 * `rate_limits`, a pool at its limit), the write goes ahead and a `warn`
 * signal says the ceiling was not applied, instead of every authenticated
 * write in the app answering 500. The login, sign-up and other auth-surface
 * limits call the limiter directly and keep failing closed.
 */
import { HttpError } from "@/lib/api-errors";
import { annotate, getEvent } from "@/lib/logging/context";
import { emitSignal } from "@/lib/logging/signal";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";

/** The code a refusal by the shared write bucket carries. */
export const RECORD_WRITE_RATE_LIMITED_CODE = "record_write.rate_limited";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Requests already charged, so a second resolver in one request is free. */
const charged = new WeakSet<object>();

export interface WriteMeterOptions {
  /** The route answers this POST without writing (see `readOverPost`). */
  readOverPost?: true;
  /**
   * The route meters its writes with a dedicated bucket instead of the shared
   * one. Reviewed per route by the write rate-limit guard.
   */
  writeBucket?: "own";
}

/**
 * Charge the acting account's shared write bucket for this request, or refuse
 * it with 429 when the bucket is spent.
 *
 * Outside a request (no wide event, so no method) there is nothing to charge.
 */
export async function meterAccountWrite(
  accountId: string,
  options: WriteMeterOptions = {},
): Promise<void> {
  const evt = getEvent();
  if (!evt) return;
  const method = (evt.getHttpMethod() ?? "").toUpperCase();
  if (!WRITE_METHODS.has(method)) return;
  if (options.readOverPost === true && method === "POST") return;
  if (options.writeBucket === "own") {
    annotate({ meta: { write_bucket: "own" } });
    return;
  }
  if (charged.has(evt)) return;
  charged.add(evt);

  let rl: Awaited<ReturnType<typeof checkRecordWriteRateLimit>>;
  try {
    rl = await checkRecordWriteRateLimit(accountId);
  } catch (error) {
    annotate({ meta: { record_write_rate_limit_unavailable: true } });
    emitSignal({
      action: "rate_limit.record_write.unavailable",
      level: "warn",
      error,
    });
    return;
  }
  if (!rl.allowed) {
    annotate({ meta: { record_write_rate_limited: true } });
    throw new HttpError(
      429,
      "Too many writes, try again later",
      RECORD_WRITE_RATE_LIMITED_CODE,
    );
  }
}
