/**
 * v1.4.28 R3a FB-D2 — race an awaited promise against a hard timeout.
 *
 * The seven `*-status.ts` routes await `provider.generateCompletion()`
 * with no client-side timeout. When the upstream provider stalls (cold
 * cache, transient brown-out) React-Query's three default retries plus
 * default exponential backoff stacks on top of the upstream latency
 * and the InsightStatusCard spins for up to 90 s before the user sees
 * either the cached fallback text or a generic failure.
 *
 * `withTimeout(promise, ms, fallback)` resolves with the wrapped
 * promise's value when it lands inside the budget, or the `fallback`
 * value otherwise. Use the `signal` payload to abort upstream work so
 * the original promise does not keep consuming a provider slot after
 * the caller has moved on.
 *
 * Returns a typed envelope so the call site can distinguish "timed
 * out" from "the upstream returned this value" without re-encoding
 * the fallback as a magic string.
 */
export interface TimeoutEnvelope<T> {
  timedOut: boolean;
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
      resolve({ timedOut: true, value: fallback });
    }, ms);

    start()
      .then((value) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve({ timedOut: false, value });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // Upstream errored before the timeout fired — surface the
        // fallback so the route still returns a deterministic shape
        // and the caller does not have to learn another failure mode.
        resolve({ timedOut: true, value: fallback });
      });
  });
}

/**
 * The 20-second cap shipped in v1.4.28. Provider round-trips that
 * exceed this budget are converted to a cached-fallback render with a
 * "couldn't reach provider" caption on the InsightStatusCard.
 */
export const STATUS_PROVIDER_TIMEOUT_MS = 20_000;
