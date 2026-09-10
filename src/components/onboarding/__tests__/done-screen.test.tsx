import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * The elevated done-screen AI panel must lead with value and gate nothing:
 * it shows the local-first ladder and the honest "useful without AI" line,
 * yet the three original exits (connect / log / dashboard) stay intact, so
 * a keyless user is never stranded. The shared-key note only appears when
 * the deployment's provider serves the user (`managedBy === "server"`).
 */

const aiProviderState = vi.hoisted(() => ({
  data: undefined as { managedBy?: string | null } | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: aiProviderState.data }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: () => {}, isPending: false }),
}));

vi.mock("@/components/onboarding/tour-launcher", () => ({
  setTourReferrer: () => {},
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";
import { DoneScreen } from "../done-screen";

function state(
  recordTarget: OnboardingStateDto["needs"]["recordTarget"] = "me",
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps(),
    needs: { ...emptyOnboardingNeeds(), recordTarget },
    completedAt: "2026-09-10T08:00:00.000Z",
    firstResult: null,
  };
}

function render(recordTarget?: OnboardingStateDto["needs"]["recordTarget"]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DoneScreen state={state(recordTarget)} />
    </I18nProvider>,
  );
}

describe("<DoneScreen> AI panel", () => {
  it("leads with the value-first panel and the local-first ladder", () => {
    aiProviderState.data = undefined;
    const html = render();
    expect(html).toContain('data-slot="onboarding-ai-panel"');
    // Local model is surfaced first (the calm private default).
    expect(html).toContain("nothing leaves your network");
    // The honest release valve is present and prominent.
    expect(html).toContain('data-slot="onboarding-ai-keyless"');
    expect(html).toContain("fully useful without AI");
    // Setup is a single optional deep-link, not a gate.
    expect(html).toContain('href="/settings/ai"');
  });

  it("keeps every exit so the panel is fully skippable", () => {
    aiProviderState.data = undefined;
    const html = render();
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain('href="/measurements"');
    expect(html).toContain('data-slot="onboarding-open-dashboard"');
  });

  it("offers the tour rather than launching it", () => {
    aiProviderState.data = undefined;
    expect(render()).toContain('data-slot="onboarding-take-tour"');
  });

  it("offers the managed profile only to an answer that asked for it later", () => {
    aiProviderState.data = undefined;
    expect(render("both")).toContain('href="/settings/access"');
    expect(render("me")).not.toContain('href="/settings/access"');
  });

  it("shows the shared-key note only when the operator key serves the user", () => {
    aiProviderState.data = { managedBy: "user" };
    expect(render()).not.toContain('data-slot="onboarding-ai-shared-key"');
    aiProviderState.data = { managedBy: "server" };
    expect(render()).toContain('data-slot="onboarding-ai-shared-key"');
  });
});
