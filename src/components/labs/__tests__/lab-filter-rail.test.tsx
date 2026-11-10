import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { primeLocales } from "@/__tests__/helpers/prime-locales";
import { I18nProvider } from "@/lib/i18n/context";
import { LabFilterRail } from "../lab-filter-rail";

primeLocales("en", "pl", "ru");

describe("<LabFilterRail>", () => {
  it("renders search input, shortcut hint, and filter pills in canonical order", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <LabFilterRail
          filters={{}}
          searchDraft=""
          onSearchChange={vi.fn()}
          searchInputRef={{ current: null }}
          onStatusChange={vi.fn()}
          onCategoryChange={vi.fn()}
          onFromDayChange={vi.fn()}
          onToDayChange={vi.fn()}
          onResetFilters={vi.fn()}
          isFiltered={false}
          categories={[
            {
              key: "cat_iron",
              label: "Iron Panel",
              markerKeys: ["bm:b1"],
              counts: { inRange: 1, below: 0, above: 0, unknown: 0 },
              status: "in-range",
            },
          ]}
          total={5}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="lab-filter-rail"');
    expect(html).toContain('placeholder="Search biomarkers..."');
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*>\s*\/\s*<\/kbd>/);

    // The shared rail keeps search and all filter dimensions in one ordered row.
    const searchIdx = html.indexOf('placeholder="Search biomarkers..."');
    const dateRangeIdx = html.indexOf("Last measured");
    const statusIdx = html.indexOf("Status");
    const categoryIdx = html.indexOf("Category");

    expect(searchIdx).toBeGreaterThan(-1);
    expect(dateRangeIdx).toBeGreaterThan(searchIdx);
    expect(statusIdx).toBeGreaterThan(dateRangeIdx);
    expect(categoryIdx).toBeGreaterThan(statusIdx);
    // The saved sort in Settings > Labs is the only sort; the rail has none.
    expect(html).not.toContain("Sort order");
    expect(html).toContain("5 biomarkers");
  });

  it("shows search clear button with accessible label and hides kbd shortcut when search has text", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <LabFilterRail
          filters={{ q: "ferritin" }}
          searchDraft="ferritin"
          onSearchChange={vi.fn()}
          searchInputRef={{ current: null }}
          onStatusChange={vi.fn()}
          onCategoryChange={vi.fn()}
          onFromDayChange={vi.fn()}
          onToDayChange={vi.fn()}
          onResetFilters={vi.fn()}
          isFiltered={true}
          total={1}
        />
      </I18nProvider>,
    );

    expect(html).toContain('aria-label="Clear search"');
    expect(html).not.toContain('<kbd');
  });

  it("pluralizes marker count with tCount across locales", () => {
    const extractCountText = (html: string) => {
      const match = html.match(
        /<span[^>]*data-slot="filter-bar-count"[^>]*>([^<]+)<\/span>/,
      );
      return match ? match[1].trim() : null;
    };

    const renderCount = (locale: "en" | "pl" | "ru", total: number) =>
      renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <LabFilterRail
            filters={{}}
            searchDraft=""
            onSearchChange={vi.fn()}
            searchInputRef={{ current: null }}
            onStatusChange={vi.fn()}
            onCategoryChange={vi.fn()}
            onFromDayChange={vi.fn()}
            onToDayChange={vi.fn()}
              onResetFilters={vi.fn()}
            isFiltered={false}
            total={total}
          />
        </I18nProvider>,
      );

    expect(extractCountText(renderCount("en", 1))).toBe("1 biomarker");
    expect(extractCountText(renderCount("en", 2))).toBe("2 biomarkers");
    expect(extractCountText(renderCount("pl", 1))).toBe("1 biomarker");
    expect(extractCountText(renderCount("pl", 2))).toBe("2 biomarkery");
    expect(extractCountText(renderCount("pl", 5))).toBe("5 biomarkerów");
    expect(extractCountText(renderCount("ru", 1))).toBe("1 биомаркер");
    expect(extractCountText(renderCount("ru", 2))).toBe("2 биомаркера");
    expect(extractCountText(renderCount("ru", 5))).toBe("5 биомаркеров");
  });

  it("shows reset button when isFiltered is true", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <LabFilterRail
          filters={{ status: "abnormal" }}
          searchDraft=""
          onSearchChange={vi.fn()}
          searchInputRef={{ current: null }}
          onStatusChange={vi.fn()}
          onCategoryChange={vi.fn()}
          onFromDayChange={vi.fn()}
          onToDayChange={vi.fn()}
          onResetFilters={vi.fn()}
          isFiltered={true}
          total={2}
        />
      </I18nProvider>,
    );

    expect(html).toContain("Reset");
  });
});
