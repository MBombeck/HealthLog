import { WideEventBuilder } from "./event-builder";
import { getEvent } from "./context";
import { emitIfSampled } from "./transports";

/**
 * A failure that deserves its own log line, under its own action name.
 *
 * A wide event carries one action, and the last `annotate()` to name one wins.
 * That is the right shape for "what did this request do", and the wrong one
 * for "what went wrong on the way": a provider hop that failed before the
 * next one answered, a job candidate that failed among six that worked, a
 * Coach turn that ran out of budget, a caught error the code chose to carry
 * on past. Each of those used to be either a meta key on someone else's line
 * at level `info`, or nothing at all, so a query for `level=error` could not
 * find it and an alert rule had no stable name to key on.
 *
 * `emitSignal` writes one extra line with the action, the level and a small
 * pinned-shape meta bag. It carries the surrounding event's request and trace
 * ids, so the signal and the line it happened inside join on one id; the
 * surrounding event itself is not touched (its own level still describes its
 * own outcome).
 *
 * Levels: `error` for a real failure nobody downstream recovered from, `warn`
 * for one the code recovered from (a fallback answered, a degraded result was
 * served) or a refusal by design that an operator should still be able to
 * count. Nothing here is for `info`: an expected outcome belongs on the
 * request's own line.
 *
 * Never throws. A log line must not break the work it describes.
 */
export interface SignalInput {
  /** Stable `<surface>.<noun>.<verb>` name, e.g. `ai.chain.link_failed`. */
  action: string;
  level: "warn" | "error";
  /** Scalars and small arrays only; redacted on the way in like any meta. */
  meta?: Record<string, unknown>;
  /** The caught value, when there is one. Only its type and message leave. */
  error?: unknown;
}

/** Longest error message a signal carries. */
const MAX_MESSAGE_CHARS = 240;

export function emitSignal(input: SignalInput): void {
  try {
    const event = new WideEventBuilder("background");
    const parent = getEvent();
    if (parent) {
      event.setRequestId(parent.getRequestId());
      event.setTraceId(parent.getTraceId());
    }
    event.setBackground({ task_name: input.action });
    event.setAction({ name: input.action });
    for (const [key, value] of Object.entries(input.meta ?? {})) {
      event.addMeta(key, value);
    }
    if (input.error !== undefined) {
      const err = input.error;
      event.addMeta(
        "error_type",
        err instanceof Error ? err.name || "Error" : typeof err,
      );
      const message = err instanceof Error ? err.message : String(err);
      event.addMeta("error_message", message.slice(0, MAX_MESSAGE_CHARS));
    }
    event.elevateLevel(input.level);
    event.finish();
    emitIfSampled(event.toJSON());
  } catch {
    // A log line must never break the work it describes.
  }
}

/**
 * The common case of a `catch` that carries on: say what failed, at `warn`,
 * under a stable action, with the caught error attached. Use it where the
 * code deliberately degrades (an enqueue that the next tick repeats, a
 * best-effort side write) instead of dropping the error or folding it into an
 * `info` annotation.
 */
export function logCaught(
  action: string,
  error: unknown,
  meta?: Record<string, unknown>,
): void {
  emitSignal({ action, level: "warn", error, meta });
}

/**
 * `logCaught` shaped for a promise's `.catch`: `.catch(caughtAs("x.y.failed"))`
 * in place of `.catch(() => {})`. The promise still settles, so a best-effort
 * side write stays best-effort, and its failure leaves a `warn` line.
 */
export function caughtAs(
  action: string,
  meta?: Record<string, unknown>,
): (error: unknown) => void {
  return (error: unknown) => logCaught(action, error, meta);
}
