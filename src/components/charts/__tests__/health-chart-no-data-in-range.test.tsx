import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.43 W11-M6 — chart empty-window state.
 *
 * Pre-fix the chart returned `null` when the loaded data array was
 * empty in the selected range, erasing the entire card (header +
 * tabs + chart). The user saw a missing widget without explanation.
 * The fix paints a "no data in this range" empty state via
 * `<ChartEmptyState>` so the dashboard composition stays intact and
 * the user knows the chart loaded but the selected window holds no
 * measurements. The copy is distinct from the < 3-points "Mehr
 * Messtage erforderlich" branch so the two situations don't blur.
 */

function buildData(rawCount: number): unknown[] {
  const points: unknown[] = [];
  Object.defineProperty(points, "rawCount", {
    value: rawCount,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return points;
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<HealthChart> — empty-window state (W11-M6)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders the no-data-in-range copy when data resolves to an empty array", async () => {
    const data = buildData(0);

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
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    // The new empty state must paint…
    expect(html).toContain("Keine Daten in diesem Zeitraum");
    // …and the chart card chrome (title) must still be mounted so the
    // dashboard isn't missing a tile. The pre-fix `return null` would
    // have stripped this entirely.
    expect(html).toContain("Pulse");
    // The < 3-points branch must NOT paint here — empty-window and
    // sparse-data are different situations with distinct copy.
    expect(html).not.toContain("Mehr Messtage erforderlich");
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");

    vi.doUnmock("@tanstack/react-query");
  });
});
