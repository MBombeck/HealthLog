import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * The setup flow's exit. AI gets one quiet line with a link to Settings, AI,
 * and only while it could be set up here and is still wanted; the exits
 * (dashboard, tour, connect, log) are there either way.
 */

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    mutate: () => {},
    mutateAsync: async () => {},
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const auth = vi.hoisted(() => ({ modules: {} as Record<string, boolean> }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", modules: auth.modules } }),
}));

/** `ai.provider` from `/api/auth/me`. */
const providerState = vi.hoisted(() => ({
  configured: false,
  canConfigure: true,
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiProviderState: () => ({
    configured: providerState.configured,
    managedBy: null,
    canConfigure: providerState.canConfigure,
  }),
}));

vi.mock("@/components/onboarding/use-onboarding-flow", () => ({
  useOnboardingAnswer: () => ({ mutate: () => {} }),
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

function withState(
  next: Partial<typeof providerState>,
  modules: Record<string, boolean>,
  run: () => void,
) {
  const before = { ...providerState };
  Object.assign(providerState, next);
  auth.modules = modules;
  try {
    run();
  } finally {
    Object.assign(providerState, before);
    auth.modules = {};
  }
}

describe("<DoneScreen> AI line", () => {
  it("is one line with a link to Settings, AI, and nothing more", () => {
    const html = render();
    const line = html.match(
      /<p[^>]*data-slot="onboarding-ai-line"[^>]*>([\s\S]*?)<\/p>/,
    );
    expect(line).not.toBeNull();
    expect(line![1]).toContain("AI is optional");
    // Body copy, not meta: the line is read, so it is not muted.
    expect(line![0]).not.toContain("text-muted-foreground");
    // One way on, the link, and no one-tap offer beside it.
    expect(html.split('href="/settings/ai"')).toHaveLength(2);
    expect(line![1]).not.toContain("<button");
  });

  it("is left out when AI cannot be set up here", () => {
    // The operator switched AI off, or the record belongs to somebody else.
    withState({ canConfigure: false }, {}, () => {
      const html = render();
      expect(html).not.toContain('data-slot="onboarding-ai-line"');
      expect(html).toContain('data-slot="onboarding-open-dashboard"');
    });
  });

  it("is left out once a provider is configured", () => {
    withState({ configured: true }, {}, () => {
      expect(render()).not.toContain('data-slot="onboarding-ai-line"');
    });
  });

  it("is left out once the Coach and AI analysis are switched off", () => {
    withState({}, { coach: false, insights: false }, () => {
      expect(render()).not.toContain('data-slot="onboarding-ai-line"');
    });
    withState({}, { coach: false, insights: true }, () => {
      expect(render()).toContain('data-slot="onboarding-ai-line"');
    });
  });
});

describe("<DoneScreen> exits", () => {
  it("keeps every exit", () => {
    const html = render();
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain('href="/measurements"');
    expect(html).toContain('data-slot="onboarding-open-dashboard"');
  });

  it("offers the tour rather than launching it", () => {
    expect(render()).toContain('data-slot="onboarding-take-tour"');
  });

  it("offers the managed profile only to an answer that asked for it later", () => {
    expect(render("both")).toContain('href="/settings/access"');
    expect(render("me")).not.toContain('href="/settings/access"');
  });
});
