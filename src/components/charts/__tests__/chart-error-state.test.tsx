import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// vi.doMock below invalidates the module registry, so the re-imported
// provider gets a fresh (unprimed) locale cache — pass the DE bundle
// explicitly instead of relying on the vitest.setup.ts seeding.
import deMessages from "../../../../messages/de.json";

/**
 * v1.16.8 — failed chart queries must look like ERRORS, not "no data".
 *
 * Pre-fix all three dashboard charts destructured only
 * `{ data, isLoading }`: a failed query fell into the empty-state copy
 * ("Keine Daten in diesem Zeitraum" / "Keine Daten verfügbar") — and
 * the mood chart unmounted its card entirely. The fix surfaces
 * `isError` as a `<ChartErrorState>` card with a retry affordance in
 * each chart, keeping the card chrome mounted so the dashboard
 * composition stays intact.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

function mockQueryError() {
  vi.doMock("@tanstack/react-query", () => ({
    // `health-chart` imports `keepPreviousData` for its placeholder option;
    // the identity stand-in keeps the module-level destructure satisfied.
    keepPreviousData: (previous: unknown) => previous,
    useQuery: () => ({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: () => Promise.resolve(),
    }),
    useQueryClient: () => ({
      cancelQueries: () => Promise.resolve(),
      getQueryData: () => undefined,
      setQueryData: () => undefined,
      invalidateQueries: () => Promise.resolve(),
    }),
    useMutation: () => ({ mutate: () => undefined, isPending: false }),
  }));
}

describe("chart isError rendering — error state, not empty state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("<HealthChart> paints the error card with retry, keeps the card chrome", async () => {
    mockQueryError();

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="chart-error-state"');
    expect(html).toContain("Daten konnten nicht geladen werden");
    expect(html).toContain("Erneut versuchen");
    // Card chrome must stay mounted.
    expect(html).toContain("Pulse");
    // The retry button carries the chart title in its accessible name
    // so several failed charts on one page stay distinguishable.
    expect(html).toContain('aria-label="Erneut versuchen: Pulse"');
    // The empty-state copy must NOT paint — an outage is not "no data".
    expect(html).not.toContain("Keine Daten in diesem Zeitraum");

    vi.doUnmock("@tanstack/react-query");
  });

  it("<MoodChart> keeps the card mounted and paints the error card", async () => {
    mockQueryError();

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MoodChart } = await import("../mood-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MoodChart />
      </I18nProvider>,
    );

    // Pre-fix the component returned null here — html was empty.
    expect(html).toContain('data-slot="chart-error-state"');
    expect(html).toContain("Daten konnten nicht geladen werden");
    expect(html).toContain("Erneut versuchen");

    vi.doUnmock("@tanstack/react-query");
  });

  it("<MedicationComplianceChart> paints the error card, not the no-data hint", async () => {
    mockQueryError();

    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MedicationComplianceChart } =
      await import("../medication-compliance-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MedicationComplianceChart />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="chart-error-state"');
    expect(html).toContain("Daten konnten nicht geladen werden");
    expect(html).toContain("Erneut versuchen");
    expect(html).not.toContain("Keine Daten im gewählten Zeitraum");

    vi.doUnmock("@tanstack/react-query");
  });
});

describe("<ChartErrorState> — announcement, sizing, accessible name", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function renderState(
    props: Partial<import("../chart-error-state").ChartErrorStateProps> = {},
  ) {
    const { ChartErrorState } = await import("../chart-error-state");
    return renderToStaticMarkup(
      <ChartErrorState
        title="Data could not be loaded"
        actionLabel="Retry"
        onAction={() => undefined}
        {...props}
      />,
    );
  }

  it("announces the failure as a status by default", async () => {
    const html = await renderState();
    expect(html).toContain('role="status"');
  });

  it("escalates to alert when the boundary asks for it", async () => {
    const html = await renderState({ role: "alert" });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });

  it("sizes through the chart-height variables by default", async () => {
    // The former hardcoded `style="height:240px"` ignored per-mount
    // `--chart-height` overrides; the default now reads the same
    // variables the painted chart does.
    const html = await renderState();
    expect(html).toContain("h-[var(--chart-height,240px)]");
    expect(html).toContain("md:h-[var(--chart-height-md,280px)]");
    expect(html).not.toContain("height:240px");
  });

  it("keeps the explicit height prop as a per-mount override", async () => {
    const html = await renderState({ height: 140 });
    expect(html).toContain("height:140px");
    expect(html).not.toContain("h-[var(--chart-height,240px)]");
  });

  it("joins the action context into the retry button's accessible name", async () => {
    const html = await renderState({ actionContext: "Pulse" });
    expect(html).toContain('aria-label="Retry: Pulse"');
  });

  it("omits the aria-label without a context so the label is the name", async () => {
    const html = await renderState();
    expect(html).not.toContain("aria-label");
  });
});

describe("<ChartErrorBoundary> — chunk-failure fallback", () => {
  it("wraps the fallback in the chart-card shell and escalates to alert", () => {
    // Error boundaries do not catch during static SSR, so the fallback
    // wiring is pinned structurally: the fallback card must carry the
    // solid chart-card shell (not a bare dashed box among solid cards)
    // and pass `role="alert"` (the whole chart is gone, not just data).
    const src = readFileSync(
      join(process.cwd(), "src/components/charts/chart-error-state.tsx"),
      "utf8",
    );
    expect(src).toContain('data-slot="chart-error-boundary-card"');
    expect(src).toContain(
      'className="bg-card border-border rounded-xl border p-4 md:p-6"',
    );
    expect(src).toContain('role="alert"');
  });
});
