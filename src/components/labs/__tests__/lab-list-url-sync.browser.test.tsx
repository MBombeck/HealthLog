import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "@/lib/query-keys";
import { renderWithApp, testQueryClient } from "../../../../tests/browser/render";
import {
  currentSearch,
  recordHistory,
  setSearch,
} from "../../../../tests/browser/url";
import { LabList } from "../lab-list";
import type { LabOverviewResponse, LabResultDto } from "../types";
import { useLabListFilters } from "../use-lab-list-filters";

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

const overviewWithCategories: LabOverviewResponse = {
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
  grouped: true,
};

const overviewWithAbnormalMarker: LabOverviewResponse = {
  markers: [
    {
      key: "bm:b1",
      count: 1,
      trend: [10],
      latest: mockReading({ analyte: "Iron", rangeStatus: "below" }),
    },
    {
      key: "bm:b2",
      count: 1,
      trend: [80],
      latest: mockReading({ analyte: "Ferritin", rangeStatus: "in-range" }),
    },
  ],
  categories: [
    {
      key: "cat_iron",
      label: "Iron Panel",
      markerKeys: ["bm:b1", "bm:b2"],
      counts: { inRange: 1, below: 1, above: 0, unknown: 0 },
      status: "below",
    },
  ],
  grouped: true,
};

function labQueryClient(): QueryClient {
  const client = testQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity },
  });
  return client;
}

function FilterCallbackStabilityProbe({
  onRender,
}: {
  onRender: (cb: unknown) => void;
}) {
  const [, setTick] = useState(0);
  const { setCategoryFilter } = useLabListFilters();
  useEffect(() => {
    onRender(setCategoryFilter);
  });
  return (
    <button type="button" onClick={() => setTick((n) => n + 1)}>
      Rerender
    </button>
  );
}

describe("LabList stale category and group header handling", () => {
  it("normalizes URL via replace after paint and does not filter visible rows when category is stale", async () => {
    setSearch("?category=stale");
    const history = recordHistory();

    const queryClient = labQueryClient();
    queryClient.setQueryData(
      queryKeys.labResultsOverview("en"),
      overviewWithCategories,
    );

    const { screen } = await renderWithApp(<LabList />, { queryClient });

    // Stale category is scrubbed from URL after paint using replace (no pushes)
    await expect.poll(currentSearch).toBe("");
    expect(history.pushes()).toEqual([]);
    expect(history.replaces()).toEqual([""]);

    // Visible filtering ignores stale category: marker is visible, category pill is inactive
    await expect.element(screen.getByText("Ferritin")).toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "Category" }))
      .toHaveAttribute("data-active", "false");
  });

  it("preserves active non-stale filters and scrubs stale category from URL after paint", async () => {
    setSearch("?status=abnormal&category=stale");
    const history = recordHistory();

    const queryClient = labQueryClient();
    queryClient.setQueryData(
      queryKeys.labResultsOverview("en"),
      overviewWithCategories,
    );

    await renderWithApp(<LabList />, { queryClient });

    await expect.poll(currentSearch).toBe("?status=abnormal");
    expect(history.pushes()).toEqual([]);
    expect(history.replaces()).toEqual(["?status=abnormal"]);
  });

  it("preserves valid category in URL without triggering replace", async () => {
    setSearch("?category=cat_iron");
    const history = recordHistory();

    const queryClient = labQueryClient();
    queryClient.setQueryData(
      queryKeys.labResultsOverview("en"),
      overviewWithCategories,
    );

    const { screen } = await renderWithApp(<LabList />, { queryClient });

    await expect.poll(currentSearch).toBe("?category=cat_iron");
    expect(history.pushes()).toEqual([]);
    expect(history.replaces()).toEqual([]);
    await expect.element(screen.getByText("Ferritin")).toBeVisible();
  });

  it("reflects filtered row count and outside status in category group header DOM", async () => {
    setSearch("?status=below");
    const queryClient = labQueryClient();
    queryClient.setQueryData(queryKeys.moduleListLayout(), {
      version: 1,
      lists: {
        labs: {
          view: "list",
          order: [],
          sortDir: "recentDesc",
          groupBy: "category",
          groupsOpen: "expanded",
          categoryOrder: [],
        },
      },
    });
    queryClient.setQueryData(
      queryKeys.labResultsOverview("en"),
      overviewWithAbnormalMarker,
    );

    const { screen } = await renderWithApp(<LabList />, { queryClient });

    // Only the 'below' marker (Iron) is visible
    await expect.element(screen.getByText("Iron")).toBeVisible();
    await expect.element(screen.getByText("Ferritin")).not.toBeInTheDocument();

    // Group header button shows the filtered count ("1 of 1 outside range") and chip "1"
    const groupButton = screen.getByRole("button", { name: /Iron Panel/i });
    await expect.element(groupButton).toBeVisible();
    await expect.element(groupButton.getByText("1 of 1 outside range")).toBeVisible();
    await expect.element(groupButton.getByText("1")).toBeVisible();
  });

  it("keeps flagged-mode default-open behavior consistent with visible filtered rows", async () => {
    // overviewWithAbnormalMarker has 2 markers in Iron Panel:
    // Iron (below) and Ferritin (in-range). Category server status is "below".
    // When filtered to ?status=in-range, Iron is excluded and only Ferritin (in-range) remains.
    // In flagged mode, the group should NOT be open by default because visible rows are all in-range.
    setSearch("?status=in-range");
    const queryClient = labQueryClient();
    queryClient.setQueryData(queryKeys.moduleListLayout(), {
      version: 1,
      lists: {
        labs: {
          view: "list",
          order: [],
          sortDir: "recentDesc",
          groupBy: "category",
          groupsOpen: "flagged",
          categoryOrder: [],
        },
      },
    });
    queryClient.setQueryData(
      queryKeys.labResultsOverview("en"),
      overviewWithAbnormalMarker,
    );

    const { screen } = await renderWithApp(<LabList />, { queryClient });

    // Group button reflects in-range status ("All in range") and is collapsed (aria-expanded="false")
    const groupButton = screen.getByRole("button", { name: /Iron Panel/i });
    await expect.element(groupButton).toBeVisible();
    await expect.element(groupButton.getByText("All in range")).toBeVisible();
    await expect.element(groupButton).toHaveAttribute("aria-expanded", "false");
  });

  it("memoizes setCategoryFilter callback identity across re-renders", async () => {
    const callbacks: unknown[] = [];
    const { screen } = await renderWithApp(
      <FilterCallbackStabilityProbe onRender={(cb) => callbacks.push(cb)} />,
    );
    await screen.getByRole("button", { name: "Rerender" }).click();
    expect(callbacks.length).toBeGreaterThanOrEqual(2);
    expect(callbacks[0]).toBe(callbacks[1]);
  });
});
