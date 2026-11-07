import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  resolveModuleListLayout,
  type ModuleListPrefs,
} from "@/lib/settings/module-list-layout";
import type {
  LabOverviewCategoryDto,
  LabOverviewResponse,
  LabResultDto,
} from "../types";

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

function renderList(
  results: LabResultDto[],
  options: {
    prefs?: Partial<ModuleListPrefs>;
    categories?: LabOverviewCategoryDto[];
    grouped?: boolean;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // The overview the server would send for these readings: one marker per
  // biomarker (or lower-cased analyte), newest reading as `latest`.
  const byKey = new Map<string, LabResultDto[]>();
  for (const r of results) {
    const key = r.biomarkerId
      ? `bm:${r.biomarkerId}`
      : `analyte:${r.analyte.toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const data: LabOverviewResponse = {
    markers: [...byKey.entries()].map(([key, readings]) => {
      const ordered = [...readings].sort(
        (a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt),
      );
      return {
        key,
        count: ordered.length,
        trend: ordered.map((r) => r.value),
        latest: ordered[ordered.length - 1],
      };
    }),
    categories: options.categories ?? [],
    grouped: options.grouped ?? false,
  };
  queryClient.setQueryData(queryKeys.labResultsOverview("en"), data);
  if (options.prefs) {
    queryClient.setQueryData(
      queryKeys.moduleListLayout(),
      resolveModuleListLayout({ version: 1, labs: options.prefs }),
    );
  }
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
        "lg:break-words",
        "lg:hyphens-auto",
      ]) {
        expect(classes).toContain(c);
      }
      // `anywhere` breaks inside a word that would have fit on the next line.
      expect(classes).not.toContain("lg:[overflow-wrap:anywhere]");
      expect(classes).not.toContain("lg:break-all");
    });
  });

  it("notes where a converted reading came from, and only for that reading", () => {
    const html = renderList([
      reading({
        id: "c",
        biomarkerId: "b1",
        analyte: "Glucose",
        unit: "mg/dL",
        converted: true,
        sourceValue: 5.6,
        sourceUnit: "mmol/L",
      }),
      reading({ id: "d", biomarkerId: "b2", analyte: "Ferritin" }),
    ]);
    expect(count(html, 'data-slot="lab-converted-note"')).toBe(1);
    expect(html).toContain("converted from 5.6 mmol/L");
  });
});

describe("<LabList> categories", () => {
  const readings = [
    reading({ id: "l1", biomarkerId: "b1", analyte: "LDL", panel: "Lipids" }),
    reading({
      id: "l2",
      biomarkerId: "b2",
      analyte: "HDL",
      panel: "Lipids",
      rangeStatus: "above",
    }),
    reading({ id: "t1", biomarkerId: "b3", analyte: "TSH", panel: "Thyroid" }),
  ];
  const categories: LabOverviewCategoryDto[] = [
    {
      key: "lipids",
      label: "Lipids",
      markerKeys: ["bm:b1", "bm:b2"],
      counts: { inRange: 1, below: 0, above: 1, unknown: 0 },
      status: "above",
    },
    {
      key: "thyroid",
      label: "Thyroid",
      markerKeys: ["bm:b3"],
      counts: { inRange: 1, below: 0, above: 0, unknown: 0 },
      status: "in-range",
    },
  ];
  const headers = (html: string) =>
    [...html.matchAll(/<button[^>]*data-slot="lab-list-group"[^>]*>/g)].map(
      (m) => m[0],
    );

  it("stays flat while grouping is off, or while the server says it adds nothing", () => {
    expect(
      headers(renderList(readings, { categories, grouped: true })),
    ).toHaveLength(0);
    expect(
      headers(
        renderList(readings, {
          categories,
          grouped: false,
          prefs: { groupBy: "category" },
        }),
      ),
    ).toHaveLength(0);
  });

  it("renders one disclosure per category, open by default, with the status in its name", () => {
    const html = renderList(readings, {
      categories,
      grouped: true,
      prefs: { groupBy: "category" },
    });
    const found = headers(html);
    expect(found).toHaveLength(2);
    for (const button of found) {
      expect(button).toContain('aria-expanded="true"');
      expect(button).toMatch(/aria-controls="[^"]+"/);
    }
    expect(html).toContain("1 of 2 outside range");
    expect(html).toContain("All in range");
    expect(count(html, 'href="/labs/')).toBe(3);
    // Server order: lipids first.
    expect(html.indexOf("Lipids")).toBeLessThan(html.indexOf("Thyroid"));
    // The header spans the table's columns, the rows keep the subgrid.
    expect(html).toContain("lg:col-span-full");
    expect(html).toContain("lg:grid-cols-subgrid");
  });

  it("opens only flagged categories, or none, as the person chose", () => {
    const flagged = renderList(readings, {
      categories,
      grouped: true,
      prefs: { groupBy: "category", groupsOpen: "flagged" },
    });
    const [lipids, thyroid] = headers(flagged);
    expect(lipids).toContain('aria-expanded="true"');
    expect(thyroid).toContain('aria-expanded="false"');
    expect(count(flagged, 'href="/labs/')).toBe(2);

    const collapsed = renderList(readings, {
      categories,
      grouped: true,
      prefs: { groupBy: "category", groupsOpen: "collapsed" },
    });
    expect(
      headers(collapsed).every((h) => h.includes('aria-expanded="false"')),
    ).toBe(true);
    expect(count(collapsed, 'href="/labs/')).toBe(0);
  });

  it("names the unit instead of the panel on a card under its category", () => {
    const grouped = renderList(readings, {
      categories,
      grouped: true,
      prefs: { groupBy: "category", view: "cards" },
    });
    expect(headers(grouped)).toHaveLength(2);
    // Each panel label appears once, in its header, not again on the cards.
    expect(count(grouped, ">Lipids<")).toBe(1);

    const flat = renderList(readings, { prefs: { view: "cards" } });
    expect(count(flat, ">Lipids<")).toBe(2);
  });
});
