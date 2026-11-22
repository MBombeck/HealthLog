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
 */

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
