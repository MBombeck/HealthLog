import { annotate } from "@/lib/logging/context";

/**
 * Race an awaited promise against a hard timeout.
 *
 * The seven `*-status.ts` routes await `provider.generateCompletion()`
 * and need an upper bound so a stalled provider does not pin the
 * InsightStatusCard behind React-Query's retries. `withTimeout` resolves
 * with the wrapped promise's value when it lands inside the budget, or
 * the `fallback` value otherwise.
 *
 * Returns a typed envelope so the call site can distinguish a real
 * timeout from an upstream error from a normal value, and react
 * differently to each — a timeout/error must NOT be persisted as a
 * day-long cache entry the way a real assessment is.
 *
 * The budget matches the provider clients' own 60 s ceiling. The
 * earlier 20 s cap fired below the providers' floor on cold starts and
 * model warm-ups, converting healthy-but-slow generations into the
 * generic fallback; aligning the two lets a slow-but-valid round-trip
 * land instead of being discarded.
 */
export interface TimeoutEnvelope<T> {
  /** True when the budget expired before the upstream settled. */
  timedOut: boolean;
  /** True when the upstream rejected before the budget expired. */
  errored: boolean;
  value: T;
}

export function withTimeout<T>(
  start: () => Promise<T>,
  ms: number,
  fallback: T,
): Promise<TimeoutEnvelope<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  return new Promise<TimeoutEnvelope<T>>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      annotate({
        action: { name: "insights.status.provider_timeout" },
        meta: { timeout_ms: ms },
      });
      resolve({ timedOut: true, errored: false, value: fallback });
    }, ms);

    start()
      .then((value) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve({ timedOut: false, errored: false, value });
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // Upstream errored before the timeout fired. Surface it as a
        // distinct `errored` envelope and annotate the reason so a real
        // provider failure is observable in the wide events instead of
        // being silently swallowed into the timeout path.
        const reason =
          error instanceof Error ? error.message : String(error ?? "unknown");
        annotate({
          action: { name: "insights.status.provider_error" },
          meta: { reason: reason.slice(0, 240) },
        });
        resolve({ timedOut: false, errored: true, value: fallback });
      });
  });
}

/**
 * Status-path provider budget, aligned with the provider clients' own
 * 60 s ceiling. A round-trip that exceeds this is treated as a transient
 * miss — the caller returns the deterministic fallback for this render
 * WITHOUT persisting it as the day's assessment, so the next mount
 * re-attempts a real generation.
 */
export const STATUS_PROVIDER_TIMEOUT_MS = 60_000;
