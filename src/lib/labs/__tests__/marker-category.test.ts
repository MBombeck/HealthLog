import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { labelIn } from "@/lib/i18n/localised-label-index";
import type { ReferenceRangeStatus } from "@/lib/labs/reference-range";

import { ALIAS_PANEL, BIOMARKER_PANELS } from "../biomarker-catalog";
import {
  categoriseOverview,
  customCategoryLabel,
  customPanelSuggestions,
  resolveMarkerCategory,
  summariseCategory,
  type CategorisableMarker,
} from "../marker-category";

function marker(
  key: string,
  analyte: string,
  panel: string | null,
  rangeStatus: ReferenceRangeStatus = "in-range",
): CategorisableMarker {
  return { key, latest: { analyte, panel, rangeStatus } };
}

describe("resolveMarkerCategory", () => {
  it("folds every catalog panel label in every locale to its key", () => {
    let checked = 0;
    for (const key of BIOMARKER_PANELS) {
      for (const locale of locales) {
        const label = labelIn(locale, `labs.catalog.panel.${key}`);
        expect(label, `${locale} labs.catalog.panel.${key}`).not.toBeNull();
        for (const spelling of [label!, label!.toUpperCase(), ` ${label} `]) {
          expect(resolveMarkerCategory({ panel: spelling, name: "x" })).toEqual(
            { key, kind: "builtin" },
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBe(BIOMARKER_PANELS.length * locales.length * 3);
  });

  it("keys the person's own panel by a hash that ignores case and spacing", () => {
    const a = resolveMarkerCategory({ panel: "Großes Blutbild", name: "x" });
    const b = resolveMarkerCategory({ panel: "großes  BLUTBILD", name: "y" });
    const c = resolveMarkerCategory({ panel: "Kleines Blutbild", name: "x" });
    expect(a.kind).toBe("custom");
    expect(a.key).toMatch(/^custom:[0-9a-f]{12}$/);
    expect(a.key).not.toContain("Blutbild");
    expect(b.key).toBe(a.key);
    expect(c.key).not.toBe(a.key);
  });

  it("lets the person's panel win over the name's catalog panel", () => {
    expect(
      resolveMarkerCategory({ panel: "Annual check", name: "LDL" }).kind,
    ).toBe("custom");
  });

  it("falls back to the catalog panel of the name, glosses included", () => {
    expect(resolveMarkerCategory({ panel: null, name: "LDL" })).toEqual({
      key: "lipids",
      kind: "builtin",
    });
    expect(resolveMarkerCategory({ panel: "  ", name: "TSH" }).key).toBe(
      "thyroid",
    );
    expect(
      resolveMarkerCategory({ panel: null, name: "Bilirubin (Total)" }).key,
    ).toBe("liver");
  });

  it("places each of the ten seedless alias keys", () => {
    const names: Record<string, string> = {
      urea: "Harnstoff",
      "blood-urea-nitrogen": "BUN",
      "uric-acid": "Harnsäure",
      ldh: "LDH",
      "calcium-total": "Calcium",
      crp: "CRP",
      rbc: "Erythrozyten",
      mcv: "MCV",
      mch: "MCH",
      mchc: "MCHC",
    };
    expect(Object.keys(names).sort()).toEqual(Object.keys(ALIAS_PANEL).sort());
    for (const [key, name] of Object.entries(names)) {
      expect(
        resolveMarkerCategory({ panel: null, name }).key,
        `${name} (${key})`,
      ).toBe(ALIAS_PANEL[key]);
    }
  });

  it("puts an unknown name without a panel under other", () => {
    expect(
      resolveMarkerCategory({ panel: null, name: "Something rare" }),
    ).toEqual({ key: "other", kind: "other" });
  });
});

describe("summariseCategory", () => {
  it.each<[ReferenceRangeStatus[], ReferenceRangeStatus]>([
    [["below", "above", "in-range"], "above"],
    [["below", "in-range"], "below"],
    [["unknown", "unknown"], "unknown"],
    [["unknown", "in-range"], "in-range"],
    [[], "unknown"],
  ])("%j -> %s", (statuses, status) => {
    expect(summariseCategory(statuses).status).toBe(status);
  });

  it("counts each status", () => {
    expect(
      summariseCategory(["in-range", "below", "above", "above", "unknown"])
        .counts,
    ).toEqual({ inRange: 1, below: 1, above: 2, unknown: 1 });
  });
});

describe("customCategoryLabel", () => {
  it("takes the most frequent spelling, ties to the smallest", () => {
    expect(customCategoryLabel(["Check", "check", "check"])).toBe("check");
    expect(customCategoryLabel(["b panel", "a panel"])).toBe("a panel");
    expect(customCategoryLabel(["a panel", "b panel"])).toBe("a panel");
  });
});

describe("customPanelSuggestions", () => {
  it("lists own panels once per fold and leaves catalog panels out", () => {
    expect(
      customPanelSuggestions([
        "Lipide",
        "Annual check",
        "annual  check",
        "Annual check",
        null,
        "",
        "Hormones",
      ]),
    ).toEqual(["Annual check", "Hormones"]);
  });
});

describe("categoriseOverview", () => {
  it("orders catalog panels by catalog, then own panels by label, then other", () => {
    const { categories, grouped } = categoriseOverview(
      [
        marker("bm:1", "Mystery", null),
        marker("bm:2", "TSH", null, "above"),
        marker("bm:3", "Zinc", "Trace elements"),
        marker("bm:4", "LDL", "Lipids", "below"),
        marker("bm:5", "HDL", "Lipide"),
        marker("bm:6", "Cortisol", "Hormones", "unknown"),
      ],
      "en",
    );
    expect(grouped).toBe(true);
    expect(categories.map((c) => c.label)).toEqual([
      "Lipids",
      "Thyroid",
      "Hormones",
      "Trace elements",
      "Other",
    ]);
    const lipids = categories[0];
    expect(lipids.key).toBe("lipids");
    expect(lipids.markerKeys).toEqual(["bm:4", "bm:5"]);
    expect(lipids.counts).toEqual({
      inRange: 1,
      below: 1,
      above: 0,
      unknown: 0,
    });
    expect(lipids.status).toBe("below");
    expect(categories[1].status).toBe("above");
    expect(categories[2].status).toBe("unknown");
    expect(categories[2].key).toMatch(/^custom:/);
  });

  it("labels catalog panels and other in the requested locale", () => {
    const { categories } = categoriseOverview(
      [marker("a", "LDL", null), marker("b", "Mystery", null)],
      "de",
    );
    expect(categories.map((c) => c.label)).toEqual(["Lipide", "Sonstige"]);
  });

  it("keeps a custom label stable however the newest reading is spelled", () => {
    const { categories } = categoriseOverview(
      [
        marker("a", "x", "annual CHECK"),
        marker("b", "y", "Annual check"),
        marker("c", "z", "Annual check"),
      ],
      "en",
    );
    expect(categories).toHaveLength(1);
    expect(categories[0].label).toBe("Annual check");
  });

  it("groups only when it adds something", () => {
    expect(categoriseOverview([], "en").grouped).toBe(false);
    expect(
      categoriseOverview(
        [marker("a", "LDL", null), marker("b", "HDL", null)],
        "en",
      ).grouped,
    ).toBe(false);
    expect(
      categoriseOverview(
        [marker("a", "Mystery", null), marker("b", "Unknown", null)],
        "en",
      ).grouped,
    ).toBe(false);
    expect(
      categoriseOverview(
        [marker("a", "LDL", null), marker("b", "Mystery", null)],
        "en",
      ).grouped,
    ).toBe(true);
  });
});
