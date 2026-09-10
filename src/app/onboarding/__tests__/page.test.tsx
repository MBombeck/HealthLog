import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from "@/lib/onboarding/needs";

/**
 * v1.39 (C2) — the setup flow's front door.
 *
 * Three ways in, decided by the step machine: a record that never entered
 * the flow sees the welcome screen, a record mid-way is sent to the step it
 * owes, and a finished record sees the welcome's "again" variant. No session
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

// The shell resolves a locale from cookies; the tree is inspected, not
// rendered, so a plain passthrough is all the test needs.
vi.mock("@/components/onboarding/onboarding-shell", () => ({
  OnboardingShell: ({ children }: { children: ReactElement }) => children,
}));

import OnboardingRootPage from "../page";
import { WelcomeScreen } from "@/components/onboarding/welcome-screen";

beforeEach(() => {
  redirectMock.mockClear();
  loadMock.mockReset();
});

function state(
  statuses: Partial<Record<OnboardingStepId, OnboardingStepStatus>> = {},
  needs: Partial<OnboardingStateDto["needs"]> = {},
  completedAt: string | null = null,
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps().map((step) => ({
      ...step,
      status: statuses[step.id] ?? step.status,
    })),
    needs: { ...emptyOnboardingNeeds(), ...needs },
    completedAt,
    firstResult: null,
  };
}

type ShellElement = ReactElement<{
  children: ReactElement<{ variant: string }>;
}>;

async function run(): Promise<
  { redirect: string } | { element: ShellElement }
> {
  try {
    const element = (await OnboardingRootPage()) as ShellElement;
    return { element };
  } catch (e) {
    const tagged = e as Error & { __redirect__?: string };
    if (tagged.__redirect__) return { redirect: tagged.__redirect__ };
    throw e;
  }
}

function welcomeVariant(element: ShellElement): string {
  const child = element.props.children;
  expect(child.type).toBe(WelcomeScreen);
  return child.props.variant;
}

describe("<OnboardingRootPage>", () => {
  it("redirects to /auth/login when there is no session", async () => {
    loadMock.mockResolvedValueOnce(null);
    expect(await run()).toEqual({ redirect: "/auth/login" });
  });

  it("shows the welcome screen to a record that never entered the flow", async () => {
    loadMock.mockResolvedValueOnce({
      userId: "u1",
      userLocale: "en",
      state: state(),
    });
    const result = await run();
    expect("element" in result && welcomeVariant(result.element)).toBe("fresh");
  });

  it("sends a record mid-way to the step it owes", async () => {
    loadMock.mockResolvedValueOnce({
      userId: "u1",
      userLocale: "en",
      state: state({ who: "done", areas: "done" }, { recordTarget: "me" }),
    });
    expect(await run()).toEqual({ redirect: "/onboarding/medication" });
  });

  it("sends a confirmed flow with an open first result to that screen", async () => {
    loadMock.mockResolvedValueOnce({
      userId: "u1",
      userLocale: "en",
      state: state(
        {
          who: "done",
          areas: "done",
          medication: "done",
          sources: "done",
          visit: "done",
          confirm: "done",
        },
        { recordTarget: "me", areas: ["blood-pressure"] },
        "2026-09-10T08:00:00.000Z",
      ),
    });
    expect(await run()).toEqual({ redirect: "/onboarding/first-result" });
  });

  it("offers the questions again to a finished record", async () => {
    const done = Object.fromEntries(
      defaultOnboardingSteps().map((s) => [s.id, "done" as const]),
    ) as Record<OnboardingStepId, OnboardingStepStatus>;
    loadMock.mockResolvedValueOnce({
      userId: "u1",
      userLocale: "en",
      state: state(done, { recordTarget: "me" }, "2026-09-10T08:00:00.000Z"),
    });
    const result = await run();
    expect("element" in result && welcomeVariant(result.element)).toBe("again");
  });
});
