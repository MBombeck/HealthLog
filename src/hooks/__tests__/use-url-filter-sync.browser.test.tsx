/**
 * The URL-owned filter contract, driven the way a list page uses it: a
 * `FilterBar` of pills over `useUrlFilterSync`, in a real browser with a real
 * address bar. What these pin and the markup tests could not: a facet picked
 * from the open menu lands in the query as a new history entry, typed input
 * rewrites the current one, the per-pill clear and Reset leave a bare URL, two
 * writes in a row both land, and Back or an edited address re-seeds the pills.
 */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import {
  FilterBar,
  FilterBarDateRange,
  FilterBarSelect,
} from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";

import { renderWithApp } from "../../../tests/browser/render";
import {
  currentSearch,
  navigateExternally,
  recordHistory,
  setSearch,
} from "../../../tests/browser/url";
import { useUrlFilterSync } from "../use-url-filter-sync";

interface Filters {
  type?: string;
  source?: string;
  q?: string;
  from?: string;
  to?: string;
}

const KEYS = ["type", "source", "q", "from", "to"] as const;

function parse(params: URLSearchParams): Filters {
  const filters: Filters = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

function serialise(filters: Filters): string {
  const sp = new URLSearchParams();
  for (const key of KEYS) {
    const value = filters[key];
    if (value) sp.set(key, value);
  }
  return sp.toString();
}

const TYPES = [
  { value: "WEIGHT", label: "Weight" },
  { value: "PULSE", label: "Pulse" },
];
const SOURCES = [
  { value: "MANUAL", label: "Manual" },
  { value: "WITHINGS", label: "Withings" },
];

/** A list page's filter rail, as the measurements and mood lists build it. */
function FilterRail({ syncToUrl = true }: { syncToUrl?: boolean }) {
  const { filters, applyFilters, patchFilters } = useUrlFilterSync<Filters>({
    parse,
    serialise,
    syncToUrl,
  });
  const isFiltered = Object.keys(filters).length > 0;
  return (
    <>
      <Input
        aria-label="Search notes"
        value={filters.q ?? ""}
        onChange={(e) => patchFilters({ q: e.target.value }, "replace")}
      />
      <FilterBar
        isFiltered={isFiltered}
        onReset={() => applyFilters({})}
        count={`${Object.keys(filters).length} active`}
      >
        <FilterBarDateRange
          label="Date range"
          from={filters.from ?? ""}
          to={filters.to ?? ""}
          onFromChange={(from) => patchFilters({ from })}
          onToChange={(to) => patchFilters({ to })}
          idPrefix="probe"
        />
        <FilterBarSelect
          label="Type"
          value={filters.type ?? "ALL"}
          onValueChange={(v) =>
            patchFilters({ type: v === "ALL" ? undefined : v })
          }
          allLabel="All types"
          options={TYPES}
        />
        <FilterBarSelect
          label="Source"
          value={filters.source ?? "ALL"}
          onValueChange={(v) =>
            patchFilters({ source: v === "ALL" ? undefined : v })
          }
          allLabel="All sources"
          options={SOURCES}
        />
      </FilterBar>
    </>
  );
}

async function mount(search = "", props: { syncToUrl?: boolean } = {}) {
  setSearch(search);
  const history = recordHistory();
  const { screen } = await renderWithApp(<FilterRail {...props} />);
  const pill = (name: string | RegExp) =>
    screen.getByRole("combobox", { name });
  const reset = () => screen.getByRole("button", { name: "Reset" });
  const pick = async (pillName: string | RegExp, option: string) => {
    await pill(pillName).click();
    await screen.getByRole("option", { name: option }).click();
  };
  return { screen, history, pill, reset, pick };
}

/** The URL settles a task after the write; wait for the expected query. */
async function expectSearch(search: string) {
  await expect.poll(currentSearch).toBe(search);
}

describe("useUrlFilterSync with FilterBar", () => {
  it("seeds the pills from the address it mounts on", async () => {
    const { screen, pill, reset } = await mount("?type=WEIGHT&source=WITHINGS");
    await expect
      .element(pill("Type: Weight"))
      .toHaveAttribute("data-active", "true");
    await expect.element(pill("Source: Withings")).toBeInTheDocument();
    await expect.element(reset()).toBeVisible();
    await expect.element(screen.getByText("2 active")).toBeVisible();
  });

  it("shows no Reset and no clear button while unfiltered", async () => {
    const { screen, pill } = await mount();
    await expect.element(pill("Type")).toHaveAttribute("data-active", "false");
    await expect
      .element(screen.getByRole("button", { name: "Reset" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: /^Clear filter/ }))
      .not.toBeInTheDocument();
  });

  it("writes a facet picked from the open menu as a new history entry", async () => {
    const { pill, history, pick } = await mount();
    const entries = window.history.length;
    await pick("Type", "Pulse");
    await expectSearch("?type=PULSE");
    expect(history.pushes()).toEqual(["?type=PULSE"]);
    expect(history.replaces()).toEqual([]);
    expect(window.history.length).toBe(entries + 1);
    await expect.element(pill("Type: Pulse")).toBeInTheDocument();
  });

  it("opens the menu inside the viewport, under its pill", async () => {
    const { screen, pill } = await mount();
    // Read before opening: the open menu hides the rest of the page from
    // the accessibility tree, the pill included.
    const trigger = pill("Source").element().getBoundingClientRect();
    await pill("Source").click();
    const listbox = screen.getByRole("listbox");
    await expect.element(listbox).toBeVisible();
    // The menu slides in from above its resting place; measure where it rests.
    await Promise.all(document.getAnimations().map((a) => a.finished));
    const menu = listbox.element().getBoundingClientRect();
    expect(menu.top).toBeGreaterThanOrEqual(trigger.bottom - 1);
    expect(menu.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(menu.left).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{Escape}");
    await expect.element(listbox).not.toBeInTheDocument();
  });

  it("rewrites the current entry for typed input instead of stacking one per key", async () => {
    const { screen, history } = await mount("?type=WEIGHT");
    const entries = window.history.length;
    await screen.getByRole("textbox", { name: "Search notes" }).fill("knee");
    await expectSearch("?type=WEIGHT&q=knee");
    expect(history.pushes()).toEqual([]);
    expect(history.replaces().at(-1)).toBe("?type=WEIGHT&q=knee");
    expect(window.history.length).toBe(entries);
  });

  it("drops one facet with its clear button and keeps the others", async () => {
    const { screen, pill } = await mount("?type=WEIGHT&source=MANUAL");
    await screen.getByRole("button", { name: "Clear filter: Type" }).click();
    await expectSearch("?source=MANUAL");
    await expect.element(pill("Type")).toHaveAttribute("data-active", "false");
    await expect.element(pill("Source: Manual")).toBeInTheDocument();
  });

  it("clears both date bounds in one press, two writes in a row", async () => {
    const { screen } = await mount("?from=2026-05-12&to=2026-06-10&type=PULSE");
    const range = screen.getByRole("button", { name: /^Date range: / });
    await expect.element(range).toHaveTextContent("Date range: 05/12–06/10");
    await screen
      .getByRole("button", { name: "Clear filter: Date range" })
      .click();
    await expectSearch("?type=PULSE");
    await expect
      .element(screen.getByRole("button", { name: "Date range" }))
      .toHaveAttribute("data-active", "false");
  });

  it("resets every facet to a bare URL and hides Reset", async () => {
    const { reset, pill, history } = await mount("?type=WEIGHT&source=MANUAL");
    await reset().click();
    await expectSearch("");
    expect(history.pushes()).toEqual([""]);
    await expect.element(pill("Type")).toHaveAttribute("data-active", "false");
    await expect
      .element(pill("Source"))
      .toHaveAttribute("data-active", "false");
    await expect.element(reset()).not.toBeInTheDocument();
  });

  it("re-seeds from an address changed outside the component", async () => {
    const { pill, reset } = await mount("?type=WEIGHT");
    navigateExternally("?source=WITHINGS");
    await expect.element(pill("Source: Withings")).toBeInTheDocument();
    await expect.element(pill("Type")).toHaveAttribute("data-active", "false");
    navigateExternally("");
    await expect.element(reset()).not.toBeInTheDocument();
  });

  it("steps back through filter states with the browser's Back", async () => {
    const { pill, pick } = await mount("?type=WEIGHT");
    await pick("Type: Weight", "Pulse");
    await expectSearch("?type=PULSE");
    window.history.back();
    await expectSearch("?type=WEIGHT");
    await expect.element(pill("Type: Weight")).toBeInTheDocument();
  });

  it("keeps the state in memory and the address untouched with syncToUrl off", async () => {
    const { pill, pick, history } = await mount("?type=WEIGHT", {
      syncToUrl: false,
    });
    await expect.element(pill("Type")).toHaveAttribute("data-active", "false");
    await pick("Type", "Pulse");
    await expect.element(pill("Type: Pulse")).toBeInTheDocument();
    expect(currentSearch()).toBe("?type=WEIGHT");
    expect(history.writes).toEqual([]);
  });

  it("names Reset and the clear buttons in the reader's language", async () => {
    setSearch("?source=MANUAL");
    const { screen } = await renderWithApp(<FilterRail />, { locale: "de" });
    await expect
      .element(screen.getByRole("button", { name: "Zurücksetzen" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Filter entfernen: Source" }))
      .toBeInTheDocument();
  });
});
