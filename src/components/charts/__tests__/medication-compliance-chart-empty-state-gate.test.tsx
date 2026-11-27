import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// vi.doMock below invalidates the module registry, so the re-imported
// provider gets a fresh (unprimed) locale cache — pass the DE bundle
// explicitly instead of relying on the vitest.setup.ts seeding.
import deMessages from "../../../../messages/de.json";

/**
 * v1.4.43 — medication-compliance empty-state copy split.
 *
 * The chart aggregates per-day compliance buckets, so a user with 20
 * scheduled doses on 2 calendar days collapses to `chartData.length =
 * 2`. The pre-v1.4.43 "log more measurements" hint misled — they
 * logged plenty, just on too few days. The gate now keys on
 * `rawCount = Σ scheduled` so the second message paints whenever the
 * user has enough raw doses but the chart is < 3 buckets wide.
 */

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
  await import("../medication-compliance-chart");
}, 60_000);

describe("<MedicationComplianceChart> — empty-state gate by raw count", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders need-more-days copy when chartData.length < 3 but rawCount >= 3", async () => {
    const data = [
      { date: "2026-05-19", scheduled: 10, taken: 8 },
      { date: "2026-05-20", scheduled: 10, taken: 9 },
    ];

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
    const { MedicationComplianceChart } =
      await import("../medication-compliance-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MedicationComplianceChart />
      </I18nProvider>,
    );

    expect(html).toContain("Mehr Messtage erforderlich");
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");

    vi.doUnmock("@tanstack/react-query");
  });

  it("renders no-data copy when rawCount < 3", async () => {
    const data = [{ date: "2026-05-20", scheduled: 1, taken: 1 }];

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
    const { MedicationComplianceChart } =
      await import("../medication-compliance-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <MedicationComplianceChart />
      </I18nProvider>,
    );

    expect(html).toContain("Erfasse mindestens 3 Einträge");
    expect(html).not.toContain("Mehr Messtage erforderlich");

    vi.doUnmock("@tanstack/react-query");
  });
});
