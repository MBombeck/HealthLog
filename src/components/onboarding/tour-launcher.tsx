"use client";

/**
 * v1.4.15 — onboarding-tour launcher.
 *
 * Decides *when* to start the spotlight tour. Mounted on the
 * dashboard; opens the tour exactly once for new users and never
 * again. v1.18.6.1 — the tour exists ONLY as this first-time
 * auto-start: every in-app re-entry trigger (the per-module "show
 * this tour" buttons and the Settings replay card) was removed.
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
 *      null`) never see the auto-launch on the same session they
 *      finished onboarding.
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useNavModules } from "@/hooks/use-nav-modules";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { OnboardingTour } from "./tour";

const POST_WIZARD_GRACE_MS = 1500;

/**
 * v1.4.47 — auto-launch only kicks in 24 h after the wizard
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
  /**
   * v1.18.6 — true when the user has just returned from the wizard's
   * DoneScreen this session (the `tourReferrerKey` marker). A fresh
   * user finishing anamnesis should get the module tour IMMEDIATELY —
   * the post-wizard grace below still sequences it after the toast.
   * The old 24 h delay over-corrected and removed first-run capability
   * education entirely; it now only applies to a user who SKIPPED the
   * wizard (no referrer marker, completion ≥ 24 h ago).
   */
  justFromWizard?: boolean;
}): boolean {
  if (args.onboardingTourCompleted) return false;
  if (args.onboardingCompletedAt == null) return false;
  const completedMs = Date.parse(args.onboardingCompletedAt);
  // Date.parse returns NaN for unparseable inputs. Treat the
  // unparseable case as "no completion yet" so a malformed payload
  // never auto-launches the tour into an unsuspecting brand-new user.
  if (Number.isNaN(completedMs)) return false;
  // Fresh-from-anamnesis: launch now (sequenced after the post-wizard
  // grace by the launcher), no 24 h wait.
  if (args.justFromWizard) return true;
  return args.nowMs - completedMs >= TOUR_AUTOLAUNCH_DELAY_MS;
}

/**
 * v1.18.0 — whether the achievements tour stop should be included.
 * Reads the per-user module map with the standard client default-on
 * convention (`modules?.achievements !== false`): only an explicit
 * `false` drops the stop. Pure + exported so the rule is unit-pinned
 * without rendering the launcher.
 */
export function tourIncludesAchievements(
  modules: Partial<Record<string, boolean>> | undefined,
): boolean {
  return modules?.achievements !== false;
}

// v1.4.15 — sessionStorage keys are now scoped by user id so an
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
/**
 * v1.18.6 — write the wizard-return marker. Called from the wizard's
 * `DoneScreen` on mount so the launcher knows the user JUST finished
 * anamnesis and should get the module tour immediately (sequenced after
 * the post-wizard grace) rather than after the 24 h fallback delay.
 * Per-user keyed so a shared browser keeps each identity's state apart.
 */
export function setTourReferrer(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(tourReferrerKey(userId), "1");
  } catch {
    /* ignore — sandboxed iframes etc. */
  }
}

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

interface TourLauncherProps {
  /**
   * v1.18.6 — optional readiness sentinel. The dashboard used to pass
   * `true` once analytics resolved so the spotlight didn't anchor to a
   * 0×0 tile. The overlay now polls for its anchor (bounded retry), so
   * the gate is no longer load-bearing; it defaults to `true` for the
   * shell-level mount. The launcher still only auto-opens on the
   * dashboard route, where the first stop's anchor lives.
   */
  ready?: boolean;
}

export function TourLauncher({ ready = true }: TourLauncherProps) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const navModules = useNavModules();
  const queryClient = useQueryClient();
  const pathname = usePathname();

  // `null` = decision not yet made; `true` = render the tour;
  // `false` = don't render. We only flip null→true ONCE per mount;
  // closing the tour transitions true→false and we never re-open
  // unless the restart event fires.
  const [showTour, setShowTour] = useState<boolean | null>(null);
  // v1.18.6 — when the tour opens for a single-module re-entry
  // ("Diese Tour zeigen" on a module page) this carries the stop id so
  // the overlay renders just that card. `null` = the full tour.
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
  // v1.4.47 — clock reading for the 24 h auto-launch gate. The
  // useState lazy-initialiser runs once at mount; subsequent re-renders
  // reuse the same value. This keeps the render path pure (React's
  // purity linter rejects a bare `Date.now()` reference in render):
  // capture the clock at a stable boundary, then derive freshness from
  // it. The launcher only consults this value once per (user, flag)
  // tuple via the `decidedFor` guard, so a mount that takes ten
  // minutes to reach the decision still uses a representative timestamp
  // (and a user who crosses the 24 h boundary mid-session will see the
  // tour on their next page-load — acceptable for a one-shot welcome).
  const [mountedAtMs] = useState(() => Date.now());

  // v1.18.6 — the launcher now mounts at the app-shell level so the
  // overlay survives the cross-page `router.push`es the tour makes. It
  // must only AUTO-open on the dashboard, where the first stop's anchor
  // lives. A manual re-entry / restart can fire from any route (handled
  // by the event listeners below, which don't consult this gate).
  const onDashboard = pathname === "/";
  const inputsReady =
    !isLoading && isAuthenticated && !!user && ready && onDashboard;
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
    // v1.18.6 — consume the wizard-return marker once so the
    // fresh-from-anamnesis path launches immediately (sequenced after
    // the post-wizard grace) instead of waiting 24 h.
    const justFromWizard = readAndClearJustFromWizard(user.id);
    // sessionStorage reads happen via per-user keyed helpers, so a
    // browser shared by two HealthLog users (admin impersonation,
    // family laptop, etc.) keeps each user's tour state independent.
    //
    // v1.4.47 — the 24 h auto-launch gate. The mount-time clock is
    // captured into `mountedAtMs` via a useState lazy initialiser so
    // the render-phase decision stays pure (no Date.now() in the
    // render body). The `decidedFor` tuple above further guarantees
    // this branch runs at most once per (user, flag) transition.
    //
    // v1.18.6.1 — the tour is now first-time-auto-start only; there is
    // no in-app replay trigger and therefore no force-launch bypass.
    if (
      !shouldAutoLaunchTour({
        onboardingTourCompleted: user.onboardingTourCompleted,
        onboardingCompletedAt: user.onboardingCompletedAt,
        nowMs: mountedAtMs,
        justFromWizard,
      })
    ) {
      setShowTour(false);
    } else if (readSessionDismissed(user.id)) {
      setShowTour(false);
    } else if (justFromWizard) {
      // Fresh from anamnesis — defer past the post-wizard grace so the
      // green-tick toast doesn't double-overlay, then open. The effect
      // below schedules the timer and flips `showTour` in its callback
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

  // v1.18.6.1 — the guided tour exists ONLY as the first-time auto-start
  // after onboarding. The per-module "show this tour" re-entry and the
  // Settings replay card were removed, so there is no longer any in-app
  // trigger that re-opens the overlay.

  // v1.18.6 — stable progress callback so the overlay's checkpoint effect
  // fires on a real step transition, not on every launcher re-render.
  const handleProgress = useCallback(
    (progress: {
      lastStopId: string | null;
      completedStopIds: string[];
      status: "in_progress" | "completed" | "skipped";
    }) => {
      void apiPost("/api/onboarding/tour", {
        progress: { ...progress, updatedAt: new Date().toISOString() },
      }).catch(() => {});
    },
    [],
  );

  if (showTour !== true) return null;

  // The module map the nav reads gates which stops appear (default-on) and
  // keeps the "Schritt n/total" counter honest. It folds the Coach
  // capability in: with no provider or no consent the Coach module is on
  // but `/coach` redirects, so the raw `user.modules` would keep a stop the
  // tour can never stand on.
  const modules = navModules;
  // v1.18.6 — resume the full tour from the persisted checkpoint.
  const resumeFromStopId = user?.onboardingTourProgress?.lastStopId ?? null;

  return (
    <OnboardingTour
      modules={modules}
      resumeFromStopId={resumeFromStopId}
      // Fire-and-forget checkpoint so a mid-tour reload resumes at the
      // right module. A failed write is non-fatal — the resume point is
      // a convenience, not a correctness invariant.
      onProgress={handleProgress}
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
          await apiPost("/api/onboarding/tour", { completed: true, outcome });
          await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
        } catch {
          // Swallow — the session-dismiss flag prevents a re-open.
          // Next visit will retry via the same code path.
        }
      }}
    />
  );
}
