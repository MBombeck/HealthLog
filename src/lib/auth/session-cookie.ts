/**
 * The browser session cookie's name, and the one way to read and clear it.
 *
 * A cookie named `healthlog_session` can be set by any host under the same
 * registrable domain: a page on `other.example.com` may write one with
 * `Domain=example.com`, and the browser sends it to `health.example.com`
 * alongside, or instead of, the server's own. That lets a sibling subdomain
 * plant a session of its choosing in a visitor's browser. A cookie whose name
 * starts with `__Host-` is accepted by the browser only when it is `Secure`,
 * has `Path=/` and carries no `Domain`, so only this exact host can have set
 * it.
 *
 * So wherever the session cookie is `Secure` (`shouldEmitSecureCookie()`),
 * it is issued as `__Host-healthlog_session`. A plain-HTTP install cannot
 * hold a `__Host-` cookie and keeps the old name.
 *
 * The transition signs nobody out: the old name is still read, after the new
 * one, and `getSession()` re-issues a session found under the old name under
 * the new one and expires the old cookie. A browser that holds the new
 * cookie is never answered from the old one, so once a person has been seen
 * once after the upgrade, a planted old-name cookie no longer reaches them.
 *
 * Nothing here imports the database, so the proxy can use it.
 */
import { shouldEmitSecureCookie } from "./secure-cookie";

/** The name every release before this one used, and plain-HTTP installs keep. */
export const LEGACY_SESSION_COOKIE = "healthlog_session";

/** The name a `Secure` session cookie is issued under. */
export const HOST_SESSION_COOKIE = "__Host-healthlog_session";

/** The names a session cookie is read under, in the order they are tried. */
export const SESSION_COOKIE_NAMES = [
  HOST_SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
] as const;

export type SessionCookieName = (typeof SESSION_COOKIE_NAMES)[number];

/** The name a session cookie issued now is set under. */
export function sessionCookieName(): SessionCookieName {
  return shouldEmitSecureCookie() ? HOST_SESSION_COOKIE : LEGACY_SESSION_COOKIE;
}

interface CookieReader {
  get(name: string): { value: string } | undefined;
}

interface CookieStore extends CookieReader, CookieWriter {
  delete(name: string): unknown;
}

interface CookieWriter {
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      maxAge: number;
      path: string;
    },
  ): unknown;
}

/** The session cookie a request carries, under whichever name it came. */
export function readSessionCookie(
  jar: CookieReader,
): { name: SessionCookieName; value: string } | null {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = jar.get(name)?.value;
    if (value) return { name, value };
  }
  return null;
}

/** Whether a raw `Cookie` header carries a session cookie under either name. */
export function cookieHeaderCarriesSession(header: string | null): boolean {
  if (!header) return false;
  return header
    .split(/;\s*/)
    .some((pair) =>
      SESSION_COOKIE_NAMES.some((name) => pair.startsWith(`${name}=`)),
    );
}

/** The attributes the session cookie is issued with. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // A `__Host-` cookie is refused by the browser without `Secure`; the
    // name and the flag come from the same switch.
    secure: shouldEmitSecureCookie(),
    // OAuth callbacks (e.g. Withings) arrive via top-level cross-site
    // redirect. Lax keeps CSRF protection for unsafe methods while allowing
    // this flow.
    sameSite: "lax" as const,
    maxAge: maxAgeSeconds,
    path: "/",
  };
}

/**
 * Set the session cookie under the name this install issues, and expire a
 * cookie under the old name the request still carried, so a browser holds
 * one session cookie, not two.
 */
export function issueSessionCookie(
  store: CookieStore,
  value: string,
  maxAgeSeconds: number,
): void {
  const name = sessionCookieName();
  store.set(name, value, sessionCookieOptions(maxAgeSeconds));
  if (name !== LEGACY_SESSION_COOKIE && store.get(LEGACY_SESSION_COOKIE)) {
    store.delete(LEGACY_SESSION_COOKIE);
  }
}

/**
 * Expire the session cookie under both names. The `__Host-` one is
 * overwritten with `Secure` and `Path=/`, without which the browser ignores
 * the overwrite and the cookie stays; the old name is deleted as it always
 * was.
 */
export function expireSessionCookies(
  jar: CookieWriter & { delete(name: string): unknown },
): void {
  jar.set(HOST_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  jar.delete(LEGACY_SESSION_COOKIE);
}
