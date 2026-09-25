/**
 * The procedure search and the body-site facets, pinned.
 *
 * The body site is ciphertext at rest, so the only place a search over it can
 * run is here, after the decrypt. Three properties carry the feature:
 *
 *   - every word of the query has to be found, in the site or the reason, so
 *     "left knee" finds a procedure filed as site "Knee", side LEFT;
 *   - accents and case do not matter, because a person types "Hufte" on a
 *     keyboard without umlauts and still means "Hüfte";
 *   - the side filter is exact, so asking for the right side never returns the
 *     left one.
 *
 * Mutation checks (each run, each seen red):
 *   - match ANY token instead of EVERY token → "needs every word" goes red;
 *   - drop the diacritic fold in `normalizeSearchText` → the umlaut case goes
 *     red;
 *   - key the facet on the raw text instead of the folded text → "folds case
 *     and spacing into one site" goes red with two facets.
 */
import { describe, expect, it } from "vitest";

import {
  groupBodySites,
  matchesProcedureQuery,
  normalizeSearchText,
  type ProcedureSearchItem,
} from "../procedures";

const terms = (laterality: ProcedureSearchItem["laterality"]) =>
  laterality === "LEFT"
    ? ["left", "links"]
    : laterality === "RIGHT"
      ? ["right", "rechts"]
      : laterality === "BOTH"
        ? ["both", "beidseitig"]
        : [];

function item(
  bodySite: string | null,
  laterality: ProcedureSearchItem["laterality"] = null,
  reason: string | null = null,
): ProcedureSearchItem {
  return { bodySite, laterality, reason };
}

describe("normalizeSearchText", () => {
  it("folds case, accents and runs of whitespace", () => {
    expect(normalizeSearchText("  Hüfte   LINKS ")).toBe("hufte links");
  });
});

describe("matchesProcedureQuery", () => {
  it("matches everything when the query is empty", () => {
    expect(matchesProcedureQuery(item(null), {}, terms)).toBe(true);
    expect(matchesProcedureQuery(item("Knee"), { q: "   " }, terms)).toBe(true);
  });

  it("finds a word in the body site", () => {
    expect(matchesProcedureQuery(item("Left knee"), { q: "knee" }, terms)).toBe(
      true,
    );
  });

  it("finds a word in the reason when no site was typed", () => {
    expect(
      matchesProcedureQuery(
        item(null, null, "Knee arthroscopy"),
        { q: "arthroscopy" },
        terms,
      ),
    ).toBe(true);
  });

  it("finds the side word through the side field", () => {
    expect(
      matchesProcedureQuery(item("Knee", "LEFT"), { q: "left knee" }, terms),
    ).toBe(true);
    expect(
      matchesProcedureQuery(item("Knie", "LEFT"), { q: "Knie links" }, terms),
    ).toBe(true);
  });

  it("needs every word, not any word", () => {
    expect(
      matchesProcedureQuery(item("Knee", "RIGHT"), { q: "left knee" }, terms),
    ).toBe(false);
  });

  it("ignores accents on either side", () => {
    expect(matchesProcedureQuery(item("Hüfte"), { q: "hufte" }, terms)).toBe(
      true,
    );
    expect(matchesProcedureQuery(item("Hufte"), { q: "Hüfte" }, terms)).toBe(
      true,
    );
  });

  it("filters the side exactly", () => {
    expect(
      matchesProcedureQuery(
        item("Knee", "LEFT"),
        { laterality: "RIGHT" },
        terms,
      ),
    ).toBe(false);
    expect(
      matchesProcedureQuery(
        item("Knee", "RIGHT"),
        { laterality: "RIGHT" },
        terms,
      ),
    ).toBe(true);
    expect(
      matchesProcedureQuery(item("Knee", null), { laterality: "RIGHT" }, terms),
    ).toBe(false);
  });

  it("does not match a procedure with nothing to search when a query is set", () => {
    expect(matchesProcedureQuery(item(null), { q: "knee" }, terms)).toBe(false);
  });
});

describe("groupBodySites", () => {
  it("counts one facet per site and side", () => {
    const facets = groupBodySites([
      item("Knee", "LEFT"),
      item("Knee", "LEFT"),
      item("Knee", "RIGHT"),
      item("Gallbladder"),
      item(null),
    ]);
    expect(facets).toEqual([
      { bodySite: "Knee", laterality: "LEFT", count: 2 },
      { bodySite: "Knee", laterality: "RIGHT", count: 1 },
      { bodySite: "Gallbladder", laterality: null, count: 1 },
    ]);
  });

  it("folds case and spacing into one site, keeping the first spelling", () => {
    const facets = groupBodySites([
      item("Left knee "),
      item("left  knee"),
      item("LEFT KNEE"),
    ]);
    expect(facets).toEqual([
      { bodySite: "Left knee", laterality: null, count: 3 },
    ]);
  });
});
