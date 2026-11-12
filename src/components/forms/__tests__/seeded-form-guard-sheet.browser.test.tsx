/**
 * A form that guards Back (`useSeededFormDismissal({ guardNavigation })`)
 * and a sheet opened over it both listen for popstate in the capture phase,
 * so the one registered first hears Back first. Here the guard is: the page
 * mounts the form, and the sheet history installs at the first sheet open,
 * which is the order on `/settings/account` when "All sections" is the first
 * sheet of the visit. A Back that closes the sheet is the sheet's, and the
 * form must not answer it with its discard question.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { sheetHistory } from "@/components/ui/sheet-history";

import { useSeededFormDismissal } from "../use-seeded-form-dismissal";

type Navigation = { currentEntry: { index: number } };
const index = () =>
  (window as unknown as { navigation: Navigation }).navigation.currentEntry
    .index;

let popstates = 0;
window.addEventListener("popstate", () => (popstates += 1), true);

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

function EditedForm() {
  const { discardDialogOpen } = useSeededFormDismissal({
    seed: "Ada",
    value: "Ada L.",
    guardNavigation: true,
    navigate: () => {},
  });
  return <p data-testid="asking">{discardDialogOpen ? "asking" : "quiet"}</p>;
}

describe("a guarded form under a sheet", () => {
  // One case: the listener order is set once per page, by the first open.
  it("leaves the sheet's Back to the sheet and guards the page's", async () => {
    window.history.pushState(null, "", "?section=account");
    const page = index();
    const screen = await render(<EditedForm />);
    const asking = screen.getByTestId("asking");

    // Back closes the sheet.
    const onBack = vi.fn();
    sheetHistory()!.open(onBack);
    expect(index()).toBe(page + 1);
    window.history.back();
    await settle(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(index()).toBe(page);
    await expect.element(asking).toHaveTextContent("quiet");

    // The sheet's own close takes its entry off.
    sheetHistory()!
      .open(() => {})
      .release();
    await settle(1);
    expect(index()).toBe(page);
    await expect.element(asking).toHaveTextContent("quiet");

    // With no sheet open, Back is the form's.
    window.history.back();
    await settle(1);
    await expect.element(asking).toHaveTextContent("asking");
  });
});
