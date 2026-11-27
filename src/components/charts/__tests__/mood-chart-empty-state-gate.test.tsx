import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// vi.doMock below invalidates the module registry, so the re-imported
// provider gets a fresh (unprimed) locale cache — pass the DE bundle
// explicitly instead of relying on the vitest.setup.ts seeding.
import deMessages from "../../../../messages/de.json";

/**
 * v1.4.43 — mood-chart empty-state copy split.
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

/**
 * Day key `agoDays` before now. The range tabs are calendar-day windows
 * anchored on now (v1.37.29), so absolute-dated entries would age out of
 * the default window and both cases would collapse into the no-data copy.
 */
function dayKeyAgo(agoDays: number): string {
  return new Date(Date.now() - agoDays * 86_400_000).toISOString().slice(0, 10);
}

// The chart pulls in Recharts and the chart kit. Transforming that graph cold
// takes seconds on a loaded machine, so it happens once here, on a hook's
// budget, instead of inside whichever test happens to run first.
beforeAll(async () => {
  await import("../mood-chart");
}, 60_000);

describe("<MoodChart> — empty-state gate by raw count", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders need-more-days copy when chartData.length < 3 but rawCount >= 3", async () => {
    const data = {
      entries: [
        { date: dayKeyAgo(1), score: 4, samples: 25 },
        { date: dayKeyAgo(0), score: 5, samples: 25 },
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
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MoodChart />
      </I18nProvider>,
    );

    expect(html).toContain("Mehr Messtage erforderlich");
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");

    vi.doUnmock("@tanstack/react-query");
  });

  it("renders no-data copy when rawCount < 3", async () => {
    const data = {
      entries: [{ date: dayKeyAgo(0), score: 4, samples: 1 }],
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
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MoodChart />
      </I18nProvider>,
    );

    expect(html).toContain("Erfasse mindestens 3 Einträge");
    expect(html).not.toContain("Mehr Messtage erforderlich");

    vi.doUnmock("@tanstack/react-query");
  });
});
