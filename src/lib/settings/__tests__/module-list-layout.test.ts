import { describe, expect, it } from "vitest";

import {
  MODULE_LIST_CATEGORY_ORDER_MAX,
  MODULE_LIST_ORDER_MAX,
  normaliseModuleListOrder,
  resolveModuleListLayout,
  storedModuleListLayout,
} from "../module-list-layout";

describe("resolveModuleListLayout", () => {
  it("answers the defaults, nothing saved, for an empty column", () => {
    const layout = resolveModuleListLayout(null);
    expect(layout.lists.labs).toEqual({
      view: "list",
      order: [],
      sortDir: "recentDesc",
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
      saved: false,
    });
    expect(layout.lists.illness.view).toBe("cards");
    expect(layout.lists.vorsorge.view).toBe("cards");
    expect(layout.lists.illness.saved).toBe(false);
  });

  it("fills a partial list field by field and marks it saved", () => {
    const layout = resolveModuleListLayout({
      version: 1,
      illness: { order: ["b", "a"] },
    });
    expect(layout.lists.illness).toEqual({
      view: "cards",
      order: ["b", "a"],
      sortDir: "recentDesc",
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
      saved: true,
    });
    expect(layout.lists.labs.saved).toBe(false);
  });

  it("drops malformed values instead of failing", () => {
    const layout = resolveModuleListLayout({
      labs: { view: "grid", sortDir: 3, order: "x" },
      vorsorge: "nonsense",
    });
    expect(layout.lists.labs).toEqual({
      view: "list",
      order: [],
      sortDir: "recentDesc",
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
      saved: false,
    });
    expect(layout.lists.vorsorge.saved).toBe(false);
  });
});

describe("category choices", () => {
  it("keeps valid category choices and drops unknown ones", () => {
    const layout = resolveModuleListLayout({
      labs: { groupBy: "category", groupsOpen: "flagged" },
      illness: { groupBy: "panel", groupsOpen: "all" },
    });
    expect(layout.lists.labs).toMatchObject({
      groupBy: "category",
      groupsOpen: "flagged",
      saved: true,
    });
    expect(layout.lists.illness).toMatchObject({
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
      saved: false,
    });
  });
});

describe("category order", () => {
  it("keeps a stored category order, deduplicated, and marks the list saved", () => {
    const layout = resolveModuleListLayout({
      labs: { categoryOrder: ["thyroid", "lipids", "thyroid", 7, "other"] },
    });
    expect(layout.lists.labs).toMatchObject({
      categoryOrder: ["thyroid", "lipids", "other"],
      saved: true,
    });
  });

  it("drops a malformed category order and leaves the default", () => {
    const layout = resolveModuleListLayout({
      labs: { categoryOrder: "lipids" },
    });
    expect(layout.lists.labs.categoryOrder).toEqual([]);
    expect(layout.lists.labs.saved).toBe(false);
  });

  it("caps the category order on its own limit", () => {
    const keys = Array.from(
      { length: MODULE_LIST_CATEGORY_ORDER_MAX + 5 },
      (_, i) => `custom:${i}`,
    );
    const layout = resolveModuleListLayout({ labs: { categoryOrder: keys } });
    expect(layout.lists.labs.categoryOrder).toHaveLength(
      MODULE_LIST_CATEGORY_ORDER_MAX,
    );
  });

  it("hands every list its own copy of the default", () => {
    const layout = resolveModuleListLayout(null);
    layout.lists.labs.categoryOrder.push("lipids");
    expect(resolveModuleListLayout(null).lists.labs.categoryOrder).toEqual([]);
  });
});

describe("normaliseModuleListOrder", () => {
  it("keeps strings, drops duplicates, empties and over-long ids", () => {
    expect(
      normaliseModuleListOrder(["a", "a", "", 4, "b", "x".repeat(65)]),
    ).toEqual(["a", "b"]);
  });

  it("caps the length", () => {
    const ids = Array.from({ length: MODULE_LIST_ORDER_MAX + 10 }, (_, i) =>
      String(i),
    );
    expect(normaliseModuleListOrder(ids)).toHaveLength(MODULE_LIST_ORDER_MAX);
  });

  it("answers null for a non-array", () => {
    expect(normaliseModuleListOrder("a")).toBeNull();
  });
});

describe("storedModuleListLayout", () => {
  it("lists only the lists that carry a choice", () => {
    expect(
      storedModuleListLayout({ labs: { sortDir: "manual" }, illness: {} }),
    ).toEqual({ labs: { sortDir: "manual" } });
  });
});
