import { describe, it, expect } from "vitest";
import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dashboard hero — page + header wiring pins.
 *
 * The legacy opt-in `DashboardHero` (gated on a layout `heroVisible`
 * flag) was retired. Since 1.50 the morning block leads the dashboard and
 * the digest-driven `TodayHero` stands in when the morning read is
 * missing. Pinned here:
 *
 *   - the page mounts `MorningBlock`, then `TodayHero` as its fallback, and
 *     no longer references the legacy hero, its skeleton, or the
 *     `heroVisible` gate;
 *   - the greeting paragraph lives in the header on every mount (the
 *     header owns it unconditionally now that the legacy hero — which
 *     once carried it — is gone), while the page itself derives no
 *     welcome text.
 */
const HEADER_PATH = join(
  process.cwd(),
  "src/components/dashboard/dashboard-header.tsx",
);

describe("dashboard hero — page wiring", () => {
  const src = dashboardSource();

  it("mounts the morning block above the tile strip, the TodayHero as its fallback", () => {
    const blockIdx = src.indexOf("<MorningBlock");
    const heroIdx = src.indexOf("<TodayHero");
    const stripIdx = src.indexOf("dashboard-tile-strip");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(heroIdx).toBeGreaterThan(blockIdx);
    expect(stripIdx).toBeGreaterThan(heroIdx);
  });

  it("asks an empty filtered digest to render its all-clear state", () => {
    expect(src).toContain("renderFilteredHeroAllClear");
    expect(src).toContain(
      "renderFilteredAllClear={renderFilteredHeroAllClear}",
    );
    expect(src).toContain(
      "(layout.enabledHeroItemKinds ?? PRIORITY_ITEM_KINDS).length",
    );
  });

  it("hides the top card, its skeleton and its error card only on an explicit false", () => {
    // One decision in front of the whole branch (`morningSlot`), so
    // switching the card off leaves no reserve and no retry card where it
    // stood; the cases of that decision are pinned in
    // `morning-block.test.tsx`.
    expect(src).toContain("visible: layout.todayCardVisible !== false");
    const block = src.indexOf('todaySlot === "block"');
    const skeleton = src.indexOf("<MorningSkeleton", block);
    const hero = src.indexOf("<TodayHero", skeleton);
    const error = src.indexOf("<QueryErrorCard", hero);
    expect(block).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(block);
    expect(hero).toBeGreaterThan(skeleton);
    expect(error).toBeGreaterThan(hero);
    // The old hero skeleton would paint a different footprint than the
    // block it stands for.
    expect(src).not.toContain("<TodayHeroSkeleton");
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

describe("dashboard hero — header greeting", () => {
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
