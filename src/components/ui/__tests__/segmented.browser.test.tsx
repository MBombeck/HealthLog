import { useState } from "react";
import { LayoutGrid, Table } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { renderWithApp } from "../../../../tests/browser/render";
import { Segmented, type SegmentedProps } from "../segmented";

type Zoom = "day" | "week" | "month";

const OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

/**
 * The control as a caller holds it: the value lives in the parent and moves
 * only when `onChange` says so, which is what makes the roving tab stop
 * follow the selection.
 */
function Controlled({
  initial = "day",
  onChange,
  ...props
}: Partial<Omit<SegmentedProps<Zoom>, "value">> & { initial?: Zoom }) {
  const [value, setValue] = useState<Zoom>(initial);
  return (
    <>
      <button type="button">Before</button>
      <Segmented
        options={OPTIONS}
        label="Zoom"
        slot="zoom"
        {...props}
        value={value}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
      />
      <button type="button">After</button>
    </>
  );
}

async function mount(props: Parameters<typeof Controlled>[0] = {}) {
  const onChange = vi.fn();
  const { screen } = await renderWithApp(
    <Controlled onChange={onChange} {...props} />,
  );
  const radio = (name: string) => screen.getByRole("radio", { name });
  return { screen, onChange, radio };
}

describe("<Segmented> in radio mode", () => {
  it("is one tab stop, on the chosen segment", async () => {
    const { screen, radio } = await mount({ initial: "week" });
    await expect
      .element(screen.getByRole("radiogroup", { name: "Zoom" }))
      .toBeInTheDocument();
    await expect.element(radio("Week")).toBeChecked();
    await expect.element(radio("Day")).not.toBeChecked();

    await screen.getByRole("button", { name: "Before" }).click();
    await userEvent.tab();
    await expect.element(radio("Week")).toHaveFocus();
    await userEvent.tab();
    await expect
      .element(screen.getByRole("button", { name: "After" }))
      .toHaveFocus();
  });

  it("moves focus and selection together with the arrow keys", async () => {
    const { onChange, radio } = await mount();
    await radio("Day").click();
    onChange.mockClear();

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(radio("Week")).toHaveFocus();
    await expect.element(radio("Week")).toBeChecked();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(radio("Month")).toBeChecked();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(radio("Week")).toHaveFocus();
    expect(onChange.mock.calls).toEqual([["week"], ["month"], ["week"]]);
  });

  it("wraps at both ends", async () => {
    const { radio } = await mount({ initial: "month" });
    await radio("Month").click();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(radio("Day")).toHaveFocus();
    await expect.element(radio("Day")).toBeChecked();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(radio("Month")).toHaveFocus();
    await expect.element(radio("Month")).toBeChecked();
  });

  it("jumps to the first and last segment with Home and End", async () => {
    const { onChange, radio } = await mount({ initial: "week" });
    await radio("Week").click();
    await userEvent.keyboard("{End}");
    await expect.element(radio("Month")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.element(radio("Day")).toHaveFocus();
    await expect.element(radio("Day")).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith("day");
  });

  it("fires again on the chosen segment, which can open something", async () => {
    const { onChange, radio } = await mount({ initial: "day" });
    await radio("Day").click();
    await radio("Day").click();
    expect(onChange.mock.calls).toEqual([["day"], ["day"]]);
  });

  it("takes no press and no key while disabled", async () => {
    const { screen, onChange, radio } = await mount({ disabled: true });
    await expect
      .element(screen.getByRole("radiogroup", { name: "Zoom" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(radio("Week")).toBeDisabled();
    await radio("Week").click({ force: true });
    await screen.getByRole("button", { name: "Before" }).click();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}{End}");
    expect(onChange).not.toHaveBeenCalled();
    await expect.element(radio("Day")).toBeChecked();
  });
});

describe("<Segmented> in toggle mode", () => {
  it("renders pressed buttons and ignores a press on the active one", async () => {
    const { screen, onChange } = await mount({ mode: "toggle" });
    await expect
      .element(screen.getByRole("group", { name: "Zoom" }))
      .toBeInTheDocument();
    expect(screen.getByRole("radio").elements()).toHaveLength(0);
    const day = screen.getByRole("button", { name: "Day" });
    const week = screen.getByRole("button", { name: "Week" });
    await expect.element(day).toHaveAttribute("aria-pressed", "true");

    await day.click();
    expect(onChange).not.toHaveBeenCalled();
    await week.click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("week");
    await expect.element(week).toHaveAttribute("aria-pressed", "true");
    await expect.element(day).toHaveAttribute("aria-pressed", "false");
  });

  it("leaves every segment its own tab stop and the arrows alone", async () => {
    const { screen, onChange } = await mount({ mode: "toggle" });
    await screen.getByRole("button", { name: "Day" }).click();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.tab();
    await expect
      .element(screen.getByRole("button", { name: "Week" }))
      .toHaveFocus();
  });
});

describe("<Segmented> look", () => {
  it("fills only the chosen segment in the primary colour, on no track", async () => {
    const { screen, radio } = await mount({ initial: "week" });
    const group = screen.getByRole("radiogroup").element();
    const probe = document.createElement("span");
    probe.className = "bg-primary";
    document.body.append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const background = (name: string) =>
      getComputedStyle(radio(name).element()).backgroundColor;
    expect(background("Week")).toBe(primary);
    expect(background("Day")).not.toBe(primary);
    expect(getComputedStyle(group).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("sets the small size in smaller type and keeps the 36 px floor", async () => {
    const { radio } = await mount();
    const md = radio("Day").element();
    expect(getComputedStyle(md).fontSize).toBe("14px");
    expect(md.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);

    const { screen } = await renderWithApp(
      <Segmented
        options={OPTIONS}
        value="day"
        onChange={() => {}}
        label="Range"
        size="sm"
      />,
    );
    const sm = screen
      .getByRole("radiogroup", { name: "Range" })
      .getByRole("radio", { name: "Day" })
      .element();
    expect(getComputedStyle(sm).fontSize).toBe("12px");
    expect(sm.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  it("names icon-only segments without showing the label", async () => {
    const onChange = vi.fn();
    const { screen } = await renderWithApp(
      <Segmented
        mode="toggle"
        iconOnly
        options={[
          { value: "cards", label: "Cards", icon: LayoutGrid },
          { value: "table", label: "Table", icon: Table },
        ]}
        value="cards"
        onChange={onChange}
        label="View"
        optionSlot={(v) => `medications-view-${v}`}
      />,
    );
    const table = screen.getByRole("button", { name: "Table" });
    await expect.element(table).toHaveAttribute("title", "Table");
    await expect
      .element(table)
      .toHaveAttribute("data-slot", "medications-view-table");
    await expect.element(screen.getByText("Cards")).not.toBeInTheDocument();
    await table.click();
    expect(onChange).toHaveBeenCalledWith("table");
  });
});
