import { describe, expect, it } from "vitest";

import { foldForMatch } from "@/lib/i18n/fold-for-match";

import { catalogKeyForName, catalogNameIndex } from "../analyte-match";
import { ANALYTE_ALIASES, LAB_NAME_ALIASES } from "../biomarker-catalog";
import {
  addAliasToIndex,
  matchForReview,
  nameSimilarity,
  resolveInIndex,
  suggestInIndex,
  type IndexedMarker,
  type MarkerIndex,
} from "../biomarker-resolve";

let seq = 0;
function marker(
  name: string,
  unit: string,
  extra: Partial<IndexedMarker> = {},
) {
  seq += 1;
  return {
    id: `bm-${seq}`,
    name,
    unit,
    lowerBound: null,
    upperBound: null,
    panel: null,
    analyteKey: null,
    hidden: false,
    createdAt: new Date(Date.UTC(2026, 0, seq)),
    ...extra,
  } satisfies IndexedMarker;
}

function index(
  markers: IndexedMarker[],
  aliases: Array<{ biomarkerId: string; name: string }> = [],
): MarkerIndex {
  return {
    markers,
    aliases: aliases.map((a) => ({ ...a, nameFolded: foldForMatch(a.name) })),
  };
}

describe("the catalog's shorthand (D1223)", () => {
  it.each([
    ["Alk.P", "alkaline-phosphatase"],
    ["Alk Phos", "alkaline-phosphatase"],
    ["ALP", "alkaline-phosphatase"],
    ["Alkalische Phosphatase (AP)", "alkaline-phosphatase"],
    ["T.Bili", "bilirubin-total"],
    ["T. Bili", "bilirubin-total"],
    ["TBIL", "bilirubin-total"],
    ["Bilirubin gesamt", "bilirubin-total"],
    ["GPT", "alt"],
    ["ALAT", "alt"],
    ["AST(SGOT)", "ast"],
    ["GOT", "ast"],
    ["γ-GT", "ggt"],
    ["Gamma-GT", "ggt"],
    ["GGTP", "ggt"],
    ["LDH", "ldh"],
    ["CRP", "crp"],
    ["hsCRP", "hs-crp"],
    ["TSH basal", "tsh"],
    ["fT3", "ft3"],
    ["T4L", "ft4"],
    ["HbA1c", "hba1c"],
    ["eGFR", "egfr"],
    ["Hb", "hemoglobin"],
    ["Hkt", "hematocrit"],
    ["MCV", "mcv"],
    ["PLT", "platelets"],
    ["Leuko", "wbc"],
    ["Krea", "creatinine"],
    ["25(OH)D", "vitamin-d"],
    ["Ferr", "ferritin"],
    ["B12", "vitamin-b12"],
  ])("%s is %s", (name, key) => {
    expect(catalogKeyForName(name)).toBe(key);
  });

  it.each([
    ["Bilirubin (Total)", "bilirubin-total"],
    ["Kreatinin (Serum)", "creatinine"],
    ["GPT (ALT)", "alt"],
  ])("%s, with its parenthetical, is %s", (name, key) => {
    expect(catalogKeyForName(name)).toBe(key);
  });

  it.each([
    ["PCR"],
    ["TG"],
    ["T3"],
    ["T4"],
    ["Cr"],
    ["Calcitriol"],
    ["LDL-P"],
    ["Calcium (ionisiert)"],
    ["Glucose (urine)"],
    ["GPT (AST)"],
  ])("%s is no catalog name (ambiguous or another test)", (name) => {
    expect(catalogKeyForName(name)).toBeNull();
  });

  it("keeps the standard and the high-sensitivity CRP apart", () => {
    expect(catalogKeyForName("CRP")).not.toBe(catalogKeyForName("hs-CRP"));
  });

  it("writes every name already folded", () => {
    for (const { key, names } of [...ANALYTE_ALIASES, ...LAB_NAME_ALIASES]) {
      for (const name of names) {
        expect(foldForMatch(name), `${key}: ${name}`).toBe(name);
      }
    }
  });

  it("has no name that two analytes claim", () => {
    expect(catalogNameIndex().ambiguous).toEqual([]);
  });
});

describe("resolveInIndex", () => {
  it("resolves the marker's own name, case aside", () => {
    const ldl = marker("LDL", "mg/dL");
    expect(resolveInIndex(index([ldl]), "ldl")).toEqual({
      marker: ldl,
      matchKind: "name",
    });
  });

  it("prefers the exact spelling over a case variant", () => {
    const a = marker("ldl", "mg/dL");
    const b = marker("LDL", "mg/dL");
    expect(resolveInIndex(index([a, b]), "LDL")?.marker).toBe(b);
  });

  it("resolves an alias of the account, folded", () => {
    const alp = marker("Alkaline Phosphatase", "U/L");
    const found = resolveInIndex(
      index([alp], [{ biomarkerId: alp.id, name: "Alk.P" }]),
      "ALK.P",
    );
    expect(found).toEqual({ marker: alp, matchKind: "alias" });
  });

  it("resolves a catalog abbreviation to the account's marker of that analyte", () => {
    const alp = marker("Alkaline Phosphatase", "U/L");
    expect(resolveInIndex(index([alp]), "Alk.P", "U/L")).toEqual({
      marker: alp,
      matchKind: "catalog",
    });
    // The discussion's own pair: a marker named with a neutral qualifier.
    const bili = marker("Bilirubin (Total)", "mg/dL");
    expect(resolveInIndex(index([bili]), "T.Bili", "mg/dL")).toEqual({
      marker: bili,
      matchKind: "catalog",
    });
  });

  it("recognises a marker by one of its aliases' catalog analyte", () => {
    const liver = marker("Leberwert 1", "U/L");
    const found = resolveInIndex(
      index([liver], [{ biomarkerId: liver.id, name: "ALT" }]),
      "GPT",
      "U/L",
    );
    expect(found).toEqual({ marker: liver, matchKind: "catalog" });
  });

  it("converts across units in the catalog step where the registry can", () => {
    const glucose = marker("Glucose", "mg/dL", {
      analyteKey: "fasting-glucose",
    });
    expect(
      resolveInIndex(index([glucose]), "Blutzucker", "mmol/L")?.marker,
    ).toBe(glucose);
  });

  it("steps aside in the catalog step for a unit it cannot reconcile", () => {
    const alt = marker("ALT", "U/L");
    expect(resolveInIndex(index([alt]), "GPT", "µkat/L")).toBeNull();
    // A qualitative reading or none stated always fits.
    expect(resolveInIndex(index([alt]), "GPT", null)?.marker).toBe(alt);
  });

  it("lets the name and the alias win regardless of the unit", () => {
    const alt = marker("ALT", "U/L");
    expect(resolveInIndex(index([alt]), "ALT", "µkat/L")?.matchKind).toBe(
      "name",
    );
    expect(
      resolveInIndex(
        index([alt], [{ biomarkerId: alt.id, name: "Leber ALT" }]),
        "Leber ALT",
        "µkat/L",
      )?.matchKind,
    ).toBe("alias");
  });

  it("prefers a visible marker over a hidden one in the catalog step", () => {
    const hidden = marker("ALT", "U/L", { hidden: true });
    const visible = marker("GPT (ALT)", "U/L");
    expect(
      resolveInIndex(index([hidden, visible]), "SGPT", "U/L")?.marker,
    ).toBe(visible);
  });

  it("resolves nothing for an unknown name", () => {
    expect(resolveInIndex(index([marker("ALT", "U/L")]), "Zinc")).toBeNull();
    expect(resolveInIndex(index([]), "   ")).toBeNull();
  });

  it("sees an alias added after the index was loaded", () => {
    const tsh = marker("TSH", "mIU/L");
    const idx = index([tsh]);
    addAliasToIndex(idx, tsh.id, "Thyreotropes Hormon");
    expect(resolveInIndex(idx, "thyreotropes hormon")?.matchKind).toBe("alias");
  });
});

describe("suggestions", () => {
  it("offers the same analyte first when its unit kept it from matching", () => {
    const alt = marker("ALT", "U/L");
    const { match, suggestions } = matchForReview(
      index([alt, marker("AST", "U/L")]),
      "GPT",
      "µkat/L",
    );
    expect(match).toBeNull();
    expect(suggestions[0]).toEqual({
      biomarkerId: alt.id,
      name: "ALT",
      unit: "U/L",
      matchKind: "catalog",
    });
  });

  it("offers similar names through the catalog's names for the marker", () => {
    const bili = marker("T.Bili", "mg/dL");
    const suggestions = suggestInIndex(index([bili]), "Bilirubin ges.");
    expect(suggestions).toEqual([
      {
        biomarkerId: bili.id,
        name: "T.Bili",
        unit: "mg/dL",
        matchKind: "similar",
      },
    ]);
  });

  it("offers shorthand against a full name", () => {
    const alp = marker("Alkaline Phosphatase", "U/L");
    expect(suggestInIndex(index([alp]), "Alk. Phosph.")[0]?.biomarkerId).toBe(
      alp.id,
    );
  });

  it("offers at most three and never a hidden marker", () => {
    const markers = [
      marker("Vitamin B1", "µg/L"),
      marker("Vitamin B2", "µg/L"),
      marker("Vitamin B6", "µg/L"),
      marker("Vitamin B9", "µg/L"),
      marker("Vitamin B3", "µg/L", { hidden: true }),
    ];
    const suggestions = suggestInIndex(index(markers), "Vitamin B5");
    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((s) => s.name)).not.toContain("Vitamin B3");
  });

  it("offers nothing unrelated and nothing when the name matched", () => {
    const ldl = marker("LDL", "mg/dL");
    expect(suggestInIndex(index([ldl]), "Ferritin")).toEqual([]);
    expect(matchForReview(index([ldl]), "LDL").suggestions).toEqual([]);
  });

  it("scores names", () => {
    expect(nameSimilarity("Ferritin", "ferritin")).toBe(1);
    expect(nameSimilarity("alk phos", "alkaline phosphatase")).toBe(0.8);
    expect(nameSimilarity("LDL", "Ferritin")).toBeLessThan(0.5);
  });
});

describe("a catalog hint from the source (#1400)", () => {
  it("matches a marker by the hinted analyte when the name says nothing", () => {
    const ldl = marker("LDL", "mg/dL");
    const idx = index([ldl]);
    const name =
      "Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation";
    expect(resolveInIndex(idx, name, "mmol/L")).toBeNull();
    expect(
      resolveInIndex(idx, name, "mmol/L", { catalogKey: "ldl" }),
    ).toMatchObject({ marker: { id: ldl.id }, matchKind: "catalog" });
  });

  it("still steps aside for a unit the marker cannot take", () => {
    const ldl = marker("LDL", "mg/dL");
    expect(
      resolveInIndex(index([ldl]), "LDL calc", "U/L", { catalogKey: "ldl" }),
    ).toBeNull();
  });

  it("lets the account's own name win over the hint", () => {
    const own = marker("Odd name", "mmol/L");
    const ldl = marker("LDL", "mg/dL");
    expect(
      resolveInIndex(index([own, ldl]), "odd name", "mmol/L", {
        catalogKey: "ldl",
      }),
    ).toMatchObject({ marker: { id: own.id }, matchKind: "name" });
  });
});
