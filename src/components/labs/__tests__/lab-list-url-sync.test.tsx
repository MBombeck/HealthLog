/**
 * URL-owned filter state on the labs overview list (the documents-vault and
 * measurements pattern via `useUrlFilterSync`):
 *
 *   - a filter or sort change writes the serialised facet set to the page URL
 *     (push for discrete selects, replace for date bounds, bare pathname when
 *     everything clears);
 *   - mounting with a query string restores every facet into the filter rail;
 *   - sort selection overrides the list presentation without altering persisted
 *     user settings, does not mark `isFiltered` true, and reset restores the
 *     preference default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  installUrlStateBrowser,
  type UrlStateBrowser,
} from "@/__tests__/helpers/url-state-browser";
import type { ModuleListPrefs } from "@/lib/module-list-prefs";
import type { LabFilterRailProps } from "../lab-filter-rail";
import type { LabOverviewResponse, LabResultDto } from "../types";
import { LabList } from "../lab-list";

let mockSearch = "";
const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/labs",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

let capturedRailProps: LabFilterRailProps | null = null;
vi.mock("../lab-filter-rail", () => ({
  LabFilterRail: (props: LabFilterRailProps) => {
    capturedRailProps = props;
    return <div data-slot="lab-filter-rail" />;
  },
}));

const mockModulePrefs: ModuleListPrefs = {
  view: "list",
  order: [],
  sortDir: "recentDesc",
  groupBy: "none",
  groupsOpen: "expanded",
  categoryOrder: [],
};

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

const baseOverview: LabOverviewResponse = {
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

let browser: UrlStateBrowser = installUrlStateBrowser("/");
afterEach(() => browser.uninstall());

function render(search: string) {
  mockSearch = search;
  capturedRailProps = null;
  browser.uninstall();
  browser = installUrlStateBrowser(search ? `/labs?${search}` : "/labs");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.labResultsOverview("en"), baseOverview);

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <LabList />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return html;
}

beforeEach(() => {
  pushMock.mockClear();
  replaceMock.mockClear();
  mockModulePrefs.sortDir = "recentDesc";
  mockModulePrefs.order = [];
});

describe("LabList URL filter sync — interactions write to URL", () => {
  it("pushes the status facet", () => {
    render("");
    expect(capturedRailProps).not.toBeNull();
    capturedRailProps!.onStatusChange("abnormal");
    expect(browser.push).toHaveBeenCalledWith("/labs?status=abnormal");
  });

  it("pushes the category facet on top of active status", () => {
    render("status=abnormal");
    capturedRailProps!.onCategoryChange("cat_iron");
    expect(browser.push).toHaveBeenCalledWith(
      "/labs?status=abnormal&category=cat_iron",
    );
  });

  it("replaces (no new history entry) for date bounds", () => {
    render("");
    capturedRailProps!.onFromDayChange("2026-09-01");
    expect(browser.replace).toHaveBeenCalledWith("/labs?from=2026-09-01");
    expect(browser.push).not.toHaveBeenCalled();
  });

  it("leaves a sort param out of the filter state", () => {
    render("sort=alphaAsc");
    expect(capturedRailProps!.isFiltered).toBe(false);
    capturedRailProps!.onStatusChange("abnormal");
    expect(browser.push).toHaveBeenCalledWith("/labs?status=abnormal");
  });

  it("reset clears every facet in one push", () => {
    render("status=abnormal&category=cat_iron&from=2026-09-01");
    expect(capturedRailProps!.isFiltered).toBe(true);
    capturedRailProps!.onResetFilters();
    expect(browser.push).toHaveBeenCalledWith("/labs");
  });
});

describe("LabList URL filter sync — mounting restores filters from query", () => {
  it("restores every facet into the rail controls", () => {
    render(
      "q=ferritin&status=in-range&category=cat_iron&from=2026-09-01&to=2026-09-30",
    );
    expect(capturedRailProps!.filters.q).toBe("ferritin");
    expect(capturedRailProps!.filters.status).toBe("in-range");
    expect(capturedRailProps!.filters.category).toBe("cat_iron");
    expect(capturedRailProps!.filters.fromDay).toBe("2026-09-01");
    expect(capturedRailProps!.filters.toDay).toBe("2026-09-30");
    expect(capturedRailProps!.isFiltered).toBe(true);
  });

  it("drops invalid status and invalid dates without breaking the page", () => {
    render("status=INVALID&from=2026-02-30&to=not-a-date");
    expect(capturedRailProps!.filters.status).toBeUndefined();
    expect(capturedRailProps!.filters.fromDay).toBeUndefined();
    expect(capturedRailProps!.filters.toDay).toBeUndefined();
    expect(capturedRailProps!.isFiltered).toBe(false);
  });

  it("drops stale category from effective filters when mounting with unknown category", () => {
    render("category=unknown_stale_cat");
    expect(capturedRailProps!.filters.category).toBeUndefined();
    expect(capturedRailProps!.isFiltered).toBe(false);
  });

  it("replaces URL without pushing history when clearing category with replace mode (no Back-button loop)", () => {
    render("category=unknown_stale_cat");
    (
      capturedRailProps!.onCategoryChange as (
        val: string,
        mode?: "push" | "replace",
      ) => void
    )("ALL", "replace");
    expect(browser.replace).toHaveBeenCalledWith("/labs");
    expect(browser.push).not.toHaveBeenCalled();
  });
});
