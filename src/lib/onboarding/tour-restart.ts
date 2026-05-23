/**
 * v1.4.48 M6b — shared "restart onboarding tour" worker.
 *
 * `<AccountSection>` and `<AboutSection>` both expose a button that
 * resets `users.onboarding_tour_completed = false` and arranges for the
 * dashboard's `<TourLauncher>` to re-open the spotlight on the user's
 * next navigation. Until v1.4.48 the two handlers were 90 % identical
 * copy-paste — a known drift hazard. This helper owns the surface so
 * both call sites narrow to a single mutate-then-route step:
 *
 *   const result = await restartOnboardingTour(user?.id);
 *   if (result.ok) toast(t("onboarding.tour.restartConfirmation"));
 *   else           toast(t(result.messageKey));
 *
 * Side-effects this helper owns:
 *
 *   - PUT `/api/onboarding/tour` with `{ completed: false }` (the same
 *     server flip both Account and About already drove).
 *   - On success — write the per-user `setTourForceLaunch(userId)`
 *     marker into sessionStorage so the next dashboard mount opens
 *     the tour even when the 24 h auto-launch gate would suppress it.
 *   - Fire a `healthlog:tour-restart` window event so a dashboard
 *     mounted in another tab / background reopens the spotlight
 *     immediately. The dispatch is best-effort; SSR or sandboxed
 *     iframes that can't construct CustomEvent are tolerated.
 *
 * Translation + toast rendering are deliberately NOT owned here — the
 * helper returns a discriminated `{ ok }` result and lets the React
 * component pick the right `useTranslations()` instance. Keeps the
 * helper pure of i18n state and easy to unit-test under the default
 * vitest "node" environment.
 */

import { setTourForceLaunch } from "@/components/onboarding/tour-launcher";

export type RestartTourResult =
  | { ok: true }
  | { ok: false; messageKey: string };

export interface RestartTourOptions {
  /**
   * Fetch implementation injected for tests. Defaults to the global
   * `fetch` so production code paths read exactly as before.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Persist the tour-replay request server-side and arm the launcher
 * for the user's next dashboard navigation.
 *
 * `userId` may be undefined when the auth payload hasn't landed yet —
 * the server flip still fires, and the force-launch marker is simply
 * skipped (the launcher's secondary "tour-completed = false" path
 * still picks the change up on the next `/api/auth/me` read).
 */
export async function restartOnboardingTour(
  userId: string | undefined,
  opts: RestartTourOptions = {},
): Promise<RestartTourResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl("/api/onboarding/tour", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: false }),
    });
    if (!res.ok) {
      return { ok: false, messageKey: "settings.savingError" };
    }
    if (userId) setTourForceLaunch(userId);
    try {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("healthlog:tour-restart"));
      }
    } catch {
      /* ignore — only matters if a dashboard is already mounted */
    }
    return { ok: true };
  } catch {
    return { ok: false, messageKey: "common.networkError" };
  }
}
