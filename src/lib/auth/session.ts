import { prisma } from "@/lib/db";
import { cookies } from "next/headers";
import type { User } from "@/generated/prisma/client";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { getEvent } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

const SESSION_COOKIE = "healthlog_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session.id, {
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
  session: { id: string; expiresAt: Date };
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
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.session
        .deleteMany({ where: { id: sessionId } })
        .catch(() => {});
    }
    cookieStore.delete(SESSION_COOKIE);
    cookieStore.delete(ONBOARDING_COOKIE);
    return null;
  }

  // Sliding expiry: refresh if more than 1 day old
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (
    session.expiresAt.getTime() - Date.now() <
    SESSION_MAX_AGE_MS - oneDayMs
  ) {
    const newExpiry = new Date(Date.now() + SESSION_MAX_AGE_MS);
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: newExpiry },
    });
    cookieStore.set(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS / 1000,
      path: "/",
    });
  }

  return {
    session: { id: session.id, expiresAt: session.expiresAt },
    user: session.user,
  };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
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
  ]);
}

