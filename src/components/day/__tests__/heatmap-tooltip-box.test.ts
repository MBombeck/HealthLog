/**
 * The pinned heatmap tooltip on a 390 px phone. It shrinks to the room right
 * of its left edge and wraps, so it never runs past the screen; measured in
 * Chromium, a tap at the right border left it flush against the edge. The
 * box keeps the 8 px gutter the clamp meant to leave.
 */
import { describe, expect, it } from "vitest";

import { tooltipBox } from "../heatmap-day";

describe("tooltipBox", () => {
  it("keeps an 8 px gutter at the right edge for a tap near the border", () => {
    const { left, maxWidth } = tooltipBox(380, 390);
    expect(left).toBe(182);
    expect(left + maxWidth).toBe(390 - 8);
  });

  it("sits beside the pointer away from the border", () => {
    const { left, maxWidth } = tooltipBox(40, 390);
    expect(left).toBe(50);
    expect(left + maxWidth).toBe(382);
  });

  it("never starts left of the 8 px gutter", () => {
    expect(tooltipBox(-20, 390).left).toBe(8);
  });
});
