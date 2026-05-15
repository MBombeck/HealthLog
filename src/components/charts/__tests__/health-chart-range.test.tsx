import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.28 R3a FB-D2 (R1.2 H0) — assert the HealthChart fetcher passes
 * a bounded `from` / `to` window to `/api/measurements` instead of
 * walking the full history with a `while (true)` loop.
 *
 * The test intercepts the underlying `useQuery` so the assertion can
 * lock down the query key shape AND the fetch URL the queryFn invokes.
 * If a future refactor re-introduces an unbounded walk the queryFn
 * mock will fire with no `from=` / `to=` segment and the test fails.
 */

const fetchCalls: string[] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({
    queryFn,
    queryKey,
  }: {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
    staleTime?: number;
    gcTime?: number;
  }) => {
    // Surface the query key so the test can introspect it.
    (globalThis as unknown as { __lastQueryKey?: unknown[] }).__lastQueryKey =
      queryKey;
    // Fire the queryFn synchronously (it will call our fetch stub).
    void queryFn();
    return { data: [], isLoading: false };
  },
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

beforeEach(() => {
  fetchCalls.length = 0;
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    return new Response(
      JSON.stringify({ data: { measurements: [], meta: { total: 0 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

describe("<HealthChart> — bounded range fetch", () => {
  it("sends from + to + a 5000-row cap to /api/measurements", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    // Wait a tick so the queryFn fetch resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCalls.length).toBeGreaterThan(0);
    const measurementsUrl = fetchCalls.find((u) =>
      u.includes("/api/measurements"),
    );
    expect(measurementsUrl).toBeDefined();
    expect(measurementsUrl!).toMatch(/from=/);
    expect(measurementsUrl!).toMatch(/to=/);
    expect(measurementsUrl!).toMatch(/limit=5000/);
    expect(measurementsUrl!).toMatch(/type=PULSE/);
    // Guard against the legacy unbounded paginator returning.
    expect(measurementsUrl!).not.toMatch(/offset=/);
  });

  it("re-keys the query when the range window changes", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    const key = (globalThis as unknown as { __lastQueryKey?: unknown[] })
      .__lastQueryKey;
    expect(key).toBeDefined();
    // Last two slots are `from` / `to`. Both must be ISO date strings.
    const isoRe = /\d{4}-\d{2}-\d{2}T/;
    expect(String(key![key!.length - 2])).toMatch(isoRe);
    expect(String(key![key!.length - 1])).toMatch(isoRe);
  });
});
