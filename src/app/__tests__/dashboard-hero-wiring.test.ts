import { describe, it, expect } from "vitest";
import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dashboard top — page + header wiring pins.
 *
 * Since 1.50 the dashboard opens with what today asks (the ask card, only
 * when the digest carries asks) and the score row, both on the tile strip's
 * grid. The morning block and the Today hero are gone. Pinned here:
 *
 *   - the page hands both to the tile grid as its `lead`, the asks first, and
 *     no longer references the morning block, the Today hero, the legacy
 *     hero, its skeleton, or the `heroVisible` gate;
 *   - the greeting paragraph lives in the header on every mount, while the
 *     page itself derives no welcome text.
 */
const HEADER_PATH = join(
  process.cwd(),
  "src/components/dashboard/dashboard-header.tsx",
);

describe("dashboard top — page wiring", () => {
  const src = dashboardSource();

  it("leads the tile grid with the asks, then the score row", () => {
    const lead = src.indexOf("lead={");
    const asks = src.indexOf("<TodayAsks", lead);
    const scores = src.indexOf("<TodayScores", asks);
    const strip = src.indexOf("stripEntries={stripEntries}", scores);
    expect(lead).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(lead);
    expect(scores).toBeGreaterThan(asks);
    expect(strip).toBeGreaterThan(scores);
    // The asks render from the digest as delivered; the page ranks nothing.
    expect(src).toContain("asks={digestQuery.data.asks ?? []}");
  });

  it("the layout switch hides the score row, its skeleton and its error card, never the asks", () => {
    expect(src).toContain("visible: layout.todayCardVisible !== false");
    const asks = src.indexOf("<TodayAsks");
    const block = src.indexOf('todaySlot === "block"');
    const skeleton = src.indexOf("<TodayScoresSkeleton", block);
    const error = src.indexOf("<QueryErrorCard", skeleton);
    // The asks are rendered ahead of, and outside, the slot decision.
    expect(asks).toBeGreaterThan(-1);
    expect(asks).toBeLessThan(block);
    expect(skeleton).toBeGreaterThan(block);
    expect(error).toBeGreaterThan(skeleton);
  });

  it("no longer mounts the morning block or the Today hero", () => {
    expect(src).not.toContain("MorningBlock");
    expect(src).not.toContain("TodayHero");
    expect(src).not.toContain("ServerSetupNotice");
  });

  it("no longer references the retired legacy hero", () => {
    expect(src).not.toContain("DashboardHero");
    expect(src).not.toContain("DashboardHeroSkeleton");
    expect(src).not.toContain("heroVisible");
  });

  it("the page derives no welcome text (the header owns the greeting)", () => {
    expect(src).not.toContain("welcomeText");
    expect(src).not.toContain("welcomeBackWithName");
    expect(src).not.toContain("getHourForTimeZone");
  });
});

describe("dashboard top — header greeting", () => {
  const header = readFileSync(HEADER_PATH, "utf8");

  it("renders the greeting unconditionally (no showGreeting gate)", () => {
    // The greeting line renders on every mount — the legacy hero that
    // once owned it is gone, so there is no `showGreeting` prop to gate
    // it. The `min-h-5` line-box reservation keeps the header stable
    // through the post-hydration name swap.
    expect(header).not.toContain("showGreeting");
    expect(header).toContain("min-h-5");
    expect(header).toContain('data-slot="dashboard-header-greeting"');
  });

  it("the page mounts the header without a greeting prop", () => {
    const src = dashboardSource();
    expect(src).toContain(
      "<DashboardHeader onQuickEntry={setQuickEntryDialog} />",
    );
  });

  it("the header keeps the title + customize + add actions", () => {
    expect(header).toContain('t("dashboard.title")');
    expect(header).toContain("dashboard-customize-shortcut");
    expect(header).toContain("dashboard-quick-add");
  });
});
