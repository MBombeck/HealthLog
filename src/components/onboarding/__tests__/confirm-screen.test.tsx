/**
 * v1.39 (Wave C) — what the confirm screen is allowed to claim.
 *
 * C4 (research I6): the screen listed what the answers switch ON and said
 * everything else "stays one click away under Settings, Modules" — true of
 * reachability, false of the navigation entry. A module the answers do not
 * ask for leaves the navigation, and nothing said so.
 *
 * Rendered server-side, this repo's component-test convention.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";
import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";

let currentUser: AuthUser | null = null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: currentUser }),
  useAccountOnceMounted: () => currentUser,
}));

const { ConfirmScreen } = await import("../confirm-screen");

function state(
  overrides: Partial<OnboardingStateDto> = {},
  needs: Partial<OnboardingStateDto["needs"]> = {},
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps(),
    needs: { ...emptyOnboardingNeeds(), recordTarget: "me", ...needs },
    completedAt: null,
    firstResult: null,
    ...overrides,
  };
}

function render(
  flow: OnboardingStateDto,
  modules: Partial<Record<string, boolean>> = {},
): string {
  currentUser = {
    id: "u1",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    unitPreference: "metric",
    modules,
  } as unknown as AuthUser;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <ConfirmScreen state={flow} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<ConfirmScreen> — modules leaving the navigation (C4)", () => {
  it("names them when the answers do not ask for what the record shows", () => {
    const html = render(state({}, { areas: ["sleep"], medication: "no" }), {
      medications: true,
    });
    expect(html).toContain('data-slot="onboarding-confirm-modules-off"');
    expect(html).toContain("Medications");
  });

  it("says nothing when the answers take nothing away", () => {
    const html = render(state({}, { areas: ["sleep"], medication: "yes" }), {
      medications: true,
    });
    expect(html).not.toContain('data-slot="onboarding-confirm-modules-off"');
  });
});
