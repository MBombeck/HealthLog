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
  data: undefined as
    | {
        managedBy?: string | null;
        serverProviderHealth?: string;
        serverProviderOffer?: boolean;
        serverProviderConsent?: boolean;
      }
    | undefined,
}));

/**
 * The consent grant is a mutation, and this suite renders to static markup
 * (the house convention — there is no jsdom in this repo), so the click
 * itself cannot be dispatched. What IS worth proving is the request the
 * button would send, so every `useMutation` registration is captured here
 * and its `mutationFn` invoked directly.
 */
const mutations = vi.hoisted(
  () =>
    [] as Array<{
      mutationKey?: readonly unknown[];
      mutationFn?: () => Promise<unknown>;
    }>,
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: aiProviderState.data }),
  useMutation: (options?: {
    mutationKey?: readonly unknown[];
    mutationFn?: () => Promise<unknown>;
  }) => {
    if (options) mutations.push(options);
    return { mutate: () => {}, mutateAsync: async () => {}, isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

const apiFetchRaw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetchRaw,
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

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
});

/**
 * v1.38.19 (wave D) — the shared provider, offered only when it works.
 *
 * The card used to read `managedBy === "server"` and promise that insights
 * "work for you right now". That is a presence read: it knew a key was
 * configured, never that it worked, and it said nothing about the consent
 * receipt the egress actually needs — so a fresh account followed the
 * promise straight into a `consent.ai.required` refusal. On 2026-09-11 the
 * operator's own instance was answering HTTP 500 while the screen kept
 * making that promise.
 *
 * Four variants now, and only one of them has a button.
 */
function grantMutation() {
  return mutations.find((m) =>
    (m.mutationKey ?? []).some(
      (part) => typeof part === "string" && part.includes("consent"),
    ),
  );
}

describe("<DoneScreen> shared-provider offer", () => {
  it("offers one tap when the server says the provider is known to work", () => {
    aiProviderState.data = {
      managedBy: "server",
      serverProviderHealth: "healthy",
      serverProviderOffer: true,
      serverProviderConsent: false,
    };
    const html = render();
    expect(html).toContain('data-slot="onboarding-ai-offer"');
    expect(html).toContain('data-slot="onboarding-ai-offer-grant"');
    // The unproven promise is gone from this branch.
    expect(html).not.toContain('data-slot="onboarding-ai-shared-key"');
    expect(html).not.toContain('data-slot="onboarding-ai-unavailable"');
  });

  it("says the provider is not answering only when a failure earned it", () => {
    aiProviderState.data = {
      managedBy: "server",
      serverProviderHealth: "unhealthy",
      serverProviderOffer: false,
      serverProviderConsent: false,
    };
    const html = render();
    expect(html).toContain('data-slot="onboarding-ai-unavailable"');
    expect(html).not.toContain('data-slot="onboarding-ai-offer-grant"');
    expect(html).not.toContain('data-slot="onboarding-ai-shared-key"');
    // The rest of the panel is untouched in every branch.
    expect(html).toContain('data-slot="onboarding-ai-keyless"');
    expect(html).toContain('href="/settings/ai"');
  });

  it("claims nothing either way when nobody has measured the provider", () => {
    // `unknown` is an empty `provider_health` table — the state of every
    // instance until its first AI call, and the most common way through this
    // screen. Saying "not answering" there is a claim about something nobody
    // measured, which is the one thing this panel exists not to do.
    aiProviderState.data = {
      managedBy: "server",
      serverProviderHealth: "unknown",
      serverProviderOffer: false,
      serverProviderConsent: false,
    };
    const html = render();
    expect(html).not.toContain('data-slot="onboarding-ai-unavailable"');
    expect(html).not.toContain('data-slot="onboarding-ai-offer-grant"');
    expect(html).not.toContain('data-slot="onboarding-ai-shared-key"');
    // The neutral panel is the whole panel, minus any claim about a provider.
    expect(html).toContain('data-slot="onboarding-ai-keyless"');
    expect(html).toContain('href="/settings/ai"');
  });

  it("keeps the shared-key note for the one state it was ever true of", () => {
    aiProviderState.data = {
      managedBy: "server",
      serverProviderHealth: "healthy",
      serverProviderOffer: false,
      serverProviderConsent: true,
    };
    const html = render();
    expect(html).toContain('data-slot="onboarding-ai-shared-key"');
    expect(html).not.toContain('data-slot="onboarding-ai-offer-grant"');
    expect(html).not.toContain('data-slot="onboarding-ai-unavailable"');
  });

  it("leaves a user with their own provider the setup link and nothing else", () => {
    aiProviderState.data = {
      managedBy: "user",
      serverProviderHealth: "healthy",
      serverProviderOffer: false,
      serverProviderConsent: false,
    };
    const html = render();
    expect(html).not.toContain('data-slot="onboarding-ai-offer"');
    expect(html).not.toContain('data-slot="onboarding-ai-unavailable"');
    expect(html).not.toContain('data-slot="onboarding-ai-shared-key"');
    expect(html).toContain('href="/settings/ai"');
  });

  it("says nothing at all while the status is still in flight", () => {
    aiProviderState.data = undefined;
    const html = render();
    expect(html).not.toContain('data-slot="onboarding-ai-offer"');
    expect(html).not.toContain('data-slot="onboarding-ai-unavailable"');
  });

  it("grants through the affirmative web intent — the only path that may lift a revocation", async () => {
    mutations.length = 0;
    apiFetchRaw.mockReset();
    apiFetchRaw.mockResolvedValue({ ok: true });
    aiProviderState.data = {
      managedBy: "server",
      serverProviderHealth: "healthy",
      serverProviderOffer: true,
      serverProviderConsent: false,
    };
    render();
    const grant = grantMutation();
    expect(grant).toBeDefined();
    await grant!.mutationFn!();
    expect(apiFetchRaw).toHaveBeenCalledWith(
      "/api/consent/ai/web",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ intent: "affirmative" }),
      }),
    );
  });

  it("a refused grant throws rather than reporting a consent nobody recorded", async () => {
    mutations.length = 0;
    apiFetchRaw.mockReset();
    apiFetchRaw.mockResolvedValue({ ok: false, status: 429 });
    aiProviderState.data = {
      managedBy: "server",
      serverProviderHealth: "healthy",
      serverProviderOffer: true,
      serverProviderConsent: false,
    };
    render();
    const grant = grantMutation();
    await expect(grant!.mutationFn!()).rejects.toThrow();
  });
});
