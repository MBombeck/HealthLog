import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationFilterRail } from "@/components/medications/medication-filter-rail";

const CATEGORY_OPTIONS = [{ value: "PAIN", label: "Pain" }];

function renderRail(
  overrides: Partial<Parameters<typeof MedicationFilterRail>[0]> = {},
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MedicationFilterRail
        searchText=""
        onSearchChange={vi.fn()}
        searchInputRef={{ current: null }}
        category="ALL"
        onCategoryChange={vi.fn()}
        categoryOptions={CATEGORY_OPTIONS}
        fromDay=""
        toDay=""
        onFromDayChange={vi.fn()}
        onToDayChange={vi.fn()}
        onResetFilters={vi.fn()}
        isFiltered={false}
        total={3}
        {...overrides}
      />
    </I18nProvider>,
  );
}

describe("<MedicationFilterRail>", () => {
  it("shows the match count and no reset while nothing is filtered", () => {
    const html = renderRail();
    expect(html).toContain('data-slot="medication-filter-rail"');
    expect(html).toContain("3 medications");
    expect(html).not.toContain("Reset");
  });

  it("offers reset once a filter is active", () => {
    expect(renderRail({ isFiltered: true })).toContain("Reset");
  });

  it("hides the category select and its manage entry when the list has no categories of its own", () => {
    const html = renderRail({
      showCategoryFilter: false,
      canManageCategories: true,
      onOpenManageCategories: vi.fn(),
    });
    expect(html).not.toContain('aria-label="Category"');
    expect(html).not.toContain('data-slot="medication-categories-manage"');
  });

  it("shows the manage entry only with a manage handler and permission", () => {
    const html = renderRail({
      canManageCategories: true,
      onOpenManageCategories: vi.fn(),
    });
    expect(html).toContain('aria-label="Category"');
    expect(html).toContain('data-slot="medication-categories-manage"');
  });

  it("flags a reversed treatment period with an alert", () => {
    const reversed = renderRail({ fromDay: "2026-05-10", toDay: "2026-05-01" });
    expect(reversed).toContain('data-slot="medication-filter-date-error"');
    expect(reversed).toContain('role="alert"');
  });

  it("raises no alert for an ordered or half-open treatment period", () => {
    expect(
      renderRail({ fromDay: "2026-05-01", toDay: "2026-05-10" }),
    ).not.toContain('data-slot="medication-filter-date-error"');
    expect(renderRail({ fromDay: "2026-05-10", toDay: "" })).not.toContain(
      'data-slot="medication-filter-date-error"',
    );
  });
});
