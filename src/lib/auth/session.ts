import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { cookies } from "next/headers";
import type { User } from "@/generated/prisma/client";
import { hashToken } from "@/lib/auth/hmac";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { getEvent } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { isP2025 } from "@/lib/prisma-errors";
import { locales, type Locale } from "@/lib/i18n/config";
import { LOCALE_COOKIE, setLocaleCookie } from "@/lib/i18n/locale-cookie";

const SESSION_COOKIE = "healthlog_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Public name of the browser session cookie, for routes that read it off a
 * `NextRequest` directly (rather than through `getSession()`'s `cookies()`). */
export const SESSION_COOKIE_NAME = SESSION_COOKIE;

/**
 * Marks a cookie value as a v1.30.32 session secret. Doubles as the branch
 * between the two resolution paths below, so a cookie is only ever looked up
 * one way and a raw cuid can never be tried as a secret (or vice versa).
 */
const SESSION_TOKEN_PREFIX = "hls_";
const SESSION_SECRET_BYTES = 32;

/**
 * Mint a session cookie secret: 32 CSPRNG bytes, hex-encoded.
 *
 * This exists because the cookie used to carry `Session.id` — a `cuid()`.
 * cuid targets collision-resistant identity across distributed writers, not
 * unguessability: it encodes a millisecond timestamp and a process-local
 * counter and never touches a CSPRNG. That is a fine primary key and an unfit
 * bearer credential. Only `hashToken(secret)` reaches the database, so a
 * leaked table dump yields no usable cookie — the same posture ApiToken and
 * RefreshToken already hold.
 */
function mintSessionSecret(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(SESSION_SECRET_BYTES).toString("hex")}`;
}

/**
 * Resolve the session row a cookie value refers to, or null.
 *
 * COMPATIBILITY DECISION (v1.30.32). Two paths, and the transition is
 * deliberately passive:
 *
 *   1. `hls_…` — the modern secret. Looked up by `hashToken(value)`.
 *   2. anything else — a pre-upgrade cookie carrying the row's cuid. Accepted
 *      ONLY while that row's `tokenHash` is still NULL.
 *
 * A migration-time backfill cannot work: the cookie already in the user's
 * browser is the cuid, and no token we generate server-side can be pushed into
 * it. Backfilling would sign out every logged-in user at deploy — the one
 * outcome this change must not cause.
 *
 * Upgrading a legacy row in place on next use was the other candidate and was
 * rejected as unsafe. A browser fires several requests in parallel, all
 * carrying the same legacy cookie; each would mint its own secret and race to
 * claim the row. Exactly one write can win, and the losers cannot learn the
 * winner's secret to re-emit it — the row stores only a hash. Whichever
 * response reached the browser last would decide the cookie, and if that was a
 * loser's, the user is signed out. A guarded update narrows the write but not
 * the outcome: a loser that declines to re-cookie leaves the browser holding a
 * legacy id the row no longer honours. The race has no correct resolution, and
 * its failure mode is precisely the forced logout we are avoiding.
 *
 * So legacy rows are left alone and simply live out the expiry they already
 * have — `getSession` withholds the sliding-expiry extension from them (see
 * there). That bounds the id-as-credential path to the 30-day session lifetime
 * from the deploy, self-draining, with no operator step and no backfill. Every
 * login from the deploy onward is on a secret immediately.
 */
async function findSessionByCookie(cookieValue: string) {
  if (cookieValue.startsWith(SESSION_TOKEN_PREFIX)) {
    return prisma.session.findUnique({
      where: { tokenHash: hashToken(cookieValue) },
      include: { user: true },
    });
  }

  const legacy = await prisma.session.findUnique({
    where: { id: cookieValue },
    include: { user: true },
  });
  // A row that already holds a secret has retired its id as a credential.
  return legacy && legacy.tokenHash === null ? legacy : null;
}

/**
 * Validate a session straight from a raw cookie value — no `next/headers`,
 * no sliding-expiry write, no cookie mutation. Runs the same hardened lookup
 * `getSession()` uses (`hashToken` secret path or the passive legacy-cuid
 * path) plus an expiry check, and returns the resolved user, or null for a
 * missing / unknown / expired session.
 *
 * Exists for routes that must confirm an already-established session from a
 * `NextRequest` before they mint anything — notably the OIDC callback's
 * duplicate-detection path, which runs before session creation and must not
 * touch the cookie store. Presence of a cookie string is NOT enough: an
 * attacker controls that string, so the value is resolved against the
 * database and its expiry, exactly like the login path.
 */
export async function validateSessionFromCookieValue(
  cookieValue: string | undefined | null,
): Promise<{ session: { id: string; expiresAt: Date }; user: User } | null> {
  if (!cookieValue) return null;
  const session = await findSessionByCookie(cookieValue).catch(() => null);
  if (!session || session.expiresAt < new Date()) return null;
  return {
    session: { id: session.id, expiresAt: session.expiresAt },
    user: session.user,
  };
}

/**
 * Like `validateSessionFromCookieValue`, but ALSO projects `Session.createdAt`.
 *
 * Exists for the native web-handoff completion (`/api/auth/native/complete`),
 * whose load-bearing freshness binding compares `session.createdAt` against the
 * DB-clock `startedAt` stamped when the flow began. `validateSessionFromCookieValue`
 * deliberately does not return `createdAt`; wiring the completion route to it
 * would leave `createdAt` undefined and either refuse every completion or, worse,
 * tempt a caller to drop the comparison and delete the whole defence (red-team
 * A3). So the projection lives here, next to the primitive it mirrors, and the
 * completion route reads `createdAt` from a value that is structurally always
 * present.
 *
 * `createdAt` is immutable per login: `createSession` is insert-only and the
 * sliding-expiry / last-active writes never touch it, so it is reliably the
 * instant of THIS interactive login.
 */
export async function validateSessionWithCreatedAt(
  cookieValue: string | undefined | null,
): Promise<{
  session: { id: string; createdAt: Date; expiresAt: Date };
  user: User;
} | null> {
  if (!cookieValue) return null;
  const session = await findSessionByCookie(cookieValue).catch(() => null);
  if (!session || session.expiresAt < new Date()) return null;
  return {
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
    user: session.user,
  };
}

// v1.23 — throttle window for the user-facing active-session list's "last
// seen" stamp. A write only happens when the prior stamp is older than this,
// so the high-churn `getSession` path costs at most one extra UPDATE per
// session per window rather than one per request.
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * v1.4.22 C4 — flag cookie mirroring the user's `onboardingCompletedAt`
 * status. Set to `"pending"` while the field is null and cleared once
 * onboarding completes. The proxy reads this cookie to short-circuit
 * the post-hydration redirect that previously caused a dashboard flash
 * before the client-side `<AuthShell>` effect could fire.
 *
 * NOT httpOnly: the cookie is a UX hint, not a security signal — the
 * real gate stays the server-side onboarding-complete check in
 * `/api/onboarding/complete`. A user editing the cookie locally just
 * skips the dashboard flash; they still can't bypass any data check.
 */
const ONBOARDING_COOKIE = "hl_onboarding";

export async function setOnboardingPendingCookie(
  pending: boolean,
): Promise<void> {
  const cookieStore = await cookies();
  if (pending) {
    cookieStore.set(ONBOARDING_COOKIE, "pending", {
      httpOnly: false,
      secure: shouldEmitSecureCookie(),
      // v1.4.22 W5 reconcile (Sec-MED-1) — Strict (not Lax) because
      // no cross-site redirect flow ever depends on this cookie. The
      // sibling `healthlog_session` cookie stays Lax because the
      // Withings OAuth callback arrives via top-level cross-site
      // redirect; the onboarding hint has no equivalent flow.
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE_MS / 1000,
      path: "/",
    });
  } else {
    cookieStore.delete(ONBOARDING_COOKIE);
  }
}

/**
 * v1.4.22 W5 reconcile (Sr-H1) — `onboardingPending` is required
 * (not optional) so issuing a session without anchoring the
 * onboarding cookie is type-impossible. Every auth surface (login,
 * passkey-verify, register, password-reset) must thread the user's
 * `onboardingCompletedAt == null` value through. The onboarding
 * surface itself flips the cookie via `setOnboardingPendingCookie`
 * directly when the user hands in the form.
 */
export async function createSession(
  userId: string,
  onboardingPending: boolean,
  ipAddress?: string | null,
  userAgent?: string | null,
  // v1.23 — set when this session was minted behind a completed second
  // factor (the `/api/auth/mfa/verify` path) or a fresh factor re-confirm.
  // `requireFreshMfa` reads it for step-up freshness; a null value means
  // "single-factor session" and never satisfies step-up.
  mfaVerifiedAt?: Date | null,
): Promise<string> {
  // The secret is the cookie; the row id stays an internal identifier and is
  // never handed to the client.
  const secret = mintSessionSecret();
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(secret),
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      mfaVerifiedAt: mfaVerifiedAt ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    // OAuth callbacks (e.g. Withings) arrive via top-level cross-site redirect.
    // Lax keeps CSRF protection for unsafe methods while allowing this flow.
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS / 1000,
    path: "/",
  });

  // Anchor the onboarding cookie alongside the session cookie so a
  // future auth surface added without remembering the helper can never
  // reintroduce the dashboard flash.
  await setOnboardingPendingCookie(onboardingPending);

  return session.id;
}

export async function getSession(): Promise<{
  session: {
    id: string;
    expiresAt: Date;
    actingAsUserId: string | null;
    recordEpoch: number;
  };
  user: User;
} | null> {
  try {
    await ensureDbCompatibility();
  } catch (error) {
    getEvent()?.setError(
      error instanceof Error
        ? error
        : new Error("DB compatibility check failed"),
    );
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE)?.value;
  if (!cookieValue) return null;

  const session = await findSessionByCookie(cookieValue);

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.session
        .deleteMany({ where: { id: session.id } })
        .catch(() => {});
    }
    cookieStore.delete(SESSION_COOKIE);
    cookieStore.delete(ONBOARDING_COOKIE);
    return null;
  }

  // Sliding expiry: refresh if more than 1 day old.
  //
  // Withheld from legacy (`tokenHash === null`) rows on purpose. Extending
  // those would let a cuid-as-credential session renew itself indefinitely for
  // an active user, and the whole point of the passive transition is that the
  // id-resolvable path drains on its own. Capping them at the expiry they
  // already carry bounds it to at most 30 days past the deploy; the user then
  // logs in once and lands on a secret. Re-emitting the cookie is likewise
  // pointless for a legacy row — its value cannot be improved in place.
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (
    session.tokenHash !== null &&
    session.expiresAt.getTime() - Date.now() < SESSION_MAX_AGE_MS - oneDayMs
  ) {
    const newExpiry = new Date(Date.now() + SESSION_MAX_AGE_MS);
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: newExpiry },
    });
    cookieStore.set(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS / 1000,
      path: "/",
    });
  }

  // v1.23 — sliding "last seen" stamp for the active-session list. Throttled
  // (only when the prior stamp is stale) and fire-and-forget so it never adds
  // latency or a failure mode to the request-resolution path.
  const lastActive = session.lastActiveAt;
  if (
    !lastActive ||
    lastActive.getTime() < Date.now() - LAST_ACTIVE_THROTTLE_MS
  ) {
    void prisma.session
      .update({
        where: { id: session.id },
        data: { lastActiveAt: new Date() },
      })
      .catch(() => {});
  }

  const rawLocaleCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const cookieLocale =
    rawLocaleCookie && (locales as readonly string[]).includes(rawLocaleCookie)
      ? (rawLocaleCookie as Locale)
      : null;

  if (
    session.user.locale &&
    (locales as readonly string[]).includes(session.user.locale) &&
    !cookieLocale
  ) {
    // Locale-cookie refresh: Safari's ITP expires the script-written
    // `healthlog-locale` cookie after 7 days, so a returning user's first
    // paint fell back to the browser language once a week. When the user
    // has a persisted locale but the cookie is gone, re-emit it here —
    // Set-Cookie is exempt from the ITP cap. Fail-soft: in a
    // server-component render the cookie store is read-only and `set`
    // throws — the next route-handler request re-attempts.
    try {
      setLocaleCookie(cookieStore, session.user.locale as Locale);
    } catch {
      // Read-only cookie context — skip; nothing depends on this write.
    }
  } else if (cookieLocale && cookieLocale !== session.user.locale) {
    // The column follows the language the browser is actually reading.
    //
    // `User.locale` is the ONLY signal every cookie-blind path has: the
    // nightly briefing warm, the Coach nudge, the reminder senders and the
    // native aggregate all resolve from the column alone, while the screen
    // in front of the user resolves from this cookie first. The two can
    // therefore disagree indefinitely, and the disagreement is invisible —
    // it surfaces as one generated paragraph in the wrong language inside
    // an otherwise correct page.
    //
    // Keeping them in step used to be the client's job: a fire-and-forget
    // `PUT /api/auth/me/locale` from a mount effect, best-effort by
    // construction. A 401 on the paint before sign-in, an offline blip, a
    // tab closed mid-flight — every one of those loses the write silently,
    // and the next mount repeats the same unreliable attempt rather than
    // noticing the column is still wrong. So the column stayed on a
    // language the user had left behind, for as long as the account existed.
    //
    // This arm closes it from the side that cannot miss. The cookie is only
    // ever written alongside a committed UI locale (client `persistLocale`,
    // or this function's own refresh above), so it is a statement about what
    // the person is reading, not a guess: Accept-Language never reaches the
    // column this way. Fire-and-forget like the `lastActiveAt` stamp, and
    // self-limiting — once the two agree the condition is false and no
    // further write is attempted.
    //
    // A second browser whose cookie still carries the older choice will move
    // the column back. That is the same last-writer-wins the client PUT
    // already had, and it is coherent: that browser is showing the older
    // language too, because the cookie outranks the column on its first
    // paint as well.
    void prisma.user
      .update({
        where: { id: session.user.id },
        data: { locale: cookieLocale },
      })
      .catch(() => {});
    // Keep THIS request coherent — a handler resolving the locale from the
    // returned row must not answer with the value we just replaced.
    session.user.locale = cookieLocale;
  }

  return {
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
      // v1.36.0 — the acting-account CARRIER, projected because the row is
      // already in hand and re-reading it per request would be waste.
      //
      // Read this in exactly one place: the acting-account resolver in
      // `src/lib/api-handler.ts`. It is a selector and not a decision — the
      // resolver still has to find a live grant for the pair before anything
      // is substituted, and a value stranded here by a grant that has since
      // ended confers nothing.
      //
      // What this function returns for `user` does NOT change and must not:
      // `getSession()` answers "who is calling", and `requireAdmin`,
      // `requireCookieAuth` and `requireFreshMfa` are unreachable by a switch
      // precisely because that is the only thing it answers. Substituting the
      // owner here would put a delegate inside the admin check.
      // `src/__tests__/acting-account-boundary-guard.test.ts` freezes the set
      // of files allowed to touch this field.
      actingAsUserId: session.actingAsUserId,
      // v1.37.0 — the selector's move counter, projected off the same row for
      // the same reason. It is what makes the fence's central property true:
      // the epoch a request is validated against and the `actingAsUserId` the
      // handler is about to serve under are one row read, so they cannot
      // straddle a switch that landed between two queries.
      //
      // Written by a database trigger only (migration 0302); nothing in the
      // application assigns it, and the `BEFORE` timing means nothing can.
      recordEpoch: session.recordEpoch,
    },
    user: session.user,
  };
}

/**
 * Lightweight read of the signed-in user's persisted locale for the root
 * layout's first-paint language resolution. Deliberately NOT
 * `getSession()`: no db-compat check, no sliding-expiry write, no cookie
 * mutation — the root layout renders on every request in a context where
 * the cookie store is read-only, so the full session touch is both dead
 * weight and a throw hazard there. Returns null for missing/expired
 * sessions and users without a persisted locale.
 */
export async function getSessionUserLocale(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE)?.value;
  if (!cookieValue) return null;

  // Same two-path resolution as `getSession`, read-only: this runs in the root
  // layout where the cookie store cannot be written, so there is nothing to
  // refresh or clear here.
  const session = await findSessionByCookie(cookieValue);
  if (!session || session.expiresAt < new Date()) return null;
  return session.user.locale;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE)?.value;
  if (cookieValue) {
    // Resolve the cookie to its row before deleting — the cookie is a secret,
    // not the primary key, so `delete({ where: { id: cookieValue } })` would
    // silently no-op on every modern session and leave the row alive after a
    // logout.
    //
    // Logout is idempotent: a session row that no longer exists (P2025) is a
    // no-op. Any other failure is a real delete error — record it on the wide
    // event rather than swallowing it silently, but never block the cookie
    // clear below: a transient DB fault must not leave the client logged in
    // with the cookie intact.
    const session = await findSessionByCookie(cookieValue).catch(() => null);
    if (session) {
      await prisma.session
        .delete({ where: { id: session.id } })
        .catch((err) => {
          if (!isP2025(err)) {
            getEvent()?.addWarning(
              `destroySession delete failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
    }
  }
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(ONBOARDING_COOKIE);
}

/**
 * Revoke every authenticated surface a user owns: web sessions, API
 * tokens (long-lived Bearer credentials issued via `/settings/api-tokens`),
 * and native-client refresh tokens. Called from every credential-rotation
 * path (`/api/auth/password`, `/api/admin/users/[id]/reset-password`,
 * `DELETE /api/settings/account`) so a remediated user wipes a stolen
 * credential across every transport, not just the browser cookie.
 *
 * `ApiToken` flips `revoked=true` (the token-hash lookup at
 * `src/lib/auth/api-token.ts` filters on this column). `RefreshToken`
 * sets `revokedAt` (the rotation lookup at
 * `src/lib/auth/refresh-token.ts` short-circuits on a non-null value).
 * Both run as `updateMany` rather than `deleteMany` so the audit trail
 * survives — the rows linger as evidence of the rotation event.
 */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId } }),
    prisma.apiToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    // v1.23 — a credential rotation also kills every "remember this device"
    // trusted-device token: a stolen device cookie must not survive a
    // password change or account-credential remediation.
    prisma.trustedDevice.deleteMany({ where: { userId } }),
  ]);
}

/**
 * How the caller of a "revoke everything else" action authenticated.
 *
 * Exists so the caller's own credential can be spared without any code having
 * to guess what kind of id it is holding — see `destroyOtherSessions`.
 */
export type CurrentCredential =
  | { kind: "session"; sessionId: string }
  | { kind: "accessToken"; accessTokenHash: string };

/**
 * v1.23 — "sign out everywhere" for the user-facing active-session surface
 * (issue #64). Distinct from `destroyAllSessions`: this keeps the caller's
 * CURRENT credential alive so pressing the button does not sign out the device
 * it was pressed on, and it leaves the long-lived programmatic `ApiToken`s
 * alone — those are credentials the user manages separately under
 * /settings/api-tokens, not "sessions" in the device-list sense.
 *
 * It DOES revoke every other native-client `RefreshToken` (each is a device
 * login), and, since v1.38.11, the access token paired with each of them. A
 * native login is two rows: the `RefreshToken`, and the `ApiToken` its
 * `accessTokenHash` points at, which is the only row the Bearer resolver
 * consults. Revoking the refresh token alone left the other phone working
 * until its access token expired — up to a day on the default policy — which
 * is not what "everywhere" promised. The paired access tokens are found
 * through the refresh rows inside the same transaction, so a rotation landing
 * between the read and the write cannot slip a fresh pair past it: the
 * rotation's own consume step refuses a row revoked underneath it and retires
 * what it minted.
 *
 * Returns the number of OTHER web sessions removed and the number of access
 * tokens revoked, so the surface and the audit row can say what happened.
 */
export async function destroyOtherSessions(
  userId: string,
  current: CurrentCredential,
): Promise<{ sessionsRevoked: number; accessTokensRevoked: number }> {
  // Which rows describe the CALLER depends on how the caller authenticated, and
  // the two shapes are not interchangeable. A cookie caller is a `Session` row.
  // A Bearer caller is an `ApiToken` whose device login is the `RefreshToken`
  // carrying the matching `accessTokenHash` — it has no session row at all, so
  // every session goes. Passing an ApiToken id in as a session id (which an
  // earlier revision did) silently excluded nothing and revoked the caller's own
  // refresh token, logging the calling device out at its next rotation.
  const keptSessionId =
    current.kind === "session" ? current.sessionId : undefined;
  const keptRefreshWhere =
    current.kind === "accessToken"
      ? { accessTokenHash: { not: current.accessTokenHash } }
      : {};
  const revokedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const families = await tx.refreshToken.findMany({
      where: { userId, revokedAt: null, ...keptRefreshWhere },
      select: { accessTokenHash: true },
    });
    const pairedAccessHashes = families
      .map((row) => row.accessTokenHash)
      .filter((hash): hash is string => hash !== null);

    const deleted = await tx.session.deleteMany({
      where: {
        userId,
        ...(keptSessionId ? { id: { not: keptSessionId } } : {}),
      },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...keptRefreshWhere },
      data: { revokedAt },
    });
    // Only the access tokens the revoked refresh rows point at. A programmatic
    // `hlk_` token has no refresh row and is never in this list.
    const access =
      pairedAccessHashes.length === 0
        ? { count: 0 }
        : await tx.apiToken.updateMany({
            where: {
              userId,
              tokenHash: { in: pairedAccessHashes },
              revoked: false,
            },
            data: { revoked: true },
          });
    // v1.23 — "sign out everywhere" also drops every trusted device so a
    // remembered browser can no longer skip the second factor (§1.7: a device
    // cookie is killed on sign-out-everywhere).
    await tx.trustedDevice.deleteMany({ where: { userId } });
    // v1.30.34 — and every step-up elevation. A user who signs out everywhere
    // expects nothing to remain that could act on the account; a live elevation
    // is exactly that.
    await tx.stepUpElevation.deleteMany({ where: { userId } });
    return {
      sessionsRevoked: deleted.count,
      accessTokensRevoked: access.count,
    };
  });
}

/**
 * The public handle for a session row, used by the session-management list
 * and its revoke route.
 *
 * The list needs a per-row identifier the client can send back to revoke one
 * device. It used to send the row id — which, for every session created
 * before the secret cookie landed, IS that session's cookie value. The list
 * was therefore handing the client live credentials for all of the account's
 * other devices, and anything that captured one response body (an error
 * reporter, a proxy log, a screenshot of devtools) captured usable logins.
 *
 * The handle is an HMAC of the row id: stable within a deployment so the
 * client can round-trip it, and structurally useless as a cookie because the
 * legacy lookup matches a cuid primary key and a 64-char hex digest is not
 * one. Nothing is stored — the handle is recomputed per request, so this
 * needs no column and no migration.
 */
export function sessionHandle(sessionId: string): string {
  return hashToken(sessionId);
}

/**
 * v1.23 — revoke a single web session, scoped to the owning user so a caller
 * can never delete another user's session row. Returns whether a row was
 * actually removed (false → not found or not owned).
 *
 * Takes the public handle rather than the row id. The account's own rows are
 * a handful, so resolving the handle by walking them costs one indexed read
 * and a few HMACs — cheaper than a column, and it keeps the id server-side.
 */
export async function destroySessionById(
  userId: string,
  handle: string,
): Promise<boolean> {
  const own = await prisma.session.findMany({
    where: { userId },
    select: { id: true },
  });
  const match = own.find((s) => sessionHandle(s.id) === handle);
  if (!match) return false;

  const result = await prisma.session.deleteMany({
    where: { id: match.id, userId },
  });
  return result.count > 0;
}
