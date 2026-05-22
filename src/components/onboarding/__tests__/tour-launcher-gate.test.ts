/**
 * v1.4.47 W5 — onboarding chain gate.
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
 * regress the gate. The "manual restart from Settings" path bypasses
 * the gate entirely and lives in `<TourLauncher>`'s
 * `healthlog:tour-restart` window event listener — exercised by the
 * sections SSR smoke test (`settings/__tests__/sections.test.tsx`) +
 * the e2e suite, not by this file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setTourForceLaunch,
  shouldAutoLaunchTour,
  TOUR_AUTOLAUNCH_DELAY_MS,
  tourForceLaunchKey,
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
        onboardingCompletedAt: new Date(NOW - 365 * 24 * ONE_HOUR_MS)
          .toISOString(),
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

describe("setTourForceLaunch() — v1.4.47 W5 manual replay bypass", () => {
  // (c) of the W5 acceptance: the manual "launch tour" trigger still
  // works. The launcher's render-phase gate is exercised by
  // shouldAutoLaunchTour() above; the *bypass* is a sessionStorage
  // marker the Settings buttons drop and the launcher reads-and-
  // clears on its next mount. Vitest runs in the Node environment by
  // default — stub a minimal window so the helper's window-guard +
  // try/catch wrappers can be exercised end-to-end.
  let storage: Map<string, string>;
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("writes the per-user force-launch marker into sessionStorage", () => {
    // The Settings → About + Settings → Account "Replay tour" buttons
    // call this exact helper after the API round-trip succeeds. The
    // launcher reads-and-clears the marker on its next dashboard
    // mount, bypassing the 24 h auto-launch gate so a same-day user
    // who explicitly asked for the tour actually gets it.
    setTourForceLaunch("u_replay_demo");
    expect(storage.get(tourForceLaunchKey("u_replay_demo"))).toBe("1");
  });

  it("scopes the marker per user (two users do not bleed into each other)", () => {
    setTourForceLaunch("u_alice");
    setTourForceLaunch("u_bob");
    expect(storage.get(tourForceLaunchKey("u_alice"))).toBe("1");
    expect(storage.get(tourForceLaunchKey("u_bob"))).toBe("1");
    // The two keys are independent slots — clearing one (which the
    // launcher does on mount) must not affect the other.
    storage.delete(tourForceLaunchKey("u_alice"));
    expect(storage.get(tourForceLaunchKey("u_bob"))).toBe("1");
  });

  it("does not throw when window is undefined (SSR safety)", () => {
    // The launcher itself is "use client" but the helper is exported
    // from the same module and could be imported by a server component
    // in the future. The window-guard inside the helper has to keep
    // SSR happy — verify it stays a silent no-op.
    delete (globalThis as { window?: unknown }).window;
    expect(() => setTourForceLaunch("u_x")).not.toThrow();
  });
});
