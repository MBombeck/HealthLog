/**
 * The onboarding hint cookie, issued with every session (`createSession`) and
 * cleared with it. Its own module so the session module stays inside its size
 * bound; `@/lib/auth/session` re-exports the setter.
 */
import { cookies } from "next/headers";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { sessionIdleTimeoutMs } from "@/lib/auth/session-lifetime";

/**
 * Flag cookie mirroring the user's `onboardingCompletedAt`
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
export const ONBOARDING_COOKIE = "hl_onboarding";

export async function setOnboardingPendingCookie(
  pending: boolean,
): Promise<void> {
  const cookieStore = await cookies();
  if (pending) {
    cookieStore.set(ONBOARDING_COOKIE, "pending", {
      httpOnly: false,
      secure: shouldEmitSecureCookie(),
      // Strict (not Lax) because
      // no cross-site redirect flow ever depends on this cookie. The
      // sibling session cookie stays Lax because the
      // Withings OAuth callback arrives via top-level cross-site
      // redirect; the onboarding hint has no equivalent flow.
      sameSite: "strict",
      maxAge: sessionIdleTimeoutMs() / 1000,
      path: "/",
    });
  } else {
    cookieStore.delete(ONBOARDING_COOKIE);
  }
}
