"use client";

/**
 * v1.4.15 Phase B5 — onboarding-tour launcher.
 *
 * Decides *when* to start the spotlight tour. Mounted on the
 * dashboard; opens the tour exactly once for new users and never
 * again unless they explicitly request a replay from
 * Settings → Account or Settings → About.
 *
 * Gating rules:
 *
 *   1. Wait until the auth payload (`/api/auth/me`) has resolved so
 *      we know `onboardingTourCompleted`.
 *   2. Wait until the dashboard's analytics fetch has resolved.
 *      The tour spotlights the tile strip — if we open before tiles
 *      have rendered, the cutout snaps to a 0×0 invisible target
 *      and the tooltip fallbacks to centre-screen, breaking the
 *      first impression. The launcher subscribes to the same
 *      `["analytics"]` query the dashboard uses; the data resolves
 *      synchronously on subsequent visits via the React Query cache.
 *   3. Don't auto-launch within 1500ms of the user navigating away
 *      from `/onboarding`. The wizard ends with a green-tick toast
 *      that overlaps the same z-index range; if the tour pops up
 *      mid-toast it reads as a double overlay.
 *   4. Honour a localStorage dismiss flag for the *current session*.
 *      Mostly defensive — when the API call to flip the DB flag
 *      races with an in-flight `/api/auth/me` refetch, the cached
 *      response could re-open the tour. The localStorage guard
 *      blocks that for the rest of the session.
 *   5. v1.4.47 W5 — make the tour "the second-visit thing". The
 *      welcome carousel runs immediately after the wizard; piling
 *      the tour on top of that consumes ~90 s of forced onboarding
 *      before the user gets to touch the dashboard. The tour now
 *      auto-launches only after the wizard has been finished at
 *      least 24 h ago. Brand-new users (`onboardingCompletedAt ==
 *      null`) never see the auto-launch — they can still trigger
 *      the tour manually from Settings → About or Settings →
 *      Account.
 *
 * Replay flow: the Settings → Account "Restart" button (and the
 * Settings → About "Replay" button added in v1.4.47 W5) POST
 * `{ completed: false }` to /api/onboarding/tour, then dispatch a
 * `healthlog:tour-restart` window event. This launcher listens for
 * that event and force-opens the tour ignoring the auto-launch gate
 * (24 h delay, session-dismissed flag, post-wizard grace) so the
 * manual replay always works.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { OnboardingTour } from "./tour";

const POST_WIZARD_GRACE_MS = 1500;

/**
 * v1.4.47 W5 — auto-launch only kicks in 24 h after the wizard
 * finished. The first visit is owned by the WelcomeCarousel; the
 * tour becomes "the second-visit thing".
 */
export const TOUR_AUTOLAUNCH_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure decision helper exported for unit tests. Given the auth-shape
 * timing inputs the launcher cares about, return whether the tour
 * should auto-launch right now.
 *
 * Inputs:
 *   - `onboardingTourCompleted` — server flag; true means the user
 *     already finished or dismissed the tour. Hard veto.
 *   - `onboardingCompletedAt` — ISO timestamp of wizard completion
 *     (or `null` for users who never finished the wizard). The
 *     24 h gate counts from here.
 *   - `nowMs` — caller-supplied "current time" so tests can pin a
 *     synthetic clock without monkey-patching `Date.now()`.
 *
 * Returns:
 *   - `false` when any veto applies (tour already done; no wizard
 *     completion yet; wizard finished <24 h ago).
 *   - `true` when the user is eligible and the 24 h delay has passed.
 *
 * The function does NOT consult sessionStorage — that's a separate
 * concern (per-tab dismiss + post-wizard grace) handled by the
 * launcher around it. Pure for testing.
 */
export function shouldAutoLaunchTour(args: {
  onboardingTourCompleted: boolean;
  onboardingCompletedAt: string | null;
  nowMs: number;
}): boolean {
  if (args.onboardingTourCompleted) return false;
  if (args.onboardingCompletedAt == null) return false;
  const completedMs = Date.parse(args.onboardingCompletedAt);
  // Date.parse returns NaN for unparseable inputs. Treat the
  // unparseable case as "no completion yet" so a malformed payload
  // never auto-launches the tour into an unsuspecting brand-new user.
  if (Number.isNaN(completedMs)) return false;
  return args.nowMs - completedMs >= TOUR_AUTOLAUNCH_DELAY_MS;
}

// v1.4.15 H4 — sessionStorage keys are now scoped by user id so an
// admin impersonating a second user does not inherit the first user's
// "tour dismissed for this session" state. The previous global keys
// (`healthlog-tour-session-dismissed`, `healthlog-tour-referrer`)
// kept v1.4.16's multi-tenant prep clean too: anyone using the same
// browser to switch accounts via the typical user-menu sign-out flow
// will not see the tour suppressed under their second identity.
//
// Exported for the unit-test suite so the key-construction stays
// pinned across refactors (and so the keys themselves stay stable —
// changing them would re-fire the tour for everyone).
export function tourSessionDismissedKey(userId: string): string {
  return `healthlog-tour-session-dismissed:${userId}`;
}

export function tourReferrerKey(userId: string): string {
  return `healthlog-tour-referrer:${userId}`;
}

/**
 * v1.4.47 W5 — sessionStorage key used by the Settings → About
 * "Replay the tour" + Settings → Account "Restart onboarding tour"
 * buttons to bypass the 24 h auto-launch gate on the next dashboard
 * mount. Without this, a first-day user who manually clicks the
 * replay button would still hit the 24 h block after navigating to
 * the dashboard (because the launcher mounts fresh and re-evaluates
 * the auto-launch gate). Exported for the unit-test suite + so the
 * key construction stays pinned across refactors.
 */
export function tourForceLaunchKey(userId: string): string {
  return `healthlog-tour-force-launch:${userId}`;
}

/**
 * Write the force-launch marker. Called by both Settings → Account
 * and Settings → About when the user explicitly requests the tour.
 * Exported so the Settings buttons can call it without re-implementing
 * the sessionStorage dance (and so the test suite can stub it).
 */
export function setTourForceLaunch(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(tourForceLaunchKey(userId), "1");
  } catch {
    /* ignore — sandboxed iframes etc. */
  }
}

function readAndClearForceLaunch(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = tourForceLaunchKey(userId);
    const value = window.sessionStorage.getItem(key);
    if (value !== "1") return false;
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the user just navigated here from `/onboarding`. Read
 * once at mount via a `useState` lazy initialiser (which runs in a
 * pure-by-contract slot, not the render body) — see the
 * `useState(() => …)` call in `<TourLauncher>`. The wizard's
 * `persistAndExit()` writes `"1"` into sessionStorage immediately
 * before navigating, and the launcher consumes-and-clears it on
 * first mount so a back-button to the wizard and forward again
 * doesn't double-defer.
 *
 * `userId` is required — until the auth payload arrives the launcher
 * does not consult sessionStorage at all (the gating effect waits
 * for `inputsReady` first).
 */
function readAndClearJustFromWizard(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = tourReferrerKey(userId);
    const value = window.sessionStorage.getItem(key);
    if (value !== "1") return false;
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readSessionDismissed(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.sessionStorage.getItem(tourSessionDismissedKey(userId)) === "1"
    );
  } catch {
    return false;
  }
}

function writeSessionDismissed(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(tourSessionDismissedKey(userId), "1");
  } catch {
    /* ignore — sandboxed iframes etc. */
  }
}

function clearSessionDismissed(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(tourSessionDismissedKey(userId));
  } catch {
    /* ignore */
  }
}

interface TourLauncherProps {
  /**
   * The dashboard passes a sentinel — true once analytics has
   * resolved at least once. Without this gate the spotlight would
   * try to anchor to tiles that haven't rendered yet, and Recharts
   * widgets defer mounting too. This is a simple, race-free signal
   * the dashboard already computes.
   */
  ready: boolean;
}

export function TourLauncher({ ready }: TourLauncherProps) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();

  // `null` = decision not yet made; `true` = render the tour;
  // `false` = don't render. We only flip null→true ONCE per mount;
  // closing the tour transitions true→false and we never re-open
  // unless the restart event fires.
  const [showTour, setShowTour] = useState<boolean | null>(null);
  // Track post-wizard deferral as a boolean so the render path stays
  // pure (no Date.now() comparisons). The effect below reads / clears it.
  const [deferredFromWizard, setDeferredFromWizard] = useState(false);
  // Tracks the (userId, flag) tuple the launch-decision evaluator
  // has already run for. The render-phase decision below uses this
  // as the React-recommended "previous input id" guard so the
  // setState block runs at most once per (user, flag) transition.
  const [decidedFor, setDecidedFor] = useState<{
    userId: string;
    flag: boolean;
  } | null>(null);
  // v1.4.47 W5 — clock reading for the 24 h auto-launch gate. The
  // useState lazy-initialiser runs once at mount; subsequent re-renders
  // reuse the same value. This keeps the render path pure (React's
  // purity linter rejects a bare `Date.now()` reference in render) and
  // matches the established pattern in `personal-record-badge.tsx`:
  // capture the clock at a stable boundary, then derive freshness from
  // it. The launcher only consults this value once per (user, flag)
  // tuple via the `decidedFor` guard, so a mount that takes ten
  // minutes to reach the decision still uses a representative timestamp
  // (and a user who crosses the 24 h boundary mid-session will see the
  // tour on their next page-load — acceptable for a one-shot welcome).
  const [mountedAtMs] = useState(() => Date.now());

  const inputsReady = !isLoading && isAuthenticated && !!user && ready;
  // The set-state-in-render pattern (mirrors `account-section.tsx`'s
  // `seededUserId` — React-recommended for "compute initial state
  // from props once they arrive"). Pure: branches on prop values
  // and constant-result helpers only.
  if (
    showTour === null &&
    inputsReady &&
    user &&
    (decidedFor === null ||
      decidedFor.userId !== user.id ||
      decidedFor.flag !== user.onboardingTourCompleted)
  ) {
    setDecidedFor({ userId: user.id, flag: user.onboardingTourCompleted });
    // sessionStorage reads happen via per-user keyed helpers, so a
    // browser shared by two HealthLog users (admin impersonation,
    // family laptop, etc.) keeps each user's tour state independent.
    //
    // v1.4.47 W5 — the 24 h auto-launch gate. The mount-time clock is
    // captured into `mountedAtMs` via a useState lazy initialiser so
    // the render-phase decision stays pure (no Date.now() in the
    // render body). The `decidedFor` tuple above further guarantees
    // this branch runs at most once per (user, flag) transition.
    //
    // Force-launch bypass: when the user explicitly requests the tour
    // from Settings → About / Settings → Account, those buttons set a
    // per-user sessionStorage marker via `setTourForceLaunch()`. The
    // launcher reads-and-clears the marker here so the tour launches
    // on the very next dashboard mount — independent of the 24 h gate,
    // the session-dismissed flag, and the post-wizard grace. The
    // marker survives navigation but not a page reload, which matches
    // user expectation ("I clicked replay, now show me the tour").
    if (readAndClearForceLaunch(user.id)) {
      setShowTour(true);
    } else if (!shouldAutoLaunchTour({
      onboardingTourCompleted: user.onboardingTourCompleted,
      onboardingCompletedAt: user.onboardingCompletedAt,
      nowMs: mountedAtMs,
    })) {
      setShowTour(false);
    } else if (readSessionDismissed(user.id)) {
      setShowTour(false);
    } else if (readAndClearJustFromWizard(user.id)) {
      // Mark "deferred"; the effect below schedules a fixed-duration
      // timer + flips `showTour` from inside the timeout callback
      // (which the set-state-in-effect rule allows).
      setShowTour(false);
      setDeferredFromWizard(true);
    } else {
      setShowTour(true);
    }
  }

  // Wait out the post-wizard grace window. Side-effect-only (timer
  // management); the inner setState lives inside a callback so the
  // set-state-in-effect rule is satisfied.
  useEffect(() => {
    if (!deferredFromWizard) return;
    const userId = user?.id;
    if (!userId) return;
    const id = window.setTimeout(() => {
      if (!readSessionDismissed(userId)) {
        setShowTour(true);
      }
      setDeferredFromWizard(false);
    }, POST_WIZARD_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [deferredFromWizard, user?.id]);

  // Listen for explicit restart events from Settings → Account.
  // setState inside a window-event listener is fine under the
  // set-state-in-effect rule.
  const userIdForRestart = user?.id;
  useEffect(() => {
    function onRestart() {
      if (userIdForRestart) clearSessionDismissed(userIdForRestart);
      setShowTour(true);
    }
    window.addEventListener("healthlog:tour-restart", onRestart);
    return () => {
      window.removeEventListener("healthlog:tour-restart", onRestart);
    };
  }, [userIdForRestart]);

  if (showTour !== true) return null;

  return (
    <OnboardingTour
      onClose={async (outcome) => {
        // Optimistic: hide the overlay immediately, persist in the
        // background. The flag is idempotent so re-fires are safe;
        // a network error here is non-fatal because the
        // session-dismiss guard prevents the tour from re-launching
        // for the rest of the session, and the next refetch of
        // `/api/auth/me` (which the user gets on any nav) will
        // surface any divergence.
        setShowTour(false);
        if (user?.id) writeSessionDismissed(user.id);
        try {
          await fetch("/api/onboarding/tour", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ completed: true, outcome }),
          });
          await queryClient.invalidateQueries({ queryKey: ["auth"] });
        } catch {
          // Swallow — the session-dismiss flag prevents a re-open.
          // Next visit will retry via the same code path.
        }
      }}
    />
  );
}
