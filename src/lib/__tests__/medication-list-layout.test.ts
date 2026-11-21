/**
 * Medications list presentation blob (resolver + serializer + category ordering).
 *
 * The resolver must never throw on a stored row (malformed / legacy /
 * partial blobs collapse onto the defaults field-by-field); the
 * serializer dedupes and caps the manual order so the persisted blob
 * stays bounded and canonical.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDICATION_LIST_LAYOUT,
  MEDICATION_ORDER_MAX_ENTRIES,
  MEDICATION_CATEGORY_ORDER_MAX,
  remapMedicationListCategoryOrder,
  sortMedicationCategoriesByDefault,
  resolveMedicationListLayout,
  serializeMedicationListLayout,
} from "@/lib/medication-list-layout";

describe("resolveMedicationListLayout", () => {
  it("returns the defaults for a null / missing column", () => {
    expect(resolveMedicationListLayout(null)).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
    expect(resolveMedicationListLayout(undefined)).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
  });

  it("returns the defaults for a non-object blob", () => {
    expect(resolveMedicationListLayout("cards")).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
    expect(resolveMedicationListLayout(42)).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
  });

  it("resolves a complete stored blob verbatim", () => {
    expect(
      resolveMedicationListLayout({
        version: 1,
        view: "table",
        order: ["med-b", "med-a"],
        groupBy: "category",
        groupsOpen: "collapsed",
        categoryOrder: ["PAIN_RELIEF", "VITAMIN"],
      }),
    ).toEqual({
      version: 1,
      view: "table",
      order: ["med-b", "med-a"],
      groupBy: "category",
      groupsOpen: "collapsed",
      categoryOrder: ["PAIN_RELIEF", "VITAMIN"],
    });
  });

  it("falls back per field: legacy blob without grouping fields gets default flat presentation", () => {
    expect(
      resolveMedicationListLayout({
        version: 1,
        view: "table",
        order: ["med-a"],
      }),
    ).toEqual({
      version: 1,
      view: "table",
      order: ["med-a"],
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
    });
  });

  it("falls back per field on invalid values: unknown view → cards, invalid groupBy → none", () => {
    expect(
      resolveMedicationListLayout({
        view: "kanban",
        order: "med-a",
        groupBy: "invalid",
        groupsOpen: "unknown",
        categoryOrder: "not-array",
      }),
    ).toEqual({
      version: 1,
      view: "cards",
      order: [],
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
    });
  });

  it("drops non-string and oversized order entries, keeping the rest", () => {
    const resolved = resolveMedicationListLayout({
      view: "table",
      order: ["med-a", 7, null, "x".repeat(65), "med-b"],
    });
    expect(resolved.order).toEqual(["med-a", "med-b"]);
  });

  it("dedupes a stored order and category order (first occurrence wins)", () => {
    const resolved = resolveMedicationListLayout({
      view: "cards",
      order: ["med-a", "med-b", "med-a"],
      categoryOrder: ["VITAMIN", "THYROID", "VITAMIN"],
    });
    expect(resolved.order).toEqual(["med-a", "med-b"]);
    expect(resolved.categoryOrder).toEqual(["VITAMIN", "THYROID"]);
  });

  it("caps categoryOrder at MEDICATION_CATEGORY_ORDER_MAX", () => {
    const categoryOrder = Array.from(
      { length: 300 },
      (_, i) => `custom:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const resolved = resolveMedicationListLayout({
      categoryOrder,
    });
    expect(resolved.categoryOrder?.length).toBe(MEDICATION_CATEGORY_ORDER_MAX);
  });
});

describe("serializeMedicationListLayout", () => {
  it("emits the canonical v1 blob with defaults for omitted grouping fields", () => {
    expect(
      serializeMedicationListLayout({ view: "table", order: ["med-a"] }),
    ).toEqual({
      version: 1,
      view: "table",
      order: ["med-a"],
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: [],
    });
  });

  it("serializes explicit grouping fields", () => {
    expect(
      serializeMedicationListLayout({
        view: "cards",
        order: ["a", "b"],
        groupBy: "category",
        groupsOpen: "flagged",
        categoryOrder: ["VITAMIN", "PAIN_RELIEF"],
      }),
    ).toEqual({
      version: 1,
      view: "cards",
      order: ["a", "b"],
      groupBy: "category",
      groupsOpen: "flagged",
      categoryOrder: ["VITAMIN", "PAIN_RELIEF"],
    });
  });

  it("dedupes the order and category order before persisting", () => {
    expect(
      serializeMedicationListLayout({
        view: "cards",
        order: ["a", "b", "a", "c", "b"],
        categoryOrder: ["x", "y", "x", "z"],
      }),
    ).toEqual({
      version: 1,
      view: "cards",
      order: ["a", "b", "c"],
      groupBy: "none",
      groupsOpen: "expanded",
      categoryOrder: ["x", "y", "z"],
    });
  });

  it("caps order and categoryOrder at the documented maximum", () => {
    const order = Array.from({ length: 500 }, (_, i) => `med-${i}`);
    const categoryOrder = Array.from({ length: 500 }, (_, i) => `cat-${i}`);
    const serialized = serializeMedicationListLayout({
      view: "cards",
      order,
      categoryOrder,
    });
    expect(serialized.order.length).toBe(MEDICATION_ORDER_MAX_ENTRIES);
    expect(serialized.categoryOrder?.length).toBe(
      MEDICATION_CATEGORY_ORDER_MAX,
    );
  });
});

describe("sortMedicationCategoriesByDefault", () => {
  it("ranks built-ins first in fixed order, custom categories alphabetically, and OTHER last", () => {
    const input = [
      { key: "OTHER", label: "Other" },
      { key: "custom:omega", label: "Omega Custom" },
      { key: "custom:alpha", label: "Alpha Custom" },
      { key: "PAIN_RELIEF", label: "Pain Relief" },
      { key: "BLOOD_PRESSURE", label: "Blood Pressure" },
    ];

    const sorted = sortMedicationCategoriesByDefault(input);
    expect(sorted.map((c) => c.key)).toEqual([
      "BLOOD_PRESSURE",
      "PAIN_RELIEF",
      "custom:alpha",
      "custom:omega",
      "OTHER",
    ]);
  });

  it("handles empty and single-category lists", () => {
    expect(sortMedicationCategoriesByDefault([])).toEqual([]);
    expect(
      sortMedicationCategoriesByDefault([{ key: "OTHER", label: "Other" }]),
    ).toEqual([{ key: "OTHER", label: "Other" }]);
  });
});

describe("category order keys in a stored blob", () => {
  it("drops a key that is neither a built-in value nor custom:<uuid>", () => {
    const own = "custom:0f0c6a52-6a43-4f63-9b39-0c1f4d7e2a10";
    expect(
      resolveMedicationListLayout({
        categoryOrder: ["PAIN", own, 7, "custom:x", "OTHER"],
      }).categoryOrder,
    ).toEqual([own, "OTHER"]);
  });
});

describe("remapMedicationListCategoryOrder", () => {
  const from = "custom:0f0c6a52-6a43-4f63-9b39-0c1f4d7e2a10";
  const to = "custom:1a1c6a52-6a43-4f63-9b39-0c1f4d7e2a10";

  it("rewrites a re-minted key and leaves the rest of the blob alone", () => {
    expect(
      remapMedicationListCategoryOrder(
        { version: 1, view: "table", categoryOrder: ["VITAMIN", from] },
        new Map([[from, to]]),
      ),
    ).toEqual({ version: 1, view: "table", categoryOrder: ["VITAMIN", to] });
  });

  it("passes a blob through untouched without a remap or an order", () => {
    const blob = { version: 1, view: "cards" };
    expect(remapMedicationListCategoryOrder(blob, new Map([[from, to]]))).toBe(
      blob,
    );
    expect(remapMedicationListCategoryOrder(null, new Map([[from, to]]))).toBe(
      null,
    );
  });
});
