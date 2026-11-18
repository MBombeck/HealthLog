import { prisma } from "@/lib/db";

/**
 * #179 — `Device.lastSeen` moves on use, not only at registration.
 *
 * The app decides from `lastSeen` whether another device on the account is
 * still active (an iPad plans medication reminders itself only while no
 * iPhone was seen for seven days). Registration alone left an iPhone that
 * stays open for a week looking idle. So every request on the app's token
 * stamps the device that token belongs to.
 *
 * Which device: the one the token's own refresh family names. A native
 * sign-in or refresh stores the access token's hash beside the refresh row
 * (`RefreshToken.accessTokenHash`) and the `Device.token` the app sent in
 * `X-Device-Id` (`RefreshToken.deviceId`), so the link is server-derived,
 * not read off the request. A token with no such link (one minted before the
 * app sent a device id, or any token that is not a sign-in token) stamps
 * nothing; the app's register on foreground (`POST /api/devices`) keeps
 * covering those, as before.
 *
 * Cost: at most one attempt per token and hour from this process, and the
 * statement itself only writes a row last stamped over an hour ago, so
 * several instances behind one database still write at most about once an
 * hour per device. Both instants are bound as UTC values rather than
 * computed by the database, so the session time zone cannot shift them.
 *
 * Fire-and-forget, like `ApiToken.lastUsedAt`: the request never waits for
 * it, and nothing here can fail it.
 */
export const DEVICE_LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000;

/** Bounds the per-process memo; clearing it only costs a few extra no-ops. */
const MAX_TRACKED_TOKENS = 10_000;

const lastAttempt = new Map<string, number>();

export function stampDeviceLastSeen(
  userId: string,
  tokenId: string,
  nowMs: number = Date.now(),
): void {
  const previous = lastAttempt.get(tokenId);
  if (
    previous !== undefined &&
    nowMs - previous < DEVICE_LAST_SEEN_INTERVAL_MS
  ) {
    return;
  }
  if (lastAttempt.size >= MAX_TRACKED_TOKENS) lastAttempt.clear();
  lastAttempt.set(tokenId, nowMs);

  const now = new Date(nowMs);
  const staleBefore = new Date(nowMs - DEVICE_LAST_SEEN_INTERVAL_MS);
  try {
    void Promise.resolve(
      prisma.$executeRaw`
        UPDATE devices AS d
           SET last_seen = ${now}
          FROM api_tokens AS t
          JOIN refresh_tokens AS r
            ON r.access_token_hash = t.token_hash
           AND r.user_id = t.user_id
         WHERE t.id = ${tokenId}
           AND t.user_id = ${userId}
           AND r.device_id IS NOT NULL
           AND d.user_id = t.user_id
           AND d.token = r.device_id
           AND d.last_seen < ${staleBefore}
      `,
    ).catch(() => {});
  } catch {
    // A client that cannot even build the statement must not fail the request.
  }
}

/** Test seam: forget every attempt this process made. */
export function resetDeviceLastSeenThrottle(): void {
  lastAttempt.clear();
}
