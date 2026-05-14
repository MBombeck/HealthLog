import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.4.25 W14b-Content — onboarding root redirect tests.
 *
 * The v1.4.20 single-file wizard was deleted in this commit; the root
 * `/onboarding` page is now a server-side redirect into the new
 * `/onboarding/[step]` flow. These tests cover the three redirect
 * branches: missing session, mid-flow user, completed user.
 */

const redirectMock = vi.fn((href: string) => {
  // next/navigation `redirect()` throws a special sentinel inside the
  // server-component renderer to short-circuit rendering. Mimic that
  // by throwing an error tagged with the href so each test can
  // unambiguously assert the redirect target.
  const err = new Error(`__redirect__:${href}`);
  (err as Error & { __redirect__: string }).__redirect__ = href;
  throw err;
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirectMock(href),
}));

const getSessionMock = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

import OnboardingRootPage from "../page";

beforeEach(() => {
  redirectMock.mockClear();
  getSessionMock.mockReset();
});

function makeSession(opts: {
  onboardingStep?: number | null;
  onboardingCompletedAt?: Date | null;
}) {
  return {
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 86400000) },
    user: {
      id: "user-1",
      onboardingStep: opts.onboardingStep ?? null,
      onboardingCompletedAt: opts.onboardingCompletedAt ?? null,
    },
  };
}

async function runRedirect(): Promise<string> {
  try {
    await OnboardingRootPage();
  } catch (e) {
    const tagged = e as Error & { __redirect__?: string };
    if (tagged.__redirect__) return tagged.__redirect__;
    throw e;
  }
  throw new Error("expected redirect, none thrown");
}

describe("<OnboardingRootPage> root redirect", () => {
  it("redirects to /auth/login when no session", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const href = await runRedirect();
    expect(href).toBe("/auth/login");
  });

  it("redirects fresh user (onboardingStep null) to /onboarding/0", async () => {
    getSessionMock.mockResolvedValueOnce(makeSession({}));
    const href = await runRedirect();
    expect(href).toBe("/onboarding/0");
  });

  it("redirects mid-flow user to /onboarding/<current>", async () => {
    getSessionMock.mockResolvedValueOnce(makeSession({ onboardingStep: 2 }));
    const href = await runRedirect();
    expect(href).toBe("/onboarding/2");
  });

  it("clamps an out-of-range onboardingStep into the 0..4 window", async () => {
    getSessionMock.mockResolvedValueOnce(makeSession({ onboardingStep: 99 }));
    const href = await runRedirect();
    expect(href).toBe("/onboarding/4");
  });

  it("redirects a completed user to /onboarding/<current>", async () => {
    getSessionMock.mockResolvedValueOnce(
      makeSession({
        onboardingStep: 4,
        onboardingCompletedAt: new Date("2026-05-01"),
      }),
    );
    const href = await runRedirect();
    // The step page handles the welcome-back banner at step 0 and the
    // done-screen at step 4 — the root page just bounces into the
    // current step regardless of completion state.
    expect(href).toBe("/onboarding/4");
  });
});
