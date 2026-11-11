import { describe, expect, it } from "vitest";

import {
  resolveTabSlug,
  TAB_SLUGS,
} from "@/components/medications/detail/tab-slugs";

/**
 * The medication tabs carried German slugs in every language
 * (`?tab=verlauf`). They are English now, and every old link (a bookmark,
 * a report, a low-stock notification sent before the change) still lands on
 * the tab it named.
 */
describe("medication tab slugs", () => {
  const all = [...TAB_SLUGS];

  it("opens a tab by its own slug", () => {
    expect(resolveTabSlug("history", all)).toBe("history");
    expect(resolveTabSlug("supply", all)).toBe("supply");
  });

  it.each([
    ["uebersicht", "overview"],
    ["wirkung", "effect"],
    ["zeitplan", "schedule"],
    ["bestand", "supply"],
    ["verlauf", "history"],
    ["injektion", "injection"],
    ["erweitert", "advanced"],
    ["erinnerung", "schedule"],
    ["api", "advanced"],
  ] as const)("sends the old ?tab=%s to %s", (legacy, tab) => {
    expect(resolveTabSlug(legacy, all)).toBe(tab);
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
  });

  it("keeps every slug URL-safe ASCII", () => {
    for (const slug of TAB_SLUGS) expect(slug).toMatch(/^[a-z]+$/);
  });
});
