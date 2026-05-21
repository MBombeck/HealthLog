import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.43 W2-CHART-GATE — mood-chart empty-state copy split.
 *
 * `chartData` collapses entries to one point per calendar day, so a
 * user with many mood entries on < 3 distinct days saw the legacy
 * "log more entries" copy despite having logged plenty. The gate now
 * keys on `rawCount = Σ entries[].samples` so the second message
 * paints when the user only needs more spread across days.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<MoodChart> — empty-state gate by raw count", () => {
  beforeEach(() => {
    vi.resetModules();
  });


  it("renders need-more-days copy when chartData.length < 3 but rawCount >= 3", async () => {
    const data = {
      entries: [
        { date: "2026-05-19", score: 4, samples: 25 },
        { date: "2026-05-20", score: 5, samples: 25 },
      ],
      trend: null,
    };

    vi.doMock("@tanstack/react-query", () => ({
      useQuery: () => ({ data, isLoading: false }),
      useQueryClient: () => ({
        cancelQueries: () => Promise.resolve(),
        getQueryData: () => undefined,
        setQueryData: () => undefined,
        invalidateQueries: () => Promise.resolve(),
      }),
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    }));

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MoodChart } = await import("../mood-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <MoodChart />
      </I18nProvider>,
    );

    expect(html).toContain("Mehr Messtage erforderlich");
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");

    vi.doUnmock("@tanstack/react-query");
  });

  it("renders no-data copy when rawCount < 3", async () => {
    const data = {
      entries: [{ date: "2026-05-20", score: 4, samples: 1 }],
      trend: null,
    };

    vi.doMock("@tanstack/react-query", () => ({
      useQuery: () => ({ data, isLoading: false }),
      useQueryClient: () => ({
        cancelQueries: () => Promise.resolve(),
        getQueryData: () => undefined,
        setQueryData: () => undefined,
        invalidateQueries: () => Promise.resolve(),
      }),
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    }));

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MoodChart } = await import("../mood-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <MoodChart />
      </I18nProvider>,
    );

    expect(html).toContain("Erfasse mindestens 3 Einträge");
    expect(html).not.toContain("Mehr Messtage erforderlich");

    vi.doUnmock("@tanstack/react-query");
  });
});
