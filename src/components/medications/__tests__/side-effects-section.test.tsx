import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import en from "../../../../messages/en.json";

const errorCardCapture = vi.hoisted(() => ({
  onRetry: undefined as (() => void) | undefined,
}));

type QueryErrorCardProps = {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

type QueryErrorCardModule = {
  QueryErrorCard: (props: QueryErrorCardProps) => ReactNode;
};

vi.mock("@/components/ui/query-error-card", async () => {
  // `vi.importActual` is required here so the wrapper can capture the retry
  // callback while preserving the shared card's real accessible markup/copy.
  const actual = await vi.importActual<QueryErrorCardModule>(
    "@/components/ui/query-error-card",
  );

  return {
    ...actual,
    QueryErrorCard: (props: QueryErrorCardProps) => {
      errorCardCapture.onRetry = props.onRetry;
      return actual.QueryErrorCard(props);
    },
  };
});

import { SideEffectsSection } from "@/components/medications/side-effects-section";

/**
 * v1.4.25 W19d — SideEffectsSection SSR smoke tests.
 *
 * The project never installed `@testing-library/react`; the
 * convention is `renderToStaticMarkup` + assertions against the SSR
 * string, with react-query data seeded via `QueryClient.setQueryData()`
 * so the section's `useQuery` resolves synchronously. Interactive
 * branches (submit, delete, dialog open) are covered by the API-route
 * tests + the pure taxonomy tests; the surface tests here pin the
 * static-render contract:
 *
 *   1. Section heading + add-CTA render in both locales.
 *   2. Empty state copy when no rows are seeded.
 *   3. Recent-30-days timeline renders entries with category badge,
 *      entry label, severity label, and notes.
 *   4. Severity translation passes through the Likert ladder.
 *   5. Category badge translation uses the i18n category key.
 */

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Synchronous resolution of seeded data is the test contract.
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
        retryOnMount: false,
      },
    },
  });
}

function seedSideEffects(
  client: QueryClient,
  medId: string,
  rows: Array<{
    id: string;
    category: string;
    entry: string;
    severity: number;
    occurredAt: string;
    notes: string | null;
  }>,
) {
  client.setQueryData(queryKeys.medicationSideEffects(medId), {
    items: rows,
    meta: { total: rows.length },
  });
}

function render(
  node: React.ReactNode,
  client: QueryClient,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  errorCardCapture.onRetry = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function emptySideEffectsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: { items: [], meta: { total: 0 } },
      error: null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function executeSideEffectsQuery(
  client: QueryClient,
  medicationId: string,
): Promise<void> {
  const queryKey = queryKeys.medicationSideEffects(medicationId);
  const queryFn = client.getQueryCache().find({ queryKey, exact: true })
    ?.options.queryFn;
  if (typeof queryFn !== "function") {
    throw new Error("Side-effects query function was not registered");
  }
  try {
    await client.fetchQuery({ queryKey, queryFn });
  } catch {
    // The settled error is the state under test.
  }
}

async function waitForQueryStatus(
  client: QueryClient,
  medicationId: string,
  status: "error" | "success",
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      client.getQueryState(queryKeys.medicationSideEffects(medicationId))
        ?.status,
    ).toBe(status);
  });
}

describe("<SideEffectsSection> — failed reads", () => {
  it.each([
    {
      failure: "HTTP",
      response: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: null, error: "service unavailable" }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
    },
    {
      failure: "non-JSON",
      response: () =>
        Promise.resolve(
          new Response("<html>not json</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
        ),
    },
    {
      failure: "rejected",
      response: () => Promise.reject(new TypeError("network unavailable")),
    },
  ])(
    "renders Retry instead of the empty state after a $failure failure",
    async ({ response }) => {
      const client = makeClient();
      const fetchMock = vi.fn(response);
      vi.stubGlobal("fetch", fetchMock);

      render(<SideEffectsSection medicationId="med-failure" />, client);
      await executeSideEffectsQuery(client, "med-failure");
      await waitForQueryStatus(client, "med-failure", "error");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const html = render(
        <SideEffectsSection medicationId="med-failure" />,
        client,
      );

      expect(html).toContain('data-slot="query-error-card"');
      expect(html).toContain('role="alert"');
      expect(html).toContain(en.common.loadFailed);
      expect(html).toContain(en.common.retry);
      expect(html).not.toContain(en.medications.sideEffects.emptyState);
    },
  );

  it("retries the failed query and renders the genuine empty response", async () => {
    const client = makeClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(emptySideEffectsResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<SideEffectsSection medicationId="med-retry" />, client);
    await executeSideEffectsQuery(client, "med-retry");
    await waitForQueryStatus(client, "med-retry", "error");
    const errorHtml = render(
      <SideEffectsSection medicationId="med-retry" />,
      client,
    );
    expect(errorHtml).toContain(en.common.retry);
    expect(errorCardCapture.onRetry).toBeTypeOf("function");

    errorCardCapture.onRetry?.();
    await waitForQueryStatus(client, "med-retry", "success");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recoveredHtml = render(
      <SideEffectsSection medicationId="med-retry" />,
      client,
    );
    expect(recoveredHtml).not.toContain('data-slot="query-error-card"');
    expect(recoveredHtml).toContain(en.medications.sideEffects.emptyState);
  });
});

describe("<SideEffectsSection> — surface render", () => {
  it("renders the section heading and add-CTA in English", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", []);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Side effects");
    // v1.4.28 FB-F1 — the CTA dropped its qualifier so the chip stops
    // overflowing the side-effects card on narrow viewports. The
    // section title carries the context.
    expect(html).toContain(">Log<");
    expect(html).not.toContain("Log side effect");
  });

  it("renders the section heading and add-CTA in German", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", []);
    const html = render(
      <SideEffectsSection medicationId="med-1" />,
      client,
      "de",
    );
    expect(html).toContain("Nebenwirkungen");
    expect(html).toContain(">Erfassen<");
    expect(html).not.toContain("Nebenwirkung erfassen");
  });

  it("renders the empty-state copy when no rows are seeded", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", []);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("No side effects logged yet");
  });
});

describe("<SideEffectsSection> — timeline rows", () => {
  it("renders entry label, category badge, and severity label", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Nausea");
    expect(html).toContain("Gastrointestinal");
    expect(html).toContain("Moderate");
  });

  it("renders multi-category rows independently", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "GI",
        entry: "NAUSEA",
        severity: 1,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
      {
        id: "se-2",
        category: "GLP1_SPECIFIC",
        entry: "EARLY_SATIETY",
        severity: 4,
        occurredAt: "2026-05-12T08:00:00.000Z",
        notes: "felt full after two bites",
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Nausea");
    expect(html).toContain("Mild");
    expect(html).toContain("Early satiety");
    expect(html).toContain("GLP-1 specific");
    expect(html).toContain("Severe");
    expect(html).toContain("felt full after two bites");
  });

  it("shows the recent-30-days label when items are present", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "COGNITIVE",
        entry: "BRAIN_FOG",
        severity: 3,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Last 30 days");
  });

  it("translates the severity-label ladder via the i18n helper", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "a",
        category: "GI",
        entry: "NAUSEA",
        severity: 1,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
      {
        id: "b",
        category: "GI",
        entry: "VOMITING",
        severity: 5,
        occurredAt: "2026-05-13T09:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Mild");
    expect(html).toContain("Very severe");
  });

  it("narrows the date column to w-14 at narrow viewports (D-H7)", () => {
    // The earlier `w-[5.5rem]` (88 px) date column overspec pushed
    // the category badge + entry label + severity chip's left slot
    // into a wrap-prone shape at 320 px. The narrowed `w-14` (56 px)
    // fits the longest short-date variant ("15. Mai") with slack
    // and recovers 32 px for the free-text notes.
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    // Class attribute order in SSR depends on JSX prop order; match
    // either order so the assertion stays stable across React minor
    // versions.
    const dateCell = html.match(
      /<p[^>]*data-slot="side-effect-row-date"[^>]*>|<p[^>]*class="[^"]*w-14[^"]*"[^>]*data-slot="side-effect-row-date"/,
    );
    expect(dateCell).not.toBeNull();
    // Source-of-truth check via the rendered HTML — pin both the
    // adoption (`w-14`) and the absence (`w-[5.5rem]`).
    expect(html).toContain('data-slot="side-effect-row-date"');
    const tagWithSlot = html.match(
      /<p[^>]*data-slot="side-effect-row-date"[^>]*>/,
    );
    expect(tagWithSlot?.[0]).toContain("w-14");
    expect(tagWithSlot?.[0]).not.toContain("w-[5.5rem]");
  });

  it("renders German entry and category labels when locale=de", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "INJECTION_SITE",
        entry: "INJECTION_REDNESS",
        severity: 2,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(
      <SideEffectsSection medicationId="med-1" />,
      client,
      "de",
    );
    expect(html).toContain("Injektionsstelle");
    expect(html).toContain("Rötung Einstichstelle");
    expect(html).toContain("Mittel");
  });
});
