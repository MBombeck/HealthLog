import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import deMessages from "../../../../messages/de.json";

/**
 * Chart card heading level.
 *
 * The icon-less chart header (dashboard cells, /insights/bmi, the sleep
 * overview) titles itself at the second level. It has to: the card is a
 * sibling of the other cards around it, and those already name themselves
 * there — the dashboard's "Recent unlocks" and "Recent workouts" tiles render
 * `<TileHeader titleAs="h2">`, and the metric subpages' target / usual-range
 * cards are `<h2>` too. At `<h3>` the card claimed to be nested inside a
 * section that does not exist, and the page skipped a level straight from its
 * `<h1>`: the dashboard read h1 → h3 → h3 → h3 → h2 → h2 and /insights/bmi
 * read h1 → h3 → h2.
 *
 * The browser scan in `e2e/a11y.spec.ts` catches a regression here through
 * axe's `heading-order` rule, but only in the e2e job. This is the cheap
 * guard that fails in the unit run.
 */

function buildData(): unknown[] {
  const out: Array<{ date: string; timestamp: number; PULSE: number }> = [];
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  for (let i = 0; i < 10; i++) {
    out.push({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      timestamp: base + i * 86_400_000,
      PULSE: 60 + i,
    });
  }
  return out;
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

// The chart pulls in Recharts and the chart kit. Transforming that graph cold
// takes seconds on a loaded machine, so it happens once here, on a hook's
// budget, instead of inside whichever test happens to run first.
beforeAll(async () => {
  await import("../health-chart");
}, 60_000);

describe("<HealthChart> — card heading level", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("titles the icon-less chart card at the second level, never the third", async () => {
    const data = buildData();

    vi.doMock("@tanstack/react-query", () => ({
      // `health-chart` imports `keepPreviousData` for its placeholder option;
      // the identity stand-in keeps the module-level destructure satisfied.
      keepPreviousData: (previous: unknown) => previous,
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
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    // The title is a real heading carrying the real title text, not a styled
    // div — assert both halves so a silent demotion to a `<span>` fails too.
    expect(html).toContain('<h2 class="text-sm font-semibold">Pulse</h2>');
    expect(html).not.toContain("<h3");

    vi.doUnmock("@tanstack/react-query");
  });
});
