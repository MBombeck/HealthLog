import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { renderWithApp } from "../../../../tests/browser/render";
import { SettingsCardActions } from "../_card-actions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";

/**
 * The action row sizes its buttons in a browser, whatever the buttons
 * themselves say. The class strings alone could not tell that a button
 * behind a dialog trigger carries the trigger's `data-slot` and so slipped
 * past a selector written for `data-slot="button"`: the confirm buttons of
 * a row stood 8 px shorter than the save button beside them.
 */
describe("<SettingsCardActions> in a browser", () => {
  async function heights(width: number) {
    await page.viewport(width, 800);
    const { screen } = await renderWithApp(
      <div style={{ width: "100%" }}>
        <SettingsCardActions data-testid="row">
          <ConfirmButton
            size="sm"
            label="Turn off"
            title="Turn off?"
            body="The link stops working."
            confirmLabel="Turn off"
            onConfirm={() => {}}
          />
          <Button variant="outline" size="sm">
            Rotate link
          </Button>
          {/* What a call site used to write: taller, and full width. */}
          {/* eslint-disable-next-line healthlog/card-action-row -- the shape the row has to overrule */}
          <Button className="w-full sm:w-auto">Save</Button>
        </SettingsCardActions>
      </div>,
    );
    const row = screen.getByTestId("row").element() as HTMLElement;
    const buttons = [...row.querySelectorAll("button")];
    return {
      row: row.getBoundingClientRect().width,
      buttons: buttons.map((b) => b.getBoundingClientRect()),
    };
  }

  it("gives every button the same height, a dialog trigger included", async () => {
    // A mouse on a wide window: 36 px.
    const wide = await heights(1280);
    expect(wide.buttons).toHaveLength(3);
    expect(wide.buttons.map((b) => Math.round(b.height))).toEqual([36, 36, 36]);
  });

  it("keeps 44 px on a phone-wide window and never stretches a button", async () => {
    const narrow = await heights(390);
    expect(narrow.buttons.map((b) => Math.round(b.height))).toEqual([
      44, 44, 44,
    ]);
    for (const button of narrow.buttons) {
      expect(button.width).toBeLessThan(narrow.row / 2);
    }
  });
});
