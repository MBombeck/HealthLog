import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useState } from "react";

import { renderWithApp } from "../../../../tests/browser/render";
import { LabFilterRail, type LabFilterRailProps } from "../lab-filter-rail";
import { useLabListFilters } from "../use-lab-list-filters";

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
    // The page gutter the labs page gives the rail (its edge bleed relies on it).
    const { screen } = await renderWithApp(
      <div className="px-4">
        <LabFilterRail {...props()} />
      </div>,
    );

    const search = screen.getByRole("searchbox", { name: "Search biomarkers" });
    const dateRange = screen.getByRole("button", { name: "Last measured" });
    const searchRect = search.element().getBoundingClientRect();
    const dateRect = dateRange.element().getBoundingClientRect();

    expect(searchRect.width).toBeGreaterThan(340);
    expect(dateRect.top).toBeGreaterThan(searchRect.bottom);

    // The filter icon leads the pill row instead of sitting on a line of
    // its own between the search field and the pills.
    const icon = dateRange
      .element()
      .closest('[data-slot="filter-bar"]')
      ?.querySelector("svg.lucide-list-filter, svg.lucide-funnel");
    expect(icon).toBeTruthy();
    expect(Math.abs(centerY(icon!) - centerY(dateRange.element()))).toBeLessThan(
      2,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
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

/** The rail wired to the real filter hook, with a dialog to open over it. */
function WiredRail() {
  const lab = useLabListFilters();
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <LabFilterRail
        {...props()}
        filters={lab.filters}
        searchDraft={lab.searchDraft}
        onSearchChange={lab.setSearchDraft}
        searchInputRef={lab.searchInputRef}
      />
      <button type="button" onClick={() => setDialog(true)}>
        Open dialog
      </button>
      {dialog ? (
        <div role="dialog" aria-label="Sheet">
          <button type="button" autoFocus>
            Inside
          </button>
        </div>
      ) : null}
    </>
  );
}

describe("<LabFilterRail> keyboard", () => {
  it("focuses the search field on / and keeps focus there after clearing", async () => {
    const { screen } = await renderWithApp(<WiredRail />);
    const search = screen.getByRole("searchbox", { name: "Search biomarkers" });

    (
      screen.getByRole("button", { name: "Open dialog" }).element() as HTMLElement
    ).focus();
    await userEvent.keyboard("/");
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveValue("");

    await userEvent.keyboard("iron");
    await screen.getByRole("button", { name: "Clear search" }).click();
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
  });

  it("leaves / alone while focus is inside an open dialog", async () => {
    const { screen } = await renderWithApp(<WiredRail />);
    await screen.getByRole("button", { name: "Open dialog" }).click();
    const inside = screen.getByRole("button", { name: "Inside" });
    await expect.element(inside).toHaveFocus();
    await userEvent.keyboard("/");
    await expect.element(inside).toHaveFocus();
  });
});
