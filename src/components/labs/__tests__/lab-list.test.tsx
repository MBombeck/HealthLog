import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { ModuleListPrefs } from "@/lib/settings/module-list-layout";
import type { LabOverviewResponse, LabResultDto } from "../types";
import { LabList } from "../lab-list";

let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/labs",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

let mockModulePrefs: ModuleListPrefs = {
  view: "list",
  order: [],
  sortDir: "recentDesc",
  groupBy: "none",
  groupsOpen: "expanded",
  categoryOrder: [],
};

const displayZone = vi.hoisted(() => ({ current: "UTC" }));

vi.mock("@/lib/i18n/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/context")>();
  return {
    ...actual,
    useDisplayTimezone: () => displayZone.current,
  };
});

vi.mock("@/lib/module-list-prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-list-prefs")>();
  return {
    ...actual,
    useModuleListPrefs: () => ({
      prefs: mockModulePrefs,
    }),
  };
});

function mockReading(over: Partial<LabResultDto>): LabResultDto {
  return {
    id: "r1",
    biomarkerId: "b1",
    panel: null,
    analyte: "Ferritin",
    value: 80,
    valueText: null,
    unit: "ng/mL",
    converted: false,
    sourceValue: null,
    sourceUnit: null,
    referenceLow: 30,
    referenceHigh: 400,
    catalogReferenceLow: 30,
    catalogReferenceHigh: 400,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    printedReferenceText: null,
    referenceOrigin: "catalog",
    referenceDivergesFromCatalog: false,
    takenAt: "2026-09-01T12:00:00.000Z",
    source: "MANUAL",
    hasNote: false,
    rangeStatus: "in-range",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...over,
  };
}

describe("<LabList>", () => {
  beforeEach(() => {
    mockSearch = "";
    displayZone.current = "UTC";
    mockModulePrefs = {
      view: "list",
      order: [],
      sortDir: "recentDesc",
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
    };
  });

  it("renders genuine empty state when no biomarkers exist in data", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [],
      categories: [],
      grouped: false,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(html).not.toContain('data-slot="lab-filter-rail"');
    expect(html).toContain("No lab results yet");
  });

  it("renders filter rail and populated rows when data exists", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [
        {
          key: "bm:b1",
          count: 1,
          trend: [80],
          latest: mockReading({ analyte: "Ferritin" }),
        },
      ],
      categories: [],
      grouped: false,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('data-slot="lab-filter-rail"');
    expect(html).toContain("Ferritin");
    expect(html).toContain("1 biomarker");
  });

  it("renders filtered empty state with rail and Reset button when filters match 0 rows", () => {
    mockSearch = "q=NonExistentBiomarker";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [
        {
          key: "bm:b1",
          count: 1,
          trend: [80],
          latest: mockReading({ analyte: "Ferritin" }),
        },
      ],
      categories: [],
      grouped: false,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('data-slot="lab-filter-rail"');
    expect(html).toContain("No matching biomarkers");
    expect(html).toContain("Reset");
  });

  it("recalculates category header member count and status pill from filtered rows (B5)", () => {
    // 3 markers in cat_iron: 1 below, 2 in-range
    // When filtering by ?status=below, category should show 1 member and 1 of 1 outside range
    mockSearch = "status=below";
    mockModulePrefs = {
      view: "list",
      order: [],
      sortDir: "recentDesc",
      groupBy: "category",
      groupsOpen: "expanded",
      categoryOrder: [],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [
        {
          key: "bm:b1",
          count: 1,
          trend: [10],
          latest: mockReading({
            analyte: "Iron",
            rangeStatus: "below",
          }),
        },
        {
          key: "bm:b2",
          count: 1,
          trend: [80],
          latest: mockReading({
            analyte: "Ferritin",
            rangeStatus: "in-range",
          }),
        },
        {
          key: "bm:b3",
          count: 1,
          trend: [250],
          latest: mockReading({
            analyte: "Transferrin",
            rangeStatus: "in-range",
          }),
        },
      ],
      categories: [
        {
          key: "cat_iron",
          label: "Iron Panel",
          markerKeys: ["bm:b1", "bm:b2", "bm:b3"],
          counts: { inRange: 2, below: 1, above: 0, unknown: 0 },
          status: "below",
        },
      ],
      grouped: true,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    // Only the 'below' marker (Iron) should be in the list
    expect(html).toContain("Iron");
    expect(html).not.toContain("Ferritin");
    expect(html).not.toContain("Transferrin");

    // The category header reflects the filtered 1 row (tested further in browser DOM suite)
    expect(html).toContain("1 of 1 outside range");
  });

  it("handles sort=manual gracefully when manual order is empty", () => {
    mockSearch = "sort=manual";
    mockModulePrefs = {
      view: "list",
      order: [], // no manual order
      sortDir: "recentDesc",
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [
        {
          key: "bm:b1",
          count: 1,
          trend: [80],
          latest: mockReading({ analyte: "Ferritin" }),
        },
      ],
      categories: [],
      grouped: false,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    // Should fall back to recentDesc instead of displaying raw "manual"
    expect(html).toContain("Sort order: Most recent reading first");
    expect(html).not.toContain("Sort order: manual");
  });

  it("filters by local day bounds using display timezone (Europe/Warsaw)", () => {
    // 2026-08-31T22:30:00.000Z in UTC is 2026-08-31, but in Europe/Warsaw (UTC+2) it is 2026-09-01 00:30.
    displayZone.current = "Europe/Warsaw";
    mockSearch = "from=2026-09-01";

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [
        {
          key: "bm:b1",
          count: 1,
          trend: [80],
          latest: mockReading({
            analyte: "Ferritin",
            takenAt: "2026-08-31T22:30:00.000Z",
          }),
        },
      ],
      categories: [],
      grouped: false,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const htmlWarsaw = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    // In Europe/Warsaw, the reading is on 2026-09-01, matching from=2026-09-01
    expect(htmlWarsaw).toContain("Ferritin");
    expect(htmlWarsaw).toContain("1 biomarker");

    // In America/New_York (UTC-4), the reading is 2026-08-31 18:30, excluded by from=2026-09-01
    displayZone.current = "America/New_York";
    const htmlNy = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(htmlNy).not.toContain("Ferritin");
    expect(htmlNy).toContain("No matching biomarkers");
  });

  it("ignores stale category from URL when not in loaded categories", () => {
    mockSearch = "category=stale_unknown_category";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const overview: LabOverviewResponse = {
      markers: [
        {
          key: "bm:b1",
          count: 1,
          trend: [80],
          latest: mockReading({ analyte: "Ferritin" }),
        },
      ],
      categories: [
        {
          key: "cat_iron",
          label: "Iron Panel",
          markerKeys: ["bm:b1"],
          counts: { inRange: 1, below: 0, above: 0, unknown: 0 },
          status: "in-range",
        },
      ],
      grouped: false,
    };
    queryClient.setQueryData(queryKeys.labResultsOverview("en"), overview);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <LabList />
        </I18nProvider>
      </QueryClientProvider>,
    );

    // Stale category is ignored: marker is not filtered out, category dropdown is inactive
    expect(html).toContain("Ferritin");
    expect(html).toContain('aria-label="Category" data-active="false"');
    expect(html).not.toContain("Reset");
    expect(html).not.toContain("stale_unknown_category");
  });
});
