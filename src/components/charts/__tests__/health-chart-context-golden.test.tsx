import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";

import type { ChartContextResponse } from "@/lib/charts/context-markers-contract";

/**
 * The context marks may never change a chart that has nothing around it.
 * The golden is the chart as it renders without the feature (no provider):
 * the same chart inside an opted-in page must render byte-identical markup
 * when the record holds no marks, or only marks outside the drawn window.
 * With a mark inside it, the row of marks appears, named for a screen
 * reader, each mark a button saying what happened.
 */
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");

/** Ten daily readings ending yesterday, at noon UTC of each day. */
function series() {
  return Array.from({ length: 10 }, (_, i) => ({
    date: `p${i}`,
    timestamp: NOW - (10 - i) * DAY_MS,
    PULSE: 60 + i,
  }));
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

async function renderChart(options: {
  provider: boolean;
  context?: ChartContextResponse;
}) {
  // Every render imports afresh, so each one reads its own mocked answer.
  vi.resetModules();
  vi.doMock("@tanstack/react-query", () => ({
    keepPreviousData: (previous: unknown) => previous,
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
      queryKey[1] === "chart-context"
        ? { data: options.context, isLoading: false }
        : { data: series(), isLoading: false },
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
  const { ChartContextProvider } =
    await import("../health-chart/context-scope");
  const chart = (
    <HealthChart
      types={["PULSE"]}
      title="Resting heart rate"
      unit="bpm"
      showDataTable
      dayLinks
    />
  );
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages}>
      {options.provider ? (
        <ChartContextProvider enabled>{chart}</ChartContextProvider>
      ) : (
        chart
      )}
    </I18nProvider>,
  );
  vi.doUnmock("@tanstack/react-query");
  return html;
}

function empty(): ChartContextResponse {
  return {
    today: "2026-11-03",
    medications: [],
    illnesses: [],
    cyclePhases: [],
  };
}

function withMark(date: string): ChartContextResponse {
  return {
    ...empty(),
    medications: [
      {
        id: `m1:doseChange:${date}`,
        medicationId: "m1",
        kind: "doseChange",
        date,
        estimated: false,
        name: "Ramipril",
        dose: "10 mg",
        href: "/medications/m1/history",
      },
    ],
  };
}

describe("<HealthChart> context marks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the golden markup when the record holds no marks", async () => {
    const golden = await renderChart({ provider: false });
    expect(golden).toContain('data-slot="chart-plot"');
    expect(await renderChart({ provider: true, context: empty() })).toBe(
      golden,
    );
    // Still loading, or failed: nothing either.
    expect(await renderChart({ provider: true, context: undefined })).toBe(
      golden,
    );
  });

  it("renders the golden markup when every mark lies outside the window", async () => {
    const golden = await renderChart({ provider: false });
    expect(
      await renderChart({ provider: true, context: withMark("2026-01-15") }),
    ).toBe(golden);
  });

  it("never draws marks outside an opted-in page", async () => {
    const golden = await renderChart({ provider: false });
    // The same record data, no provider: the read is not even enabled.
    expect(
      await renderChart({ provider: false, context: withMark("2026-10-30") }),
    ).toBe(golden);
  });

  it("adds a named row of marks, each saying what happened", async () => {
    const html = await renderChart({
      provider: true,
      context: withMark("2026-10-30"),
    });
    expect(html).toContain('data-slot="chart-context"');
    expect(html).toContain('aria-label="Medication and illness in this range"');
    const buttons = html.match(/data-slot="chart-context-mark"/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(html).toMatch(/aria-label="[^"]*Ramipril: dose changed to 10 mg"/);
  });
});
