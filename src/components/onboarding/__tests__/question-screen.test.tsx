/**
 * v1.39 (C2) — the chip question screen, as the server paints it.
 *
 * Vitest runs without a DOM here, so what is pinned is the first paint: the
 * stored answer is pre-selected, Q1 cannot be passed and cannot continue
 * without an answer, every other question can be passed, and a real radio or
 * checkbox sits inside each chip so the browser owns the grouping. The click
 * path is the e2e journey's.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";
import { QuestionScreen } from "../question-screen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function state(
  needs: Partial<OnboardingStateDto["needs"]>,
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps(),
    needs: { ...emptyOnboardingNeeds(), ...needs },
    completedAt: null,
    firstResult: null,
  };
}

function render(step: "who" | "areas" | "visit", needs = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <QuestionScreen step={step} state={state(needs)} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<QuestionScreen>", () => {
  it("pre-selects the stored answer", () => {
    const html = render("areas", { areas: ["glucose", "labs"] });
    expect(html).toContain('data-value="glucose" data-checked="true"');
    expect(html).toContain('data-value="labs" data-checked="true"');
    expect(html).toContain('data-value="mood" data-checked="false"');
  });

  it("uses radios for one answer and checkboxes for many", () => {
    expect(render("who")).toContain('type="radio"');
    expect(render("who")).not.toContain('type="checkbox"');
    expect(render("areas")).toContain('type="checkbox"');
  });

  it("gives Q1 no skip and no way on without an answer", () => {
    const html = render("who");
    expect(html).not.toContain('data-slot="onboarding-skip"');
    expect(html).toMatch(/data-slot="onboarding-next"[^>]*disabled/);
  });

  it("lets every other question be passed", () => {
    expect(render("visit")).toContain('data-slot="onboarding-skip"');
  });

  it("renders no raw key", () => {
    for (const step of ["who", "areas", "visit"] as const) {
      expect(render(step)).not.toMatch(/onboarding\.flow\./);
    }
  });
});
