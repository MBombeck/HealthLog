/**
 * The breaker this server keeps per relay registration, as pure transitions.
 *
 * Opens after three consecutive transport failures: no connection, a
 * timeout, a response without a valid relay signature, or a `502`/`503`/`504`
 * without a retry hint. While open nothing is sent item by item; a signed
 * `GET /v1/status` probes every 60 s for the first 15 minutes, then every
 * 5 minutes. A probe that succeeds closes it. Refusals the relay explains
 * (`429` with a scope, `503` with `Retry-After`) never count: they pause the
 * instance instead (`pausedUntil`).
 *
 * None of this ever touches a device or a notification channel.
 */
export const CIRCUIT_THRESHOLD = 3;
const PROBE_FAST_MS = 60_000;
const PROBE_SLOW_MS = 5 * 60_000;
const FAST_PHASE_MS = 15 * 60_000;

export interface CircuitState {
  circuitFailures: number;
  circuitOpenedAt: Date | null;
  nextProbeAt: Date | null;
}

export function isCircuitOpen(state: CircuitState): boolean {
  return state.circuitOpenedAt !== null;
}

/** Whether an open breaker is due for its status probe. */
export function probeDue(state: CircuitState, now: Date): boolean {
  return (
    state.circuitOpenedAt !== null &&
    (state.nextProbeAt === null || state.nextProbeAt <= now)
  );
}

function nextProbe(openedAt: Date, now: Date): Date {
  const fast = now.getTime() - openedAt.getTime() < FAST_PHASE_MS;
  return new Date(now.getTime() + (fast ? PROBE_FAST_MS : PROBE_SLOW_MS));
}

/** The state after a transport failure. */
export function afterTransportFailure(
  state: CircuitState,
  now: Date,
): CircuitState {
  const failures = state.circuitFailures + 1;
  if (state.circuitOpenedAt) {
    return {
      circuitFailures: failures,
      circuitOpenedAt: state.circuitOpenedAt,
      nextProbeAt: nextProbe(state.circuitOpenedAt, now),
    };
  }
  if (failures >= CIRCUIT_THRESHOLD) {
    return {
      circuitFailures: failures,
      circuitOpenedAt: now,
      nextProbeAt: new Date(now.getTime() + PROBE_FAST_MS),
    };
  }
  return {
    circuitFailures: failures,
    circuitOpenedAt: null,
    nextProbeAt: null,
  };
}

/** The state after the relay answered with a signed response. */
export function afterSignedResponse(): CircuitState {
  return { circuitFailures: 0, circuitOpenedAt: null, nextProbeAt: null };
}

/**
 * Whether a signed response counts as a transport failure: `502`, `503` or
 * `504` without a retry hint at request level.
 */
export function isTransportLikeStatus(
  status: number,
  retryAfter: number | null,
  body: Record<string, unknown> | null,
): boolean {
  const hinted =
    retryAfter !== null ||
    (typeof body?.retryAfter === "number" && body.retryAfter > 0);
  return (status === 502 || status === 503 || status === 504) && !hinted;
}
