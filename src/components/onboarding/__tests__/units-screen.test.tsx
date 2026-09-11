/**
 * v1.39 (Wave C, C3) — Q6 cannot be answered with nothing chosen (M-k).
 *
 * "Weiter" used to be live on an untouched units screen: it wrote
 * `{ units: {} }`, which marked the step DONE without recording a preference,
 * so the account carried "asked and answered" for a question nobody answered.
 * Skip is the way past a question with no opinion, and Skip says so on the
 * ledger.
 *
 * Rendered server-side, this repo's component-test convention.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";

import { UnitsScreen } from "../units-screen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null }),
}));

function state(
  needs: Partial<OnboardingStateDto["needs"]>,
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps(),
    needs: { ...emptyOnboardingNeeds(), recordTarget: "me", ...needs },
    completedAt: null,
    firstResult: null,
  };
}

function render(needs: Partial<OnboardingStateDto["needs"]>): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <UnitsScreen state={state(needs)} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * Is the primary button's own tag disabled? Read off the tag rather than the
 * whole page, and off the attribute rather than the string "disabled", which
 * also occurs in the button's `disabled:` utility classes.
 */
function nextIsDisabled(html: string): boolean {
  const at = html.indexOf('data-slot="onboarding-next"');
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", at) + 1).includes('disabled=""');
}

describe("<UnitsScreen>", () => {
  it("does not let the person continue without choosing a unit", () => {
    const html = render({ areas: ["glucose"] });
    expect(nextIsDisabled(html)).toBe(true);
    // Skip is still there: it is the honest way past a question with no
    // opinion, and it says "skipped" on the ledger.
    expect(html).toContain('data-slot="onboarding-skip"');
  });

  it("lets the person continue once a unit is chosen", () => {
    const html = render({
      areas: ["glucose"],
      units: { glucoseUnit: "mg/dL", unitPreference: null },
    });
    expect(nextIsDisabled(html)).toBe(false);
  });
});
