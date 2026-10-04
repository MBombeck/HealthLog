import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { LabResultDto, LabResultListResponse } from "../types";

/**
 * Every row of the compact list is five grid cells from `lg` up. The range
 * badge renders nothing for a reading without a reference range, so without
 * its own cell the range bar and the trend slid one column to the left on
 * exactly those rows.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiDelete: vi.fn(),
}));

import { LabList } from "../lab-list";

function reading(over: Partial<LabResultDto>): LabResultDto {
  return {
    id: "r1",
    biomarkerId: "b1",
    panel: null,
    analyte: "Ferritin",
    value: 80,
    valueText: null,
    unit: "ng/mL",
    referenceLow: 30,
    referenceHigh: 400,
    catalogReferenceLow: 30,
    catalogReferenceHigh: 400,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    referenceOrigin: "catalog",
    referenceDivergesFromCatalog: false,
    takenAt: "2026-09-01T12:00:00.000Z",
    source: "MANUAL",
    hasNote: false,
    rangeStatus: "in_range",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...over,
  } as LabResultDto;
}

function renderList(results: LabResultDto[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const data: LabResultListResponse = {
    results,
    meta: { total: results.length, limit: 500, offset: 0 },
  };
  queryClient.setQueryData(
    queryKeys.labResultsList({
      biomarkerId: undefined,
      analyte: undefined,
      panel: undefined,
      from: undefined,
      to: undefined,
      page: 0,
      sortDir: "desc",
    }),
    data,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <LabList />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("<LabList> columns", () => {
  it("gives the badge its own cell even when a reading has no reference range", () => {
    const html = renderList([
      reading({ id: "a", biomarkerId: "b1", analyte: "Ferritin" }),
      reading({
        id: "b",
        biomarkerId: "b2",
        analyte: "Lipoprotein (a)",
        referenceLow: null,
        referenceHigh: null,
        catalogReferenceLow: null,
        catalogReferenceHigh: null,
        rangeStatus: "unknown",
      }),
    ]);
    expect(count(html, 'href="/labs/')).toBe(2);
    // One cell per row, rendered even where the badge itself renders nothing.
    expect(count(html, 'data-slot="lab-list-badge-cell"')).toBe(2);
    expect(html).toMatch(/<div data-slot="lab-list-badge-cell"[^>]*><\/div>/);
  });

  it("hides the chevron from lg up and keeps it on a phone", () => {
    const html = renderList([reading({})]);
    expect(html).toMatch(/class="[^"]*lucide-chevron-right[^"]*lg:invisible/);
  });

  describe("on a wide list", () => {
    const NARROW_TIER =
      "lg:@max-5xl:grid-cols-[minmax(0,1fr)_max-content_12rem_72px_auto]";
    const WIDE_TIER =
      "@5xl:grid-cols-[minmax(0,1fr)_max-content_minmax(12rem,18rem)_72px_auto]";

    it("makes the card a container, so the columns follow the list's width, not the window's", () => {
      const html = renderList([reading({})]);
      expect(html).toMatch(/<div[^>]*class="[^"]*@container[^"]*"/);
    });

    it("leaves the lg table as it was and adds a wider tier from @5xl, the two excluding each other", () => {
      const html = renderList([reading({})]);
      expect(html).toContain(NARROW_TIER);
      expect(html).toContain(WIDE_TIER);
      // Name, badge, bar, trend and chevron: five columns in both tiers.
      expect(NARROW_TIER.split("_")).toHaveLength(5);
      expect(WIDE_TIER.split("_")).toHaveLength(5);
    });

    it("keeps the trend column as wide as its 72px sparkline in both tiers", () => {
      expect(NARROW_TIER.split("_")[3]).toBe("72px");
      expect(WIDE_TIER.split("_")[3]).toBe("72px");
    });

    it("keeps the name column the flexible one in both tiers", () => {
      expect(NARROW_TIER).toContain("[minmax(0,1fr)_");
      expect(WIDE_TIER).toContain("[minmax(0,1fr)_");
    });

    it("lets the range bar fill its column from lg, and caps it on a phone", () => {
      const html = renderList([reading({})]);
      expect(html).toMatch(
        /data-slot="lab-reference-range-bar"[^>]*class="[^"]*max-w-48[^"]*lg:max-w-none/,
      );
      // The slot no longer pins the bar to 12rem itself.
      expect(html).not.toContain("lg:w-48");
    });

    it("wraps a long analyte name from lg up and truncates it on a phone", () => {
      const longName = "A".repeat(20) + " " + "B".repeat(100);
      const html = renderList([reading({ analyte: longName })]);
      expect(html).toContain(longName);
      const cls = html.match(
        /data-slot="lab-list-analyte"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-slot="lab-list-analyte"/,
      );
      const classes = (cls?.[1] ?? cls?.[2] ?? "").split(" ");
      expect(classes).toContain("truncate");
      for (const c of [
        "lg:overflow-visible",
        "lg:whitespace-normal",
        "lg:text-clip",
        "lg:[overflow-wrap:anywhere]",
      ]) {
        expect(classes).toContain(c);
      }
    });
  });
});
