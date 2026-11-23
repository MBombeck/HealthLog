/**
 * The relay's own account of this instance, asked once an hour with a
 * signed `GET /v1/status` (`spec/protocol.md`, "Status"), so what the relay
 * knows reaches this server without waiting for a push:
 *
 * - `401 unknown_instance` (the relay forgot or removed the instance): the
 *   registration goes back to `pending`, every device to `rebind_needed`,
 *   and the minute pass registers again (`registration.ts`);
 * - the relay's state: `degraded`, `maintenance` or `misconfigured` make this
 *   server's relay state `degraded` with the reason `relay_<state>`, until
 *   the relay reports `ok` again or Apple takes a push through it;
 * - the operator notice, the tier, and the instance's device counts at the
 *   relay (`relayStatus`, shown on the admin relay card).
 *
 * One request an hour. It is not asked while the breaker is open (the
 * breaker's own probe is the same request, every one to five minutes), while
 * the relay asked this server to pause, or for a revoked instance.
 */
import { isCircuitOpen } from "@/lib/push-relay/circuit";
import type { RegistrationRow } from "@/lib/push-relay/registration";

export const STATUS_INTERVAL_MS = 60 * 60_000;

/** The relay states `GET /v1/status` reports. */
const RELAY_STATES = [
  "ok",
  "degraded",
  "maintenance",
  "misconfigured",
] as const;
export type RelayReportedState = (typeof RELAY_STATES)[number];

/**
 * This server's reasons for a state the relay reported about itself. A push
 * the relay answers `200` does not clear one of them; one that Apple
 * accepted does, and so does the next status that says `ok`.
 */
export const RELAY_REPORTED_REASONS: ReadonlySet<string> = new Set(
  RELAY_STATES.filter((s) => s !== "ok").map((s) => `relay_${s}`),
);

/** What the admin card shows of the last status answer. */
export interface RelayStatusSnapshot {
  /** When the relay answered, ISO. */
  at: string;
  state: RelayReportedState;
  devices: { active: number; provisional: number; limit: number } | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : null;
}

/**
 * The status answer as stored: closed values only, nothing the relay could
 * use to put free text in front of the operator. Null when the body is not
 * a status answer.
 */
export function relayStatusOf(
  body: Record<string, unknown> | null,
  now: Date,
): RelayStatusSnapshot | null {
  const state = body?.state;
  if (!RELAY_STATES.includes(state as RelayReportedState)) return null;
  const d = body?.devices as Record<string, unknown> | null | undefined;
  const active = count(d?.active);
  const provisional = count(d?.provisional);
  const limit = count(d?.limit);
  return {
    at: now.toISOString(),
    state: state as RelayReportedState,
    devices:
      active !== null && provisional !== null && limit !== null
        ? { active, provisional, limit }
        : null,
  };
}

/** This server's state and reason for a reported relay state. */
export function stateForReported(state: RelayReportedState): {
  state: "ok" | "degraded";
  reason: string | null;
} {
  return state === "ok"
    ? { state: "ok", reason: null }
    : { state: "degraded", reason: `relay_${state}` };
}

/** Whether the answer to a push carries at least one item Apple accepted. */
export function anyItemAccepted(body: Record<string, unknown> | null): boolean {
  const results = body?.results;
  return (
    Array.isArray(results) &&
    results.some(
      (r) =>
        (r as { status?: unknown; result?: unknown })?.status === 200 &&
        (r as { result?: unknown }).result === "accepted",
    )
  );
}

/** Whether the hourly status is due for `row`. */
export function statusCheckDue(row: RegistrationRow, now: Date): boolean {
  if (!row.instanceId || isCircuitOpen(row)) return false;
  if (row.state === "revoked" || row.state === "deleting") return false;
  if (row.pausedUntil && row.pausedUntil > now) return false;
  return (
    !row.statusCheckedAt ||
    now.getTime() - row.statusCheckedAt.getTime() >= STATUS_INTERVAL_MS
  );
}

/** The stored snapshot (`relayStatus`), read back defensively. */
export function storedRelayStatus(value: unknown): RelayStatusSnapshot | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) {
    return null;
  }
  return relayStatusOf(v, new Date(v.at));
}
