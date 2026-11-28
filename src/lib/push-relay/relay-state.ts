/**
 * The relay state of a device as this server publishes it
 * (`push.device.relayState` on `/api/auth/me` and in the `POST /api/devices`
 * answer, `binding.state` of the device's push diagnostics, `relayState` of
 * the admin diagnostic). One rule for all three, so they never disagree.
 *
 * A `conflict` holds for {@link CONFLICT_SETTLE_MS}; after that it reads
 * `rebind_needed`, which the app answers with a fresh binding. The minute
 * pass stores the same (`expireRelayConflicts` in `binding.ts`); reading it
 * here as well keeps a late or paused worker from showing an expired
 * conflict.
 *
 * Beside it, the one rule for this server's own registration:
 * {@link relayRefusal} says whether the relay may be used for a purpose now
 * (a push, a Wallet signature or update push, the upkeep calls), and
 * {@link relayRoutes} whether a push takes the relay's route at all.
 * `one-home-guard.test.ts` keeps every other reading out.
 */

import { isCircuitOpen } from "@/lib/push-relay/circuit";
import type { RegistrationRow } from "@/lib/push-relay/registration";
import {
  STATUS_INTERVAL_MS,
  storedRelayStatus,
} from "@/lib/push-relay/relay-status";

/**
 * How long a `409 binding_conflict` holds before it turns into
 * `rebind_needed`: the relay's challenge is valid for 30 minutes, so a
 * conflict older than that is settled or will not be.
 */
export const CONFLICT_SETTLE_MS = 30 * 60_000;

/** The device's relay state as published at `now`. */
export function relayStateAt(
  device: { relayState: string; relayConflictAt: Date | null },
  now: Date = new Date(),
): string {
  if (device.relayState !== "conflict") return device.relayState;
  const at = device.relayConflictAt;
  return at && now.getTime() - at.getTime() < CONFLICT_SETTLE_MS
    ? "conflict"
    : "rebind_needed";
}

/**
 * Whether this server may use its relay registration for `purpose` now: the
 * one rule for every relay call that is not the registration itself.
 *
 * - `push`: a push or a Live Activity start, update or end (they ride
 *   `/v1/push`). Needs the registration, an instance that is neither ended
 *   nor suspended, a closed breaker and no pause the relay asked for.
 * - `wallet_sign` / `wallet_notify`: the Wallet endpoints. A Wallet call
 *   never speaks for the push path, so the breaker and a push pause do not
 *   hold it (`wallet.ts`); signing needs the relay's last status to say it
 *   signs passes for this instance.
 * - `upkeep`: the hourly status, receipts, the instance key and unbinds.
 *   Held by the breaker (its own probe asks instead) and by a pause; a
 *   suspended instance still asks, which is how it learns it is back.
 *
 * Read from stored state only; nothing here calls the relay.
 */
export type RelayPurpose = "push" | "wallet_sign" | "wallet_notify" | "upkeep";

/** Why the relay is not usable, closed. */
export type RelayRefusal =
  | "not_registered"
  | "ended"
  | "suspended"
  | "circuit_open"
  | "paused"
  | "no_wallet_signing";

type RelayRow = Pick<
  RegistrationRow,
  | "instanceId"
  | "state"
  | "circuitFailures"
  | "circuitOpenedAt"
  | "nextProbeAt"
  | "pausedUntil"
  | "relayStatus"
>;

/** States after which the registration carries nothing until it is made again. */
const ENDED_STATES: ReadonlySet<string> = new Set(["revoked", "deleting"]);

/**
 * Whether a push may be routed over the relay: this server is registered and
 * the instance has not ended. What else holds a push (breaker, pause,
 * suspension) holds it in the outbox, on the relay's route.
 */
export function relayRoutes(
  row: Pick<RegistrationRow, "instanceId" | "state"> | null,
): boolean {
  return Boolean(row?.instanceId) && !ENDED_STATES.has(row!.state);
}

/** What keeps `row` from `purpose` now, or null when nothing does. */
export function relayRefusal(
  row: RelayRow | null,
  purpose: RelayPurpose,
  now: Date = new Date(),
): RelayRefusal | null {
  if (!row?.instanceId) return "not_registered";
  if (!relayRoutes(row)) return "ended";
  if (purpose === "wallet_sign" || purpose === "wallet_notify") {
    if (row.state === "suspended") return "suspended";
    const signs = storedRelayStatus(row.relayStatus ?? null)?.wallet?.sign;
    return purpose === "wallet_sign" && signs !== true
      ? "no_wallet_signing"
      : null;
  }
  if (purpose === "push" && row.state === "suspended") return "suspended";
  if (isCircuitOpen(row)) return "circuit_open";
  if (row.pausedUntil && row.pausedUntil > now) return "paused";
  return null;
}

export function relayUsable(
  row: RelayRow | null,
  purpose: RelayPurpose,
  now: Date = new Date(),
): boolean {
  return relayRefusal(row, purpose, now) === null;
}

/** Whether the hourly status is due for `row`. */
export function statusCheckDue(row: RegistrationRow, now: Date): boolean {
  if (!relayUsable(row, "upkeep", now)) return false;
  return (
    !row.statusCheckedAt ||
    now.getTime() - row.statusCheckedAt.getTime() >= STATUS_INTERVAL_MS
  );
}
