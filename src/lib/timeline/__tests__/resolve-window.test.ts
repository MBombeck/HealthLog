import { describe, expect, it } from "vitest";

import { resolveTimelineWindow } from "../load-timeline";

describe("resolveTimelineWindow", () => {
  const today = "2026-11-04";

  it("starts `all` at the first day with data, or a year back without any", () => {
    expect(resolveTimelineWindow({ zoom: "all" }, today, "2019-03-02")).toEqual(
      { from: "2019-03-02", to: today },
    );
    expect(resolveTimelineWindow({ zoom: "all" }, today, null)).toEqual({
      from: "2025-11-05",
      to: today,
    });
    // Data that starts after `to` does not invert the window.
    expect(
      resolveTimelineWindow(
        { zoom: "all", to: "2020-01-01" },
        today,
        "2021-01-01",
      ),
    ).toEqual({ from: "2019-01-02", to: "2020-01-01" });
  });

  it("reaches back the fixed span for `year` and `quarter`", () => {
    expect(
      resolveTimelineWindow({ zoom: "year" }, today, "2001-01-01"),
    ).toEqual({ from: "2025-11-05", to: today });
    expect(
      resolveTimelineWindow({ zoom: "quarter" }, today, "2001-01-01"),
    ).toEqual({ from: "2026-08-06", to: today });
  });

  it("keeps a chosen `range` exactly", () => {
    expect(
      resolveTimelineWindow(
        { zoom: "range", from: "2024-02-01", to: "2024-03-01" },
        today,
        "2001-01-01",
      ),
    ).toEqual({ from: "2024-02-01", to: "2024-03-01" });
  });
});
