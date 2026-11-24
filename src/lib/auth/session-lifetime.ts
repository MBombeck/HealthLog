/**
 * How long a sign-in lasts.
 *
 * Two clocks bound every credential that renews itself:
 *
 *   - the idle timeout slides: each use moves the end further out, so a
 *     session nobody touches ends on its own;
 *   - the absolute lifetime does not: it counts from the sign-in itself, so a
 *     session in daily use still ends and the person proves who they are again.
 *
 * The idle clock alone meant a browser or a phone in regular use stayed signed
 * in for ever. The absolute clock is what makes a stolen cookie or refresh
 * token worth a bounded amount of time, however carefully the thief keeps it
 * warm.
 *
 * | credential                      | idle (slides)          | absolute (from sign-in)            |
 * | ------------------------------- | ---------------------- | ---------------------------------- |
 * | web session cookie              | SESSION_IDLE_TIMEOUT_DAYS (30) | SESSION_MAX_LIFETIME_DAYS (90)     |
 * | native refresh-token family     | 60 days per rotation   | REFRESH_TOKEN_MAX_LIFETIME_DAYS (180) |
 * | MCP OAuth connection            | 30 days per rotation   | REFRESH_TOKEN_MAX_LIFETIME_DAYS (180) |
 *
 * An operator can shorten or lengthen each within its bounds. A value that is
 * not a whole number inside the bounds is not guessed at: the default is used
 * and the boot log says so once, so a typo can never quietly turn the limit
 * off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface DaysSetting {
  name: string;
  fallback: number;
  min: number;
  max: number;
}

export const SESSION_IDLE_TIMEOUT: DaysSetting = {
  name: "SESSION_IDLE_TIMEOUT_DAYS",
  fallback: 30,
  min: 1,
  max: 90,
};

export const SESSION_MAX_LIFETIME: DaysSetting = {
  name: "SESSION_MAX_LIFETIME_DAYS",
  fallback: 90,
  min: 1,
  max: 365,
};

export const REFRESH_TOKEN_MAX_LIFETIME: DaysSetting = {
  name: "REFRESH_TOKEN_MAX_LIFETIME_DAYS",
  fallback: 180,
  min: 1,
  max: 730,
};

const warned = new Set<string>();

/** Whole days from the environment, or the default when the value is unusable. */
export function readDays(
  setting: DaysSetting,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[setting.name]?.trim();
  if (!raw) return setting.fallback;
  const days = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(days) && days >= setting.min && days <= setting.max)
    return days;
  if (!warned.has(setting.name)) {
    warned.add(setting.name);
    console.warn(
      `[auth] ${setting.name} must be a whole number of days from ${setting.min} to ${setting.max}; using ${setting.fallback}.`,
    );
  }
  return setting.fallback;
}

export function sessionIdleTimeoutMs(): number {
  return readDays(SESSION_IDLE_TIMEOUT) * DAY_MS;
}

export function sessionMaxLifetimeMs(): number {
  return readDays(SESSION_MAX_LIFETIME) * DAY_MS;
}

export function refreshTokenMaxLifetimeMs(): number {
  return readDays(REFRESH_TOKEN_MAX_LIFETIME) * DAY_MS;
}

/** The instant a web session signed in at `createdAt` ends for good. */
export function webSessionHardEnd(createdAt: Date): Date {
  return new Date(createdAt.getTime() + sessionMaxLifetimeMs());
}

/** Whether a web session is inside both its idle expiry and its absolute end. */
export function isWebSessionLive(
  session: { createdAt: Date; expiresAt: Date },
  now = new Date(),
): boolean {
  return session.expiresAt >= now && webSessionHardEnd(session.createdAt) > now;
}

/**
 * The expiry a web session carries after a use at `now`: the idle window from
 * now, never past its absolute end.
 */
export function webSessionExpiry(createdAt: Date, now = new Date()): Date {
  const idleEnd = now.getTime() + sessionIdleTimeoutMs();
  return new Date(Math.min(idleEnd, webSessionHardEnd(createdAt).getTime()));
}

/**
 * The expiry to write after a use of a web session, or null when the stored
 * one stands. The idle window moves at most once a day and never past the
 * absolute end; once the expiry has reached that end it stops moving and the
 * session runs out there, however busy it is. An expiry further out than the
 * settings now allow (the operator shortened the idle timeout) is pulled in.
 */
export function slidWebSessionExpiry(
  createdAt: Date,
  expiresAt: Date,
  now = new Date(),
): Date | null {
  const next = webSessionExpiry(createdAt, now);
  const drift = next.getTime() - expiresAt.getTime();
  return drift >= DAY_MS || drift < 0 ? next : null;
}

/** The instant a refresh family (native app or MCP connection) ends for good. */
export function refreshFamilyHardEnd(familyStartedAt: Date): Date {
  return new Date(familyStartedAt.getTime() + refreshTokenMaxLifetimeMs());
}

/** `at`, or the family's absolute end when that comes first. */
export function capAtRefreshFamilyEnd(at: Date, familyStartedAt: Date): Date {
  const end = refreshFamilyHardEnd(familyStartedAt).getTime();
  return at.getTime() <= end ? at : new Date(end);
}

/** Seconds until `at`, never negative: a cookie `Max-Age`. */
export function secondsUntil(at: Date, now = Date.now()): number {
  return Math.max(0, Math.floor((at.getTime() - now) / 1000));
}
