/**
 * The one way a push registration is deleted because a push service said it
 * is gone: an APNs `Unregistered` / `BadDeviceToken` / `DeviceTokenNotForTopic`
 * on an alert or a silent push, an `Unregistered` the relay passed on, a Live
 * Activity the relay reported gone on an update, a Web Push 404 / 410.
 *
 * Why it is one function. A wrong APNs topic or bundle id, or a key for the
 * wrong environment, makes Apple answer `DeviceTokenNotForTopic` or
 * `BadDeviceToken` for every device, and every path that trusted the verdict
 * deleted every registration on the instance, one push at a time. So every
 * such verdict passes a breaker first: more than `GONE_LIMIT` registrations
 * of one channel reported gone inside `GONE_WINDOW_MS` is read as a
 * configuration error, not as that many uninstalls. The breaker then holds
 * every deletion of that channel for `GONE_HOLD_MS`, logs once, and shows on
 * the admin status page among the failing background jobs
 * ({@link readGoneHolds}). A single device that is really gone is still
 * deleted at once.
 *
 * What it costs. Verdicts arrive one dispatch at a time, so a broken
 * configuration still deletes up to `GONE_LIMIT` registrations per channel
 * before the breaker opens, and again once a day while it stays broken. A
 * batch larger than the limit (one fan-out that reports them all at once) is
 * held whole. An instance where more than `GONE_LIMIT` devices really go in
 * ten minutes keeps their rows for a day; a dead row costs a refused push.
 *
 * The window and the hold live in `rate_limits`, the table every rate limit
 * uses, behind the same atomic upsert, so the count and the hold hold across
 * a web process, a worker process and several instances alike. A failure to
 * reach the table holds the deletion: a registration kept is a push refused,
 * a registration lost is a device that stays silent until the app reopens.
 *
 * `src/__tests__/push-registration-delete-guard.test.ts` holds every
 * verdict-driven deletion to this module. A new registration kind (the Wallet
 * pass tokens) is one more value of {@link GoneKind}.
 */
import { prisma } from "@/lib/db";
import { deleteDeviceRows } from "@/lib/devices/delete-devices";
import { getEvent } from "@/lib/logging/context";

/** The breakers: one per push service whose configuration can be wrong. */
export type GoneChannel = "apns" | "live-activity" | "web-push";

/**
 * What holds a registration a push service reported gone: a device row (an
 * APNs verdict on an alert, a silent push or a relayed push), a Live Activity
 * token row (the relay reported it gone on an update), a Web Push
 * subscription (404 / 410).
 */
export type GoneKind = "device" | "liveActivityToken" | "webPush";

const CHANNEL: Record<GoneKind, GoneChannel> = {
  device: "apns",
  liveActivityToken: "live-activity",
  webPush: "web-push",
};

/** Registrations of one channel reported gone in a window before it holds. */
export const GONE_LIMIT = 5;
/** The window the limit counts in. */
const GONE_WINDOW_MINUTES = 10;
export const GONE_WINDOW_MS = GONE_WINDOW_MINUTES * 60_000;
/** How long a tripped breaker holds every deletion of its channel. */
const GONE_HOLD_HOURS = 24;
export const GONE_HOLD_MS = GONE_HOLD_HOURS * 3600_000;

const windowKey = (channel: GoneChannel) => `push-gone:${channel}`;
const holdKey = (channel: GoneChannel) => `push-gone-hold:${channel}`;
const HOLD_PREFIX = "push-gone-hold:";

/**
 * Delete the registrations a push service reported gone, unless the breaker
 * of their channel holds. Returns true when they were deleted (or there was
 * nothing to delete), false when the breaker kept them. Never throws.
 */
export async function forgetGoneRegistrations(
  kind: GoneKind,
  goneIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(goneIds)];
  if (ids.length === 0) return true;
  const channel = CHANNEL[kind];
  let admitted: boolean;
  try {
    admitted = await admitGone(channel, ids.length);
  } catch (err) {
    getEvent()?.addWarning(
      `push_gone_breaker_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (!admitted) {
    getEvent()?.addMeta("push_gone_held", `${channel}:${ids.length}`);
    return false;
  }
  try {
    if (kind === "device") {
      await deleteDeviceRows({ id: { in: ids } });
    } else if (kind === "liveActivityToken") {
      await prisma.liveActivityToken.deleteMany({ where: { id: { in: ids } } });
    } else {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: ids } } });
    }
  } catch (err) {
    // Best effort, as every caller treated it: the next verdict tries again.
    getEvent()?.addWarning(
      `push_gone_delete_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return true;
}

/**
 * Count `n` verdicts against the channel's window; false while the channel
 * holds or once this batch takes the window over the limit.
 */
async function admitGone(channel: GoneChannel, n: number): Promise<boolean> {
  const held = await prisma.$queryRaw<{ key: string }[]>`
    SELECT key FROM rate_limits
    WHERE key = ${holdKey(channel)}
      AND reset_at > (NOW() AT TIME ZONE 'UTC')
  `;
  if (held.length > 0) return false;

  const windowInterval = `${GONE_WINDOW_MS} milliseconds`;
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (key, count, reset_at)
    VALUES (${windowKey(channel)}, ${n}, (NOW() AT TIME ZONE 'UTC') + ${windowInterval}::interval)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.reset_at < (NOW() AT TIME ZONE 'UTC') THEN ${n}
        ELSE rate_limits.count + ${n}
      END,
      reset_at = CASE
        WHEN rate_limits.reset_at < (NOW() AT TIME ZONE 'UTC') THEN (NOW() AT TIME ZONE 'UTC') + ${windowInterval}::interval
        ELSE rate_limits.reset_at
      END
    RETURNING count
  `;
  const count = Number(rows[0]?.count ?? 0);
  if (count <= GONE_LIMIT) return true;

  // Trip. The conditional upsert returns a row only to the caller that opened
  // the hold, so the log line is written once across processes.
  const holdInterval = `${GONE_HOLD_MS} milliseconds`;
  const opened = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO rate_limits (key, count, reset_at)
    VALUES (${holdKey(channel)}, ${count}, (NOW() AT TIME ZONE 'UTC') + ${holdInterval}::interval)
    ON CONFLICT (key) DO UPDATE SET
      count = EXCLUDED.count,
      reset_at = EXCLUDED.reset_at
    WHERE rate_limits.reset_at < (NOW() AT TIME ZONE 'UTC')
    RETURNING key
  `;
  if (opened.length > 0) {
    console.error(
      `[push] ${count} ${channel} registrations reported gone within ${GONE_WINDOW_MINUTES} minutes; ` +
        `deletions held for ${GONE_HOLD_HOURS} hours. Check the push configuration ` +
        `(APNs topic and bundle id, key environment, VAPID keys).`,
    );
    getEvent()?.addWarning(`push_gone_breaker_tripped: ${channel}`);
  }
  return false;
}

/** A tripped breaker, as the admin status page lists it. */
export interface GoneHold {
  channel: GoneChannel;
  /** Registrations reported gone in the window that tripped it. */
  count: number;
  /** When it tripped. */
  trippedAt: Date;
  /** When deletions resume. */
  until: Date;
}

/** Every breaker that holds now. Empty when none does or the read fails. */
export async function readGoneHolds(): Promise<GoneHold[]> {
  try {
    const rows = await prisma.$queryRaw<
      { key: string; count: number; reset_at: Date }[]
    >`
      SELECT key, count, reset_at FROM rate_limits
      WHERE key LIKE ${`${HOLD_PREFIX}%`}
        AND reset_at > (NOW() AT TIME ZONE 'UTC')
      ORDER BY key
    `;
    return rows.map((row) => ({
      channel: row.key.slice(HOLD_PREFIX.length) as GoneChannel,
      count: Number(row.count),
      trippedAt: new Date(row.reset_at.getTime() - GONE_HOLD_MS),
      until: row.reset_at,
    }));
  } catch {
    return [];
  }
}
