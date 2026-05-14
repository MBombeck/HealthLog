import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.25 W3e — Coach drawer mount + per-card CTA gate.
 *
 * Two scenarios:
 *   1. AI provider configured → per-card "Ask Coach" CTAs render
 *      alongside each card; the drawer is mounted at the page level.
 *   2. AI provider NOT configured → CTAs are completely absent (no
 *      broken-button state) but the drawer mount stays present (it's
 *      controlled by the parent regardless; no harm in mounting it
 *      collapsed, and it costs ~0 since closed Sheets render only the
 *      portal root).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/targets",
}));

const sampleData = {
  targets: [
    {
      type: "WEIGHT",
      label: "Weight",
      current: 78,
      average30: 78,
      trend: "stable",
      unit: "kg",
      range: { min: 60, max: 80 },
      classification: { category: "Normal", color: "#50fa7b" },
      source: "WHO BMI",
      daysInRange7d: 5,
      daysLogged7d: 7,
      lastMetGoalAt: null,
      streakDays: 0,
      insufficientData: false,
      consistency7d: ["in", "in", "in", "in", "in", "in", "in"],
    },
  ],
  pageSummary: {
    targetsMetThisWeek: 1,
    totalTargets: 1,
    streakHighlight: null,
  },
  bpDiastolic: { current: null, average30: null, range: null },
  profile: { heightCm: 180, age: 35, gender: "MALE", glucoseUnit: null },
};

let providerChainResponse: { activeProvider: string | null } | null = null;

vi.mock("@tanstack/react-query", () => {
  const noopClient = {
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
    refetchQueries: vi.fn(),
  };
  return {
    useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[1] === "provider-chain") {
        return {
          data: providerChainResponse,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        };
      }
      return {
        data: sampleData,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    },
    useQueryClient: () => noopClient,
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      role: "USER",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import TargetsPage from "../targets/page";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TargetsPage />
    </I18nProvider>,
  );
}

describe("/targets page — Coach drawer mount + CTA gate", () => {
  it("renders the per-card Coach CTA when an AI provider is configured", () => {
    providerChainResponse = { activeProvider: "openai" };
    const html = render();
    expect(html).toContain('data-slot="target-coach-cta"');
    expect(html).toContain("Ask Coach");
  });

  it("hides every per-card Coach CTA when no AI provider is configured", () => {
    providerChainResponse = { activeProvider: null };
    const html = render();
    expect(html).not.toContain('data-slot="target-coach-cta"');
  });

  it("renders nothing different when chainStatus query is still loading", () => {
    providerChainResponse = null;
    const html = render();
    // Same as the "no provider" branch — until we know the provider is
    // configured we don't render a CTA whose click would 404.
    expect(html).not.toContain('data-slot="target-coach-cta"');
  });
});
