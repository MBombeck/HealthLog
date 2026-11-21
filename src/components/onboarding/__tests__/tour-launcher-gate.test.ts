/**
 * v1.4.47 — onboarding chain gate.
 *
 * `<WelcomeCarousel>` (gated on `users.onboardingCompletedAt`) and
 * `<TourLauncher>` (gated on `users.onboardingTourCompleted`) used to
 * both auto-launch when null. A brand-new user finished the carousel
 * and was immediately greeted by the spotlight tour — ~90 seconds of
 * forced onboarding before they could touch the dashboard.
 *
 * The fix turns the tour into "the second-visit thing": auto-launch
 * is suppressed until `onboardingCompletedAt + 24 h`. This file pins
 * the pure decision helper so a future refactor doesn't silently
 * regress the gate. v1.18.6.1 — the tour is first-time-auto-start
 * only; the former "manual restart from Settings" bypass was removed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  shouldAutoLaunchTour,
  TOUR_AUTOLAUNCH_DELAY_MS,
} from "../tour-launcher";

const NOW = Date.parse("2026-05-21T12:00:00Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

describe("shouldAutoLaunchTour() — v1.4.47 W5 chain-gate", () => {
  it("returns false when the user already completed (or dismissed) the tour", () => {
    // Hard veto independent of timing — a user who already saw the
    // tour should never see it again from the auto-launch path even
    // if their wizard completion is years in the past.
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: true,
        onboardingCompletedAt: new Date(
          NOW - 365 * 24 * ONE_HOUR_MS,
        ).toISOString(),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("returns false for brand-new users who have not finished the wizard yet", () => {
    // (a) of the W5 acceptance: the tour does NOT mount in the same
    // session as carousel completion. Concretely: the wizard hasn't
    // POSTed step 4 yet (`onboardingCompletedAt` still null), so the
    // 24 h clock has not started — auto-launch is suppressed.
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: false,
        onboardingCompletedAt: null,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when the wizard finished less than 24 h ago", () => {
    // Same-session and same-day re-visits both fall here. The
    // welcome carousel owns the post-wizard first impression; the
    // tour stays out of the way.
    const oneHourAfterWizard = new Date(NOW - ONE_HOUR_MS).toISOString();
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: false,
        onboardingCompletedAt: oneHourAfterWizard,
        nowMs: NOW,
      }),
    ).toBe(false);

    // Boundary just inside the 24 h window — still suppressed.
    const justUnder24h = new Date(
      NOW - TOUR_AUTOLAUNCH_DELAY_MS + 1,
    ).toISOString();
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: false,
        onboardingCompletedAt: justUnder24h,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("returns true on a synthetic mount ≥ 24 h after wizard completion", () => {
    // (b) of the W5 acceptance: the tour DOES mount on a synthetic
    // ≥ 24 h-later mount. Two cases bracket the boundary — exactly
    // at the 24 h mark and a day later.
    const exactly24hAfter = new Date(
      NOW - TOUR_AUTOLAUNCH_DELAY_MS,
    ).toISOString();
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: false,
        onboardingCompletedAt: exactly24hAfter,
        nowMs: NOW,
      }),
    ).toBe(true);

    const twoDaysAfter = new Date(
      NOW - 2 * TOUR_AUTOLAUNCH_DELAY_MS,
    ).toISOString();
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: false,
        onboardingCompletedAt: twoDaysAfter,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("returns false when the timestamp string cannot be parsed", () => {
    // Defensive: a malformed payload (e.g. accidental locale-string
    // serialisation upstream) should never auto-launch the tour and
    // surprise a brand-new user. Treat unparseable as "no completion".
    expect(
      shouldAutoLaunchTour({
        onboardingTourCompleted: false,
        onboardingCompletedAt: "not-a-real-iso-timestamp",
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("uses a 24 h delay constant (locked exact value)", () => {
    // Pin the constant so a future refactor that tries to drop the
    // delay (e.g. "let's just enable it after one hour") has to
    // confront this test. The number lives in the source and is
    // re-exported for tests + for any future runtime introspection.
    expect(TOUR_AUTOLAUNCH_DELAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("the launcher hands the tour the capability-folded module map", () => {
  // The raw `user.modules` says the Coach module is on for a fresh self-host
  // with no provider, while `/coach` redirects to `/insights` because the
  // Coach capability is unavailable: the tour pushed `/coach`, was sent back,
  // and pushed again. The launcher must read `useNavModules()`, which folds
  // the capability into `coach`, exactly as the nav does.
  const source = readFileSync(
    join(process.cwd(), "src/components/onboarding/tour-launcher.tsx"),
    "utf8",
  );

  it("reads useNavModules()", () => {
    expect(source).toMatch(/\buseNavModules\(\)/);
  });

  it("does not pass the raw account module map to the tour", () => {
    expect(source).not.toMatch(/modules\s*=\s*user\?\.modules/);
  });
});
