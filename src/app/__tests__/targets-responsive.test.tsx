import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.25 W3e — mobile-first responsive layout audit.
 *
 * Marc directive: "mobile layout must be designed alongside desktop,
 * not as an afterthought". This test pins the Tailwind responsive
 * utilities so a future refactor cannot quietly collapse the grid
 * back to the v1.4.22 `sm:grid-cols-2` and remove the lg three-col
 * row.
 *
 * The three breakpoints we care about:
 *   • default (<640px): one column, full-width cards
 *   • sm (640-1023px): two columns
 *   • lg (1024px+): three columns, slightly wider gutters
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
          data: { activeProvider: "openai" },
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

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <TargetsPage />
    </I18nProvider>,
  );
}

describe("/targets page — mobile-first responsive grid", () => {
  it("uses one column by default, two at sm, three at lg", () => {
    const html = render();
    expect(html).toMatch(/grid-cols-1/);
    expect(html).toMatch(/sm:grid-cols-2/);
    expect(html).toMatch(/lg:grid-cols-3/);
  });

  it("uses gap-4 at mobile/sm, gap-6 at lg", () => {
    const html = render();
    expect(html).toMatch(/\bgap-4\b/);
    expect(html).toMatch(/lg:gap-6/);
  });

  it("renders the Coach CTA as an icon-only affordance on every target card", () => {
    const html = render();
    expect(html).toContain('data-slot="target-coach-cta"');
    expect(html).toContain('aria-label="Ask Coach"');
    expect(html).toContain("size-10");
  });
});
