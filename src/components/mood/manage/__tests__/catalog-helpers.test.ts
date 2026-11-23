/**
 * v1.17 — pure catalog-tree surgery behind the mood-tag management
 * cards. The optimistic-update path applies these to the cached manage
 * read before the PATCH/PUT settles, so their contracts (unknown keys
 * tolerated, archived rows preserved, placement maps complete) are
 * pinned here without any DOM.
 */
import { describe, expect, it } from "vitest";

import {
  buildGroupOrder,
  moveTagToGroup,
  removeTag,
  reorderGroupTags,
  reorderGroups,
  setTagArchived,
  setTagHidden,
  type ManageCatalog,
  type ManageTag,
} from "../use-mood-tag-manage";
import {
  buildVisiblePlacements,
  mergeBack,
  visibleCatalog,
} from "../tag-manager-card";
import { archivedTags } from "../archived-tags-card";
import { moveGroupKey } from "../tag-groups-card";
import { insertTagIntoCatalog } from "../tag-editor-sheet";

function tag(key: string, overrides: Partial<ManageTag> = {}): ManageTag {
  return {
    key,
    labelKey: `mood.tag.${key}`,
    label: null,
    icon: "Tag",
    kind: "BINARY",
    scaleMin: 0,
    scaleMax: 1,
    inverse: false,
    custom: false,
    ...overrides,
  };
}

function catalog(): ManageCatalog {
  return {
    categories: [
      {
        key: "feelings",
        labelKey: "mood.tagCategory.feelings",
        label: null,
        icon: "Smile",
        custom: false,
        tags: [tag("happy"), tag("stressed", { hidden: true })],
      },
      {
        key: "customcat:g1",
        labelKey: "customcat:g1",
        label: "Garten",
        icon: "Leaf",
        custom: true,
        tags: [
          tag("custom:1", { custom: true, label: "Gartenarbeit" }),
          tag("custom:2", {
            custom: true,
            label: "Altes Tag",
            archived: true,
            usageCount: 5,
          }),
        ],
      },
    ],
  };
}

describe("setTagHidden / setTagArchived", () => {
  it("flips only the addressed tag", () => {
    const next = setTagHidden(catalog(), "happy", true);
    expect(next.categories[0]!.tags[0]!.hidden).toBe(true);
    expect(next.categories[0]!.tags[1]!.hidden).toBe(true); // untouched
    expect(next.categories[1]!.tags[0]!.hidden).toBeUndefined();
  });

  it("archive flag round-trips", () => {
    const archived = setTagArchived(catalog(), "custom:1", true);
    expect(archived.categories[1]!.tags[0]!.archived).toBe(true);
    const restored = setTagArchived(archived, "custom:1", false);
    expect(restored.categories[1]!.tags[0]!.archived).toBe(false);
  });
});

describe("removeTag", () => {
  it("drops the row from its group and leaves everything else", () => {
    const next = removeTag(catalog(), "custom:2");
    expect(next.categories[1]!.tags.map((t) => t.key)).toEqual(["custom:1"]);
    expect(next.categories[0]!.tags).toHaveLength(2);
  });
});

describe("moveTagToGroup", () => {
  it("appends the tag to the target group", () => {
    const next = moveTagToGroup(catalog(), "happy", "customcat:g1");
    expect(next.categories[0]!.tags.map((t) => t.key)).toEqual(["stressed"]);
    expect(next.categories[1]!.tags.map((t) => t.key)).toEqual([
      "custom:1",
      "custom:2",
      "happy",
    ]);
  });

  it("is a no-op for an unknown tag key", () => {
    const before = catalog();
    expect(moveTagToGroup(before, "nope", "customcat:g1")).toEqual(before);
  });
});

describe("reorderGroupTags / reorderGroups", () => {
  it("applies the given order and keeps unknown keys last", () => {
    const next = reorderGroupTags(catalog(), "feelings", [
      "stressed",
      "ghost",
      "happy",
    ]);
    expect(next.categories[0]!.tags.map((t) => t.key)).toEqual([
      "stressed",
      "happy",
    ]);
  });

  it("keeps unmentioned tags after the placed block", () => {
    const next = reorderGroupTags(catalog(), "feelings", ["stressed"]);
    expect(next.categories[0]!.tags.map((t) => t.key)).toEqual([
      "stressed",
      "happy",
    ]);
  });

  it("reorders groups and keeps unmentioned groups after the placed block", () => {
    const next = reorderGroups(catalog(), ["customcat:g1"]);
    expect(next.categories.map((c) => c.key)).toEqual([
      "customcat:g1",
      "feelings",
    ]);
  });
});

describe("buildGroupOrder", () => {
  it("emits the group keys in display order", () => {
    expect(buildGroupOrder(catalog())).toEqual(["feelings", "customcat:g1"]);
  });
});

describe("visibleCatalog / archivedTags / buildVisiblePlacements", () => {
  it("splits archived rows out of the visible projection", () => {
    const visible = visibleCatalog(catalog());
    expect(visible.categories[1]!.tags.map((t) => t.key)).toEqual(["custom:1"]);
    expect(archivedTags(catalog()).map((t) => t.key)).toEqual(["custom:2"]);
  });

  it("placement map of the visible tree excludes archived keys", () => {
    expect(buildVisiblePlacements(catalog())).toEqual({
      feelings: ["happy", "stressed"],
      "customcat:g1": ["custom:1"],
    });
  });
});

describe("mergeBack", () => {
  it("re-attaches archived rows after a visible-tree edit", () => {
    const full = catalog();
    const moved = moveTagToGroup(visibleCatalog(full), "happy", "customcat:g1");
    const merged = mergeBack(full, moved);
    expect(merged.categories[1]!.tags.map((t) => t.key)).toEqual([
      "custom:1",
      "happy",
      "custom:2",
    ]);
  });
});

describe("moveGroupKey", () => {
  it("swaps within bounds and refuses to cross either end", () => {
    expect(moveGroupKey(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveGroupKey(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveGroupKey(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("insertTagIntoCatalog", () => {
  it("appends the fresh DTO to its group", () => {
    const created = tag("custom:3", { custom: true, label: "Neu" });
    const next = insertTagIntoCatalog(catalog(), "customcat:g1", created);
    expect(next.categories[1]!.tags.map((t) => t.key)).toEqual([
      "custom:1",
      "custom:2",
      "custom:3",
    ]);
  });

  it("leaves the tree untouched when the group node is absent (empty group dropped by the plain read)", () => {
    const before = catalog();
    const created = tag("custom:3", { custom: true });
    expect(insertTagIntoCatalog(before, "customcat:none", created)).toEqual(
      before,
    );
  });
});
