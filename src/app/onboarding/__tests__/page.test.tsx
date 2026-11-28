import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from "@/lib/onboarding/needs";

/**
 * 1.50 — the setup flow's front door holds no screen of its own: it sends
 * an admin with an open server setup there first, everybody else to the
 * screen they owe, and a finished account to the dashboard. No session
 * mirrors the proxy's gate.
 */

const redirectMock = vi.fn((href: string) => {
  const err = new Error(`__redirect__:${href}`);
  (err as Error & { __redirect__: string }).__redirect__ = href;
  throw err;
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirectMock(href),
}));

const loadMock = vi.fn();
vi.mock("@/lib/onboarding/load-flow-state", () => ({
  loadOnboardingFlowState: () => loadMock(),
}));

const pendingHandoverMock = vi.fn(async () => false);
vi.mock("@/lib/managed-profiles/handover", () => ({
  hasPendingHandoverDecision: () => pendingHandoverMock(),
}));

import OnboardingRootPage from "../page";

beforeEach(() => {
  redirectMock.mockClear();
  loadMock.mockReset();
  pendingHandoverMock.mockReset();
  pendingHandoverMock.mockResolvedValue(false);
});

function state(
  statuses: Partial<Record<OnboardingStepId, OnboardingStepStatus>> = {},
  needs: Partial<OnboardingStateDto["needs"]> = {},
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps().map((step) => ({
      ...step,
      status: statuses[step.id] ?? step.status,
    })),
    needs: { ...emptyOnboardingNeeds(), ...needs },
    completedAt: null,
    firstResult: null,
    offers: { ai: false },
  };
}

async function landing(): Promise<string> {
  try {
    await OnboardingRootPage();
  } catch (err) {
    const href = (err as { __redirect__?: string }).__redirect__;
    if (href) return href;
    throw err;
  }
  throw new Error("the front door rendered instead of redirecting");
}

function flow(
  onboarding: OnboardingStateDto,
  extra: { serverSetupOpen?: boolean; accountCompleted?: boolean } = {},
) {
  return {
    userId: "u1",
    userLocale: "en",
    state: onboarding,
    plan: null,
    serverSetupOpen: extra.serverSetupOpen ?? false,
    accountCompleted: extra.accountCompleted ?? true,
  };
}

describe("the setup front door", () => {
  it("sends a visitor without a session to sign in", async () => {
    loadMock.mockResolvedValue(null);
    expect(await landing()).toBe("/auth/login");
  });

  it("starts a fresh account on who", async () => {
    loadMock.mockResolvedValue(flow(state()));
    expect(await landing()).toBe("/onboarding/who");
  });

  it("sends an admin with an open server setup there first", async () => {
    loadMock.mockResolvedValue(flow(state(), { serverSetupOpen: true }));
    expect(await landing()).toBe("/onboarding/server");
  });

  it("resumes on the screen still owed", async () => {
    loadMock.mockResolvedValue(
      flow(state({ who: "done", areas: "done" }, { recordTarget: "me" })),
    );
    expect(await landing()).toBe("/onboarding/units");
  });

  it("opens the dashboard once nothing is owed", async () => {
    loadMock.mockResolvedValue(
      flow(
        state(
          {
            who: "done",
            areas: "done",
            units: "done",
            sources: "skipped",
            reminders: "done",
          },
          { recordTarget: "me" },
        ),
      ),
    );
    expect(await landing()).toBe("/");
  });

  it("sends an account nothing is owed by but still unstamped to its last screen, not into a loop with the dashboard", async () => {
    // A flow begun before this one stopped past its sources screen: every
    // step is settled, the account was never stamped, so the first-run
    // redirect would bounce "/" straight back here.
    loadMock.mockResolvedValue(
      flow(
        state(
          {
            who: "done",
            areas: "done",
            units: "done",
            sources: "done",
            reminders: "done",
          },
          { recordTarget: "me" },
        ),
        { accountCompleted: false },
      ),
    );
    const href = await landing();
    expect(href).not.toBe("/");
    expect(href).toMatch(/^\/onboarding\/[a-z-]+$/);
  });

  it("asks a claimed profile's handover decision first", async () => {
    loadMock.mockResolvedValue(flow(state()));
    pendingHandoverMock.mockResolvedValue(true);
    expect(await landing()).toBe("/onboarding/handover");
  });
});
