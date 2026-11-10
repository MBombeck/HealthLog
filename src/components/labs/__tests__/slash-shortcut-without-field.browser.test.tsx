import { describe, expect, it } from "vitest";

import { renderWithApp } from "../../../../tests/browser/render";
import { useVaultFilters } from "../../documents/vault/use-vault-filters";
import { useLabListFilters } from "../use-lab-list-filters";

/**
 * "/" focuses a list's search field. While the page has none on screen (still
 * loading, an error, nothing recorded yet) the key must stay the browser's,
 * such as Firefox's quick find, and not be swallowed for a field that is not
 * there.
 */

function LabsWithoutRail() {
  useLabListFilters();
  return (
    <button type="button" autoFocus>
      Elsewhere
    </button>
  );
}

function VaultWithoutSearch() {
  useVaultFilters();
  return (
    <button type="button" autoFocus>
      Elsewhere
    </button>
  );
}

function pressSlash(target: Element): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "/",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('"/" with no search field on screen', () => {
  it.each([
    ["labs", LabsWithoutRail],
    ["documents", VaultWithoutSearch],
  ])("leaves the key alone on %s", async (_name, View) => {
    const { screen } = await renderWithApp(<View />);
    const button = screen.getByRole("button", { name: "Elsewhere" }).element();
    expect(pressSlash(button)).toBe(false);
  });
});
