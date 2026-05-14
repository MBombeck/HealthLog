import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.19 phase A7 — `/targets` (Zielwerte) had `space-y-8` between
 * the page header (h1 + intro) and the first card grid. At Pixel-5
 * the maintainer reported "relativ viel Platz" wasted between the overview
 * and the first values. Tighten the rhythm to `space-y-6` (24px)
 * which matches the rest of the admin / settings pages.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/targets",
}));

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
          data: null,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        };
      }
      return {
        data: {
          targets: [],
          bpDiastolic: { current: null, average30: null, range: null },
          profile: {
            heightCm: null,
            age: null,
            gender: null,
            glucoseUnit: null,
          },
        },
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

describe("/targets page — vertical spacing", () => {
  it("uses space-y-6 (not space-y-8) between header and card grid", () => {
    const html = render();
    // Outer wrapper rhythm. `space-y-8` would leave ~32px of
    // unnecessary breathing room between the intro paragraph and the
    // first card; `space-y-6` (24px) brings it in line with the
    // admin / settings pages.
    expect(html).toMatch(/<div[^>]*\bspace-y-6\b/);
    expect(html).not.toMatch(/<div[^>]*\bspace-y-8\b/);
  });
});
