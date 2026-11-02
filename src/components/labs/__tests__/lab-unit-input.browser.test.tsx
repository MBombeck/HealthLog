import { useState } from "react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { renderWithApp } from "../../../../tests/browser/render";
import { LabUnitInput } from "../lab-unit-input";

/**
 * The unit field as a form holds it, typed into key by key. A unit that
 * starts with a 1 (10^9/L, 1/min) passes through "1" on the way, and that
 * keystroke must not turn into the "no unit" choice.
 */
function Controlled({ initial = "" }: { initial?: string }) {
  const [unit, setUnit] = useState(initial);
  return (
    <>
      <label htmlFor="u">Unit</label>
      <LabUnitInput id="u" value={unit} onChange={setUnit} />
      <output data-testid="unit">{unit}</output>
    </>
  );
}

describe("<LabUnitInput> typed into", () => {
  it("keeps a unit that starts with a 1", async () => {
    const { screen } = await renderWithApp(<Controlled />);
    await userEvent.type(screen.getByLabelText("Unit"), "10^9/L");
    await expect
      .element(screen.getByTestId("unit"))
      .toHaveTextContent("10^9/L");
    await expect
      .element(screen.getByRole("checkbox", { name: /no unit/i }))
      .not.toBeChecked();
  });

  it("shows a stored unity as the ticked choice and gives the field back on unticking", async () => {
    const { screen } = await renderWithApp(<Controlled initial="1" />);
    const box = screen.getByRole("checkbox", { name: /no unit/i });
    await expect.element(box).toBeChecked();
    await expect.element(screen.getByLabelText("Unit")).toBeDisabled();
    await box.click();
    await expect.element(screen.getByLabelText("Unit")).toBeEnabled();
    await userEvent.type(screen.getByLabelText("Unit"), "mmol/L");
    await expect
      .element(screen.getByTestId("unit"))
      .toHaveTextContent("mmol/L");
  });

  it("sets the unity when the box is ticked", async () => {
    const { screen } = await renderWithApp(<Controlled initial="mg/dL" />);
    await screen.getByRole("checkbox", { name: /no unit/i }).click();
    await expect
      .poll(() => screen.getByTestId("unit").element().textContent)
      .toBe("1");
  });
});
