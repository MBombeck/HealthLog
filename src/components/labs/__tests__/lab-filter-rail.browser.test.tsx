import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { renderWithApp } from "../../../../tests/browser/render";
import { LabFilterRail, type LabFilterRailProps } from "../lab-filter-rail";

function props(): LabFilterRailProps {
  return {
    filters: {},
    searchDraft: "",
    onSearchChange: vi.fn(),
    searchInputRef: { current: null },
    onStatusChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onFromDayChange: vi.fn(),
    onToDayChange: vi.fn(),
    onResetFilters: vi.fn(),
    isFiltered: false,
    categories: [
      {
        key: "cat_iron",
        label: "Iron Panel",
        markerKeys: ["bm:b1"],
        counts: { inRange: 1, below: 0, above: 0, unknown: 0 },
        status: "in-range",
      },
    ],
    total: 5,
  };
}

function centerY(element: Element): number {
  const rect = element.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

describe("<LabFilterRail> layout", () => {
  afterEach(async () => {
    await page.viewport(1280, 900);
  });

  it("keeps search full width and wraps filter controls on phones", async () => {
    await page.viewport(390, 844);
    const { screen } = await renderWithApp(<LabFilterRail {...props()} />);

    const search = screen.getByRole("searchbox", { name: "Search biomarkers" });
    const dateRange = screen.getByRole("button", { name: "Last measured" });
    const searchRect = search.element().getBoundingClientRect();
    const dateRect = dateRange.element().getBoundingClientRect();

    expect(searchRect.width).toBeGreaterThan(300);
    expect(dateRect.top).toBeGreaterThan(searchRect.bottom);
  });

  it("wraps controls cleanly without horizontal overflow at intermediate widths", async () => {
    await page.viewport(1024, 768);
    const { screen } = await renderWithApp(
      <LabFilterRail
        {...props()}
        isFiltered={true}
        filters={{ status: "abnormal" }}
      />,
    );

    const rail = screen
      .getByRole("searchbox", { name: "Search biomarkers" })
      .element()
      .closest('[data-slot="lab-filter-rail"]');
    expect(rail).not.toBeNull();
    const railRect = rail!.getBoundingClientRect();

    const search = screen.getByRole("searchbox", { name: "Search biomarkers" });
    const searchRect = search.element().getBoundingClientRect();
    expect(searchRect.width).toBeLessThan(300);

    const controls = [
      search.element(),
      screen.getByRole("button", { name: "Last measured" }).element(),
      screen.getByRole("combobox", { name: "Status: Out of range" }).element(),
      screen.getByRole("combobox", { name: "Category" }).element(),
      screen.getByRole("button", { name: "Reset" }).element(),
    ];

    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(railRect.left - 1);
      expect(rect.right).toBeLessThanOrEqual(railRect.right + 1);
    }
  });

  it("keeps every control and reset visible without clipping in German at 1536px", async () => {
    await page.viewport(1536, 900);
    const { screen } = await renderWithApp(
      <LabFilterRail
        {...props()}
        isFiltered={true}
        filters={{ status: "abnormal" }}
      />,
      { locale: "de" },
    );

    const rail = screen
      .getByRole("searchbox", { name: "Biomarker suchen" })
      .element()
      .closest('[data-slot="lab-filter-rail"]');
    expect(rail).not.toBeNull();
    const railRect = rail!.getBoundingClientRect();

    const controls = [
      screen.getByRole("searchbox", { name: "Biomarker suchen" }).element(),
      screen.getByRole("button", { name: "Zuletzt gemessen" }).element(),
      screen
        .getByRole("combobox", {
          name: "Status: Außerhalb des Bereichs",
        })
        .element(),
      screen.getByRole("combobox", { name: "Kategorie" }).element(),
      screen.getByRole("button", { name: "Zurücksetzen" }).element(),
    ];

    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(railRect.left - 1);
      expect(rect.right).toBeLessThanOrEqual(railRect.right + 1);
    }
  });

  it("aligns search and filter controls in one row on wide screens", async () => {
    await page.viewport(2560, 900);
    const { screen } = await renderWithApp(<LabFilterRail {...props()} />);
    const controls = [
      screen.getByRole("searchbox", { name: "Search biomarkers" }).element(),
      screen.getByRole("button", { name: "Last measured" }).element(),
      screen.getByRole("combobox", { name: "Status" }).element(),
      screen.getByRole("combobox", { name: "Category" }).element(),
    ];
    const centers = controls.map(centerY);

    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
  });
});
