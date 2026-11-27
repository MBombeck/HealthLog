/**
 * The one reading of an APNs refusal, for alerts, silent pushes, Live
 * Activities and Wallet passes alike: does it say the device token itself is
 * dead?
 *
 * Only a token-specific permanent failure does: 410 (`Unregistered`,
 * `ExpiredToken`), or `BadDeviceToken` / `DeviceTokenNotForTopic` (400).
 * Everything else is about the sender, not the device: the certificate or
 * provider token (403), the topic or payload (other 400s, 413), throttling
 * (429), Apple being down (5xx). Those never drop a registration; the push
 * stays owed and the failure is reported.
 */
const TOKEN_GONE_REASONS: ReadonlySet<string> = new Set([
  "Unregistered",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);

export function apnsTokenGone(
  status: number | undefined,
  reason: string | undefined,
): boolean {
  return (
    status === 410 || (reason !== undefined && TOKEN_GONE_REASONS.has(reason))
  );
}
