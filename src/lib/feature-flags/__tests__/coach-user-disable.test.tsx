import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
import {
  DEFAULT_ASSISTANT_FLAGS,
  type AssistantFlagSet,
} from "@/hooks/use-feature-flags";
import type { AuthUser } from "@/hooks/use-auth";

import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";
import { SuggestedPrompts } from "@/components/insights/suggested-prompts";
import { HeroStrip } from "@/components/insights/hero-strip";

/**
 * v1.4.47 W3 — per-user "Hide Coach" opt-out invariant.
 *
 * The Coach disable cascade (`coach-cascade.test.tsx`) pins the
 * operator-level `flags.coach` gate. This sibling fixture pins the
 * per-user `disableCoach` gate that sits BELOW the operator flag —
 * either gate being off must hide every Coach affordance with no
 * grey-out, no error, no inert button, no DOM trace.
 *
 * Mocking strategy mirrors the cascade fixture: spy `useFeatureFlags`
 * to drive the operator matrix synchronously during SSR, spy
 * `useAuth` to drive the per-user `disableCoach` field. Both spies
 * are reset between iterations so a regression in either gate trips
 * the invariant in isolation.
 */

const featureFlagsSpy = vi.fn<() => AssistantFlagSet>(
  () => DEFAULT_ASSISTANT_FLAGS,
);
vi.mock("@/hooks/use-feature-flags", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/use-feature-flags")
  >("@/hooks/use-feature-flags");
  return {
    ...actual,
    useFeatureFlags: () => featureFlagsSpy(),
  };
});

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: null, isAuthenticated: false }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return {
    ...actual,
    useAuth: () => authSpy(),
  };
});

// The Coach gates read user.disableCoach through `useDisableCoach`,
// which itself calls `useAuth()`. Mocking `useDisableCoach` directly
// would bypass the useAuth call site and make the spy assertion
// below trivially fail; instead we let the real `useDisableCoach`
// pass through and capture the underlying `useAuth` calls.

function buildUser(disableCoach: boolean): AuthUser {
  // Minimal `AuthUser` shape — the Coach gates only read
  // `disableCoach`, but TypeScript requires the full interface to
  // satisfy the mock's return type. Everything else is filler.
  return {
    id: "test-user-id",
    username: "test",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    gravatarUrl: null,
    glucoseUnit: null,
    disableCoach,
  };
}

function buildClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
}

function renderWithDisableCoach(
  node: React.ReactNode,
  disableCoach: boolean,
  coach: boolean = true,
): string {
  featureFlagsSpy.mockImplementation(() => ({
    ...DEFAULT_ASSISTANT_FLAGS,
    coach,
  }));
  authSpy.mockImplementation(() => ({
    user: buildUser(disableCoach),
    isAuthenticated: true,
  }));
  const client = buildClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

interface DisableCoachSurface {
  name: string;
  mount: () => React.ReactNode;
  /**
   * Substring that proves the surface painted. Empty string means
   * "the surface SSR-renders to nothing even when on" (lazy-loaded
   * subtrees) and the negative assertion is the dispositive check.
   */
  proofWhenVisible: string;
}

const DISABLE_COACH_SURFACES: DisableCoachSurface[] = [
  {
    name: "LayoutCoachFab",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>
    ),
    proofWhenVisible: 'data-slot="coach-launch-fab"',
  },
  {
    name: "LayoutCoachMount",
    mount: () => (
      <CoachLaunchProvider>
        <LayoutCoachMount />
      </CoachLaunchProvider>
    ),
    // Lazy-loaded — SSR shape is empty even when visible. Negative
    // assertion still pins the gate via the `coach-*` slot grep.
    proofWhenVisible: "",
  },
  {
    name: "CoachLaunchButton inline pill",
    mount: () => (
      <CoachLaunchProvider>
        <CoachLaunchButton />
      </CoachLaunchProvider>
    ),
    proofWhenVisible: 'data-slot="coach-launch-inline"',
  },
  {
    name: "SuggestedPrompts chip strip",
    mount: () => <SuggestedPrompts onPick={() => undefined} />,
    proofWhenVisible: 'data-slot="insights-suggested-prompts"',
  },
  {
    name: "HeroStrip action-row Ask the coach",
    mount: () => (
      <HeroStrip
        briefing={null}
        now={new Date(2026, 4, 10, 9, 0, 0)}
        onAskCoach={() => undefined}
      />
    ),
    proofWhenVisible: 'data-slot="insights-hero-strip-action-coach"',
  },
];

describe("Coach per-user disableCoach invariant", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    featureFlagsSpy.mockClear();
    authSpy.mockClear();
    featureFlagsSpy.mockImplementation(() => DEFAULT_ASSISTANT_FLAGS);
    authSpy.mockImplementation(() => ({
      user: buildUser(false),
      isAuthenticated: true,
    }));
  });

  for (const surface of DISABLE_COACH_SURFACES) {
    it(`${surface.name} — paints when user.disableCoach is false`, () => {
      if (!surface.proofWhenVisible) return;
      const html = renderWithDisableCoach(surface.mount(), false);
      expect(html).toContain(surface.proofWhenVisible);
    });

    it(`${surface.name} — vanishes when user.disableCoach is true`, () => {
      const html = renderWithDisableCoach(surface.mount(), true);
      if (surface.proofWhenVisible) {
        expect(html).not.toContain(surface.proofWhenVisible);
      }
      // No Coach-marked mount point may paint when the per-user gate
      // is on. Pin the negative shape against the shared prefix so a
      // future surface that grows a new `coach-*` slot without the
      // disableCoach gate fails this test by default.
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
      expect(html).not.toContain('data-slot="insights-suggested-prompts"');
      expect(html).not.toContain(
        'data-slot="insights-hero-strip-action-coach"',
      );
      expect(html).not.toContain('data-slot="insights-hero-strip-prompts"');
    });

    it(`${surface.name} — also vanishes when flags.coach is false (regression pin)`, () => {
      // The legacy operator-level gate must keep working in the
      // presence of the new per-user gate. This guards against a
      // regression where a contributor "simplifies" the two checks
      // into one and accidentally drops the operator branch.
      const html = renderWithDisableCoach(surface.mount(), false, false);
      if (surface.proofWhenVisible) {
        expect(html).not.toContain(surface.proofWhenVisible);
      }
      expect(html).not.toMatch(/data-slot="coach-[a-z]/);
    });
  }

  it("`useAuth` gate is consulted on every Coach surface", () => {
    // A `disableCoach: true` render must trip the `useAuth` spy at
    // least once. Otherwise a future regression that drops the
    // `useAuth()` call site silently leaks the affordance.
    for (const surface of DISABLE_COACH_SURFACES) {
      authSpy.mockClear();
      renderWithDisableCoach(surface.mount(), true);
      expect(
        authSpy,
        `${surface.name} did not consult useAuth() during render`,
      ).toHaveBeenCalled();
    }
  });
});
