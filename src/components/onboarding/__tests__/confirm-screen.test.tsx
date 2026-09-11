/**
 * v1.39 (Wave C) — what the confirm screen is allowed to claim.
 *
 * C5 (research M-l): both of the screen's own Settings links are page routes,
 * and `hl_onboarding=pending` is still set while this screen is on — the
 * completion is what clears it, and this screen is what calls the completion.
 * The proxy sends both straight back to the flow, so on a first run they are
 * dead links under a sentence that is not yet true.
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

  it("says nothing to a guardian, whose own record the answers never touch", () => {
    // These answers describe the record being set up for somebody else. The
    // completion applies the derivation to THAT record and stamps the
    // guardian's own without deriving, so no module of the guardian's is
    // going anywhere — and the sentence must not say one is.
    const html = render(
      state(
        {},
        {
          recordTarget: "someone-else",
          areas: ["blood-pressure"],
          medication: "no",
        },
      ),
      { medications: true, workouts: true, documents: true },
    );
    expect(html).not.toContain('data-slot="onboarding-confirm-modules-off"');
  });
});

describe("<ConfirmScreen> — Settings links on a first run (C5)", () => {
  it("renders both as plain text while the completion has not run", () => {
    const html = render(state());
    expect(html).not.toContain('href="/settings/modules"');
    expect(html).not.toContain('href="/settings/account"');
    // The words stay: they say where the thing lives, which is true.
    expect(html).toContain("Settings, Modules");
    expect(html).toContain("Settings, Account");
  });

  it("renders them as links once the flow has been completed once", () => {
    const html = render(state({ completedAt: "2026-09-10T08:00:00.000Z" }), {});
    expect(html).toContain('href="/settings/modules"');
    expect(html).toContain('href="/settings/account"');
  });
});
