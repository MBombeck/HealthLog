/**
 * The per-account half of the password sign-in throttle.
 *
 * The per-IP bucket on the login route is only as good as the address it is
 * keyed on, so a second limit follows the account wherever the guesses come
 * from. It used to be a hard ceiling: ten failures in fifteen minutes and the
 * account refused every password, charged before the password was checked.
 * That made the owner's own sign-in a thing anybody could switch off. Ten
 * wrong guesses from two addresses locked a password-only account, the phone
 * app's password sign-in with it, and repeating them every fifteen minutes
 * kept it locked for as long as the person bothered.
 *
 * Two changes answer that.
 *
 * A place the account has signed in from before is not counted and not
 * blocked. "Before" means a remembered browser (the trusted-device cookie,
 * checked without being spent) or a phone that presents the device id a
 * login of this account was issued to. The guesser is by definition
 * somewhere the account has not signed in from; the owner mostly is not. The
 * per-IP limit still applies to every caller.
 *
 * An address the account signed in from used to count as such a place. An
 * address is the one thing about a request a guesser can most easily claim:
 * in a household or an office it is shared with the owner, and a caller that
 * reached the server directly could name it in a forwarding header. Claiming
 * it switched this whole throttle off.
 *
 * Everywhere else gets a growing wait instead of a wall. Five failures a day
 * cost nothing; after that each failure makes the next attempt wait twice as
 * long as the last, starting at thirty seconds and never more than fifteen
 * minutes. A guesser gets a handful of tries an hour, which is as hopeless as
 * the old ceiling, and the owner on a new network waits minutes at worst,
 * never indefinitely.
 *
 * An identifier that names no account runs the same arithmetic on its hash,
 * so a wait says nothing about whether the account exists.
 */
import type { User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { TRUSTED_DEVICE_COOKIE } from "@/lib/auth/trusted-device";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";
import type { RateLimitSnapshot } from "@/lib/rate-limit-context";
import { cookies } from "next/headers";

const BUCKET = "auth:login:account";
/** Failures a day an unknown place may make before it starts waiting. */
export const FREE_FAILURES = 5;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The first wait, doubled by every further failure. */
export const BASE_WAIT_MS = 30 * 1000;
/** No wait is ever longer than this. */
export const MAX_WAIT_MS = 15 * 60 * 1000;
/**
 * The failure counter is read, not enforced, so its ceiling only has to be
 * out of reach; `limit - remaining` is the count.
 */
const COUNTER_CEILING = 1_000_000;

export type KnownSource = "trusted_device" | "device_id";

/**
 * Has this account signed in from where this request comes from? Read-only:
 * nothing here spends the trusted device or touches a row.
 */
export async function knownSignInSource(
  userId: string,
  request: Request,
): Promise<KnownSource | null> {
  // The same clock as the throttle's own wait (`Date.now()`), so one instant
  // decides both.
  const now = new Date(Date.now());

  let deviceToken: string | undefined;
  try {
    deviceToken = (await cookies()).get(TRUSTED_DEVICE_COOKIE)?.value;
  } catch {
    deviceToken = undefined;
  }
  if (deviceToken) {
    const row = await prisma.trustedDevice.findUnique({
      where: { tokenHash: hashToken(deviceToken) },
      select: { userId: true, expiresAt: true },
    });
    if (row && row.userId === userId && row.expiresAt > now) {
      return "trusted_device";
    }
  }

  const deviceId = request.headers.get("x-device-id")?.trim();
  if (deviceId && deviceId.length <= 200) {
    const login = await prisma.refreshToken.findFirst({
      where: { userId, deviceId },
      select: { id: true },
    });
    if (login) return "device_id";
  }

  return null;
}

/** How long the next attempt waits after this many failures in a day. */
export function waitAfter(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  const doublings = Math.min(failures - FREE_FAILURES, 20);
  return Math.min(BASE_WAIT_MS * 2 ** doublings, MAX_WAIT_MS);
}

export interface AccountLoginAttempt {
  /** Set when the attempt must not proceed: the wait still running. */
  waiting: RateLimitSnapshot | null;
  /** Where the attempt comes from, when the account has signed in there. */
  source: KnownSource | null;
  /** The password was wrong. */
  failed(): Promise<void>;
  /** The password was right: this was not a guess. */
  succeeded(): Promise<void>;
}

const noop = async () => {};

/**
 * Decide whether a password attempt against this account (or this unknown
 * identifier) may be checked at all, before the Argon2id verification runs.
 */
export async function beginAccountLoginAttempt(args: {
  user: Pick<User, "id"> | null;
  identifier: string;
  request: Request;
}): Promise<AccountLoginAttempt> {
  const { user, identifier, request } = args;

  if (user) {
    const source = await knownSignInSource(user.id, request);
    if (source) {
      return { waiting: null, source, failed: noop, succeeded: noop };
    }
  }

  const key = user
    ? `${BUCKET}:u:${user.id}`
    : `${BUCKET}:i:${hashToken(identifier.toLowerCase())}`;
  const waitKey = `${key}:wait`;

  const wait = await prisma.rateLimit.findUnique({
    where: { key: waitKey },
    select: { resetAt: true },
  });
  if (wait && wait.resetAt.getTime() > Date.now()) {
    return {
      waiting: {
        limit: FREE_FAILURES,
        remaining: 0,
        resetAt: wait.resetAt.getTime(),
      },
      source: null,
      failed: noop,
      succeeded: noop,
    };
  }

  // Charged before the verification so a failure is counted even if the
  // request dies after it; given back when the password turns out right.
  const counted = await checkRateLimit(key, COUNTER_CEILING, FAILURE_WINDOW_MS);
  const failures = counted.limit - counted.remaining;

  return {
    waiting: null,
    source: null,
    failed: async () => {
      const ms = waitAfter(failures);
      if (ms === 0) return;
      const resetAt = new Date(Date.now() + ms);
      await prisma.rateLimit.upsert({
        where: { key: waitKey },
        create: { key: waitKey, count: 1, resetAt },
        update: { count: 1, resetAt },
      });
    },
    succeeded: () => refundRateLimit(key),
  };
}
