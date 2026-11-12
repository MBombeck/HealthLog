/**
 * `sheetBodyHasUnsavedInput`, the fallback dirty check an add form passes to
 * `ResponsiveSheet`. It reads the one sheet body it is handed. Tests run in
 * Node, so the body is a fake that answers the three queries the check makes.
 */
import { describe, expect, it } from "vitest";

import { sheetBodyHasUnsavedInput } from "@/components/ui/responsive-sheet";

const MOOD_RADIO_SELECTOR = '[role="radio"][aria-checked="true"]';
const OPEN_SELECT_SELECTOR = '[role="combobox"][data-state="open"]';

interface FakeField {
  type: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  defaultChecked?: boolean;
  /** The text overlay of a `DateField` / `TimeField`. */
  inDateOrTimeField?: boolean;
}

function fakeBody(fixture: {
  fields?: FakeField[];
  moodRadioSelected?: boolean;
  openSelect?: boolean;
}): HTMLElement {
  const fields = (fixture.fields ?? []).map((field) => ({
    ...field,
    value: field.value ?? "",
    dataset: {},
    closest: () => (field.inDateOrTimeField ? {} : null),
  }));
  return {
    querySelectorAll: (selector: string) =>
      selector === "input, textarea" ? fields : [],
    querySelector: (selector: string) => {
      if (selector === MOOD_RADIO_SELECTOR) {
        return fixture.moodRadioSelected ? {} : null;
      }
      if (selector === OPEN_SELECT_SELECTOR) {
        return fixture.openSelect ? {} : null;
      }
      return null;
    },
  } as unknown as HTMLElement;
}

describe("sheetBodyHasUnsavedInput", () => {
  it("is clean for a pristine form whose date and time read 'now'", () => {
    const body = fakeBody({
      fields: [
        { type: "text", value: "" },
        { type: "textarea", value: "" },
        { type: "text", value: "04.06.2026", inDateOrTimeField: true },
        { type: "text", value: "08:00", inDateOrTimeField: true },
        { type: "hidden", value: "2026-06-04" },
      ],
    });
    expect(sheetBodyHasUnsavedInput(body)).toBe(false);
  });

  it("is dirty when a text field carries a value", () => {
    const body = fakeBody({ fields: [{ type: "text", value: "75.5" }] });
    expect(sheetBodyHasUnsavedInput(body)).toBe(true);
  });

  it("ignores a disabled field carrying a value", () => {
    const body = fakeBody({
      fields: [{ type: "text", value: "ignored", disabled: true }],
    });
    expect(sheetBodyHasUnsavedInput(body)).toBe(false);
  });

  it("is dirty for a checkbox moved off its default", () => {
    const body = fakeBody({
      fields: [{ type: "checkbox", checked: true, defaultChecked: false }],
    });
    expect(sheetBodyHasUnsavedInput(body)).toBe(true);
  });

  it("is dirty when a mood face is chosen, clean when none is", () => {
    expect(
      sheetBodyHasUnsavedInput(fakeBody({ moodRadioSelected: true })),
    ).toBe(true);
    expect(
      sheetBodyHasUnsavedInput(fakeBody({ moodRadioSelected: false })),
    ).toBe(false);
  });

  it("is dirty while a Select is open, clean on its closed default", () => {
    expect(sheetBodyHasUnsavedInput(fakeBody({ openSelect: true }))).toBe(true);
    expect(sheetBodyHasUnsavedInput(fakeBody({ openSelect: false }))).toBe(
      false,
    );
  });

  it("is clean without a body", () => {
    expect(sheetBodyHasUnsavedInput(null)).toBe(false);
  });
});
