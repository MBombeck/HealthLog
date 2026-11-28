import { describe, expect, it } from "vitest";

import {
  LEGACY_TAB_SHEETS,
  LEGACY_TAB_SLUGS,
  resolveTabSlug,
  TAB_SLUGS,
} from "@/components/medications/detail/tab-slugs";

/**
 * The medication tabs carried German slugs in every language
 * (`?tab=verlauf`), and six tabs until v1.50, when the schedule, supply and
 * advanced tabs folded into the settings tab. Every old link (a bookmark, a
 * report, a low-stock notification sent before the change) still lands on
 * the tab that holds what it named.
 */
describe("medication tab slugs", () => {
  const all = [...TAB_SLUGS];

  it("has the four tabs and the injection tab, in page order", () => {
    expect(all).toEqual([
      "overview",
      "history",
      "effect",
      "injection",
      "settings",
    ]);
  });

  it("opens a tab by its own slug", () => {
    expect(resolveTabSlug("history", all)).toBe("history");
    expect(resolveTabSlug("settings", all)).toBe("settings");
  });

  it.each([
    ["uebersicht", "overview"],
    ["wirkung", "effect"],
    ["verlauf", "history"],
    ["injektion", "injection"],
    ["schedule", "settings"],
    ["supply", "settings"],
    ["advanced", "settings"],
    ["zeitplan", "settings"],
    ["bestand", "settings"],
    ["erweitert", "settings"],
    ["erinnerung", "settings"],
    ["api", "settings"],
    ["einstellungen", "settings"],
  ] as const)("sends the old ?tab=%s to %s", (legacy, tab) => {
    expect(resolveTabSlug(legacy, all)).toBe(tab);
  });

  it("maps every retired slug to a tab that exists", () => {
    for (const target of Object.values(LEGACY_TAB_SLUGS)) {
      expect(all).toContain(target);
    }
    // A retired slug must not shadow a live one.
    for (const legacy of Object.keys(LEGACY_TAB_SLUGS)) {
      expect(all as readonly string[]).not.toContain(legacy);
    }
  });

  it("opens the supply sheet for an old supply link", () => {
    expect(LEGACY_TAB_SHEETS.supply).toBe("supply");
    expect(LEGACY_TAB_SHEETS.bestand).toBe("supply");
    expect(LEGACY_TAB_SHEETS.history).toBeUndefined();
  });

  it("falls back to the overview for a missing, unknown or unavailable tab", () => {
    expect(resolveTabSlug(null, all)).toBe("overview");
    expect(resolveTabSlug("constructor", all)).toBe("overview");
    expect(resolveTabSlug("nope", all)).toBe("overview");
    expect(
      resolveTabSlug(
        "injektion",
        all.filter((tab) => tab !== "injection"),
      ),
    ).toBe("overview");
    expect(
      resolveTabSlug(
        "supply",
        all.filter((tab) => tab !== "settings"),
      ),
    ).toBe("overview");
  });

  it("keeps every slug URL-safe ASCII", () => {
    for (const slug of TAB_SLUGS) expect(slug).toMatch(/^[a-z]+$/);
  });
});
