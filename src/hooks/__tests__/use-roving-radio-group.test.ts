/**
 * v1.7.0 — Roving-tabindex navigation math for ARIA radiogroups.
 *
 * The component test harness here is SSR-only (no jsdom / no simulated
 * keyboard events), so the Arrow / Home / End logic that the hook layers
 * onto the segmented controls is verified at the pure-function level. The
 * render shape (tabindex 0 on the selected option, -1 on the rest,
 * aria-checked) is pinned in each control's own SSR contract test.
 */
import { describe, expect, it } from "vitest";

import { rovingRadioNextIndex } from "../use-roving-radio-group";

const COUNT = 3;

describe("rovingRadioNextIndex", () => {
  it("ArrowRight / ArrowDown advance and wrap", () => {
    expect(rovingRadioNextIndex("ArrowRight", 0, COUNT)).toBe(1);
    expect(rovingRadioNextIndex("ArrowDown", 1, COUNT)).toBe(2);
    expect(rovingRadioNextIndex("ArrowRight", 2, COUNT)).toBe(0);
  });

  it("ArrowLeft / ArrowUp retreat and wrap", () => {
    expect(rovingRadioNextIndex("ArrowLeft", 2, COUNT)).toBe(1);
    expect(rovingRadioNextIndex("ArrowUp", 1, COUNT)).toBe(0);
    expect(rovingRadioNextIndex("ArrowLeft", 0, COUNT)).toBe(2);
  });

  it("Home / End jump to first / last", () => {
    expect(rovingRadioNextIndex("Home", 2, COUNT)).toBe(0);
    expect(rovingRadioNextIndex("End", 0, COUNT)).toBe(2);
  });

  it("returns null for non-navigation keys", () => {
    expect(rovingRadioNextIndex("Enter", 0, COUNT)).toBeNull();
    expect(rovingRadioNextIndex(" ", 0, COUNT)).toBeNull();
    expect(rovingRadioNextIndex("Tab", 0, COUNT)).toBeNull();
  });

  it("returns null when the group is empty", () => {
    expect(rovingRadioNextIndex("ArrowRight", -1, 0)).toBeNull();
  });

  it("starts from the first enabled option when nothing is selected", () => {
    expect(rovingRadioNextIndex("ArrowRight", -1, COUNT)).toBe(1);
    expect(rovingRadioNextIndex("ArrowLeft", -1, COUNT)).toBe(2);
  });

  it("skips disabled options when stepping", () => {
    // Middle option disabled: ArrowRight from 0 lands on 2, not 1.
    const middleDisabled = (i: number) => i === 1;
    expect(rovingRadioNextIndex("ArrowRight", 0, COUNT, middleDisabled)).toBe(2);
    expect(rovingRadioNextIndex("ArrowLeft", 2, COUNT, middleDisabled)).toBe(0);
  });

  it("Home / End respect disabled bounds", () => {
    const endsDisabled = (i: number) => i === 0 || i === COUNT - 1;
    expect(rovingRadioNextIndex("Home", 1, COUNT, endsDisabled)).toBe(1);
    expect(rovingRadioNextIndex("End", 1, COUNT, endsDisabled)).toBe(1);
  });

  it("returns null when every option is disabled", () => {
    expect(
      rovingRadioNextIndex("ArrowRight", 0, COUNT, () => true),
    ).toBeNull();
  });
});
