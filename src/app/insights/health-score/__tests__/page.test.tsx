import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DAY_SCORE_HREF } from "@/lib/day/contract";

/**
 * `/insights/health-score` became `/insights/scores/health` in 1.50: the
 * Health score's panel and its course on one page beside the other scores.
 * The old address redirects so saved links still land.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirect(to),
}));

import HealthScoreHistoryPage from "../page";

describe("/insights/health-score", () => {
  it("sends the old address to the Health score's page", () => {
    expect(() => HealthScoreHistoryPage()).toThrow(
      "redirect:/insights/scores/health",
    );
    expect(redirect).toHaveBeenCalledWith("/insights/scores/health");
  });

  it("is where the day view's health-score tile opens", () => {
    expect(DAY_SCORE_HREF.healthScore).toBe("/insights/scores/health");
  });

  it("every score tile in the day view opens a page that exists", () => {
    const app = join(__dirname, "..", "..", "..");
    for (const href of Object.values(DAY_SCORE_HREF)) {
      const segments = href.split("/").filter(Boolean);
      const direct = join(app, ...segments, "page.tsx");
      const dynamic = join(
        app,
        ...segments.slice(0, -1),
        "[metric]",
        "page.tsx",
      );
      expect(existsSync(direct) || existsSync(dynamic), href).toBe(true);
    }
  });
});
