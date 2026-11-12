/**
 * Sheet history against Chromium's own session history: `back()` answers
 * with a real popstate a task or more later, and the entries keep their
 * state the way the browser keeps it.
 *
 * The router's half is played by hand where it matters: Next answers a URL
 * write one scheduler task later by rewriting the current entry with that
 * entry's own state copied in (`HistoryUpdater`), and that write can land
 * after a sheet's close has asked for Back but before Back arrives.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DAY_HISTORY_KEY } from "@/components/day/day-url";

import { renderWithApp } from "../../../../tests/browser/render";
import { ResponsiveSheet } from "../responsive-sheet";
import { sheetHistory } from "../sheet-history";

type Navigation = { currentEntry: { index: number } };
const index = () =>
  (window as unknown as { navigation: Navigation }).navigation.currentEntry
    .index;
const state = () => (window.history.state ?? {}) as Record<string, unknown>;
const MARK = "__healthlogSheet";

// Registered before the sheet history installs its own listener at the
// first open, so it hears every popstate, including the ones it swallows.
let popstates = 0;
window.addEventListener("popstate", () => (popstates += 1), true);

/** Wait for `count` more popstates, then until none follows. */
async function settle(count: number): Promise<void> {
  const target = popstates + count;
  await vi.waitFor(() => expect(popstates).toBeGreaterThanOrEqual(target), {
    timeout: 2_000,
  });
  for (;;) {
    const seen = popstates;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (popstates === seen) return;
  }
}

describe("sheet history in the browser", () => {
  it("leaves the page entry unmarked when the close also writes the URL", async () => {
    const sheets = sheetHistory()!;
    window.history.pushState(null, "", "?step=before");
    window.history.pushState(null, "", "?step=page");
    const page = index();

    // The day's date picker: its handler writes the day into the URL while
    // the sheet's entry is current, then the sheet closes.
    const picker = sheets.open(() => {});
    expect(index()).toBe(page + 1);
    window.history.replaceState(null, "", "?step=page&day=2026-11-10");
    picker.release();
    // The router's answer to that write, copying the entry it finds.
    window.history.replaceState(
      { ...state(), __NA: true },
      "",
      window.location.href,
    );
    await settle(1);

    expect(index()).toBe(page);
    expect(window.location.search).toBe("?step=page&day=2026-11-10");
    expect(state()[MARK]).toBeUndefined();

    // The next sheet closes onto the page, not onto the entry before it.
    const again = sheets.open(() => {});
    again.release();
    await settle(1);
    expect(index()).toBe(page);
    expect(window.location.search).toBe("?step=page&day=2026-11-10");
  });

  it("keeps the page entry's own state through a sheet", async () => {
    const sheets = sheetHistory()!;
    window.history.pushState(
      { [DAY_HISTORY_KEY]: "2026-11-10" },
      "",
      "?day=2026-11-10",
    );
    const page = index();

    // Closed by its own button.
    sheets.open(() => {}).release();
    await settle(1);
    expect(index()).toBe(page);
    expect(state()[DAY_HISTORY_KEY]).toBe("2026-11-10");

    // Closed by Back.
    const onBack = vi.fn();
    sheets.open(onBack);
    window.history.back();
    await settle(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(index()).toBe(page);
    expect(state()[DAY_HISTORY_KEY]).toBe("2026-11-10");
    expect(state()[MARK]).toBeUndefined();
  });

  it("answers Back during the discard question by keeping the sheet open", async () => {
    window.history.pushState(null, "", "?step=form");
    const page = index();
    function EditedSheet() {
      const [open, setOpen] = useState(true);
      return (
        <ResponsiveSheet
          open={open}
          onOpenChange={setOpen}
          title="Add a reading"
          dirty
        >
          <p>Typed but not saved</p>
        </ResponsiveSheet>
      );
    }
    const { screen } = await renderWithApp(<EditedSheet />);
    await expect.element(screen.getByText("Typed but not saved")).toBeVisible();
    await vi.waitFor(() => expect(index()).toBe(page + 1));

    // Back with unsaved input asks first and puts the sheet's entry back.
    window.history.back();
    await settle(1);
    await expect.element(screen.getByRole("alertdialog")).toBeVisible();
    expect(index()).toBe(page + 1);

    // Back again means "not now": the question goes, the sheet stays.
    window.history.back();
    await settle(1);
    await expect
      .element(screen.getByRole("alertdialog"))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("Typed but not saved")).toBeVisible();
    expect(index()).toBe(page + 1);
  });
});
