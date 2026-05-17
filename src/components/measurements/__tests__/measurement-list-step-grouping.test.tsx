import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.37 W7c — when the list filter is a cumulative HK type, the
 * list view renders one row per user-TZ day with the day's total and
 * a chevron that drills back into the per-sample chunks via a
 * separate query. This test mocks both queries (the parent + the
 * drill-down) and asserts the rendered surface paints the collapsed
 * shape without leaking per-sample rows by default.
 */

const collapsed = [
  {
    id: "day:ACTIVITY_STEPS:2026-05-15",
    type: "ACTIVITY_STEPS",
    value: 12000,
    unit: "steps",
    source: "APPLE_HEALTH",
    measuredAt: "2026-05-15T10:00:00.000Z",
    notes: null,
    dayKey: "2026-05-15",
    sampleCount: 42,
  },
];

// Per-mock TanStack Query stub: when the queryKey starts with
// "measurement-drilldown" we serve nothing (drill-down should not
// fire until the chevron is clicked, which static render never
// triggers).
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (
      Array.isArray(queryKey) &&
      queryKey[0] === "measurement-drilldown"
    ) {
      return { data: undefined, isLoading: false };
    }
    return {
      data: { measurements: collapsed, meta: { total: 1 } },
      isLoading: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "marc", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementList } from "../measurement-list";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MeasurementList />
    </I18nProvider>,
  );
}

describe("MeasurementList — cumulative-type collapsed view (W7c)", () => {
  it("renders the daily-total caption with the sample count", () => {
    const html = render("en");
    // The daily-total caption ("(42 samples)") sits next to the
    // day's total ("12000 steps") on the collapsed row.
    expect(html).toContain("12,000 steps");
    expect(html).toMatch(/\(42 samples\)/);
  });

  it("renders a chevron-expand button on the collapsed row", () => {
    const html = render("en");
    expect(html).toContain('data-testid="measurement-day-expand"');
    // The chevron exposes its expanded state via aria-expanded so
    // assistive tech announces the toggle correctly.
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("does not paint edit/delete affordances on the synthesised daily row", () => {
    const html = render("en");
    // The edit + delete actions are hidden because the synthetic
    // `day:…` id has no real Measurement row backing it. The chevron
    // is the only action.
    expect(html).not.toMatch(/aria-label="Edit"/);
    expect(html).not.toMatch(/aria-label="Delete"/);
  });

  it("localises the daily-total caption in German", () => {
    const html = render("de");
    expect(html).toMatch(/\(42 Einzelwerte\)/);
  });
});
