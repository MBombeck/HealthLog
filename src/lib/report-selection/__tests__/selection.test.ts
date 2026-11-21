/**
 * The selection type's contract: what each of the three minting functions does
 * with input it does not recognise, and that absence never becomes inclusion.
 *
 * Mutation checks:
 *   - make `selectionFromStoredBlob` fall back to `STANDARD_TEMPLATE_LEAVES`
 *     instead of the empty selection → "an unreadable blob resolves to
 *     nothing" goes red.
 *   - make `selectionFromRequest` drop unknown ids instead of rejecting →
 *     "a request naming an id this build does not know is refused" goes red.
 *   - drop the `.filter(isReportLeafId)` in `selectionFromStoredBlob` → "a
 *     stored blob naming a retired leaf drops it" goes red.
 */
import { describe, it, expect } from "vitest";

import {
  EMPTY_REPORT_SELECTION,
  isEmptySelection,
  selectionFromLeaves,
  selectionFromRequest,
  selectionFromStoredBlob,
  selectionToBlob,
} from "../selection";
import { ALL_LEAF_IDS } from "../catalogue";

describe("report selection", () => {
  it("treats absence as exclusion", () => {
    const selection = selectionFromLeaves(["WEIGHT"]);
    expect(selection.has("WEIGHT")).toBe(true);
    // Everything else in the catalogue is out, without anyone saying so.
    for (const leaf of ALL_LEAF_IDS) {
      if (leaf === "WEIGHT") continue;
      expect(selection.has(leaf)).toBe(false);
    }
  });

  it("orders leaves by the catalogue, not by the caller", () => {
    const selection = selectionFromLeaves(["LAB_RESULTS", "PULSE", "WEIGHT"]);
    const expected = ALL_LEAF_IDS.filter((leaf) =>
      ["LAB_RESULTS", "PULSE", "WEIGHT"].includes(leaf),
    );
    expect(selection.leaves).toEqual(expected);
  });

  it("refuses a request naming an id this build does not know", () => {
    const result = selectionFromRequest({
      v: 2,
      leaves: ["WEIGHT", "SOMETHING_NEW"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.unknownLeaves).toEqual(["SOMETHING_NEW"]);
    }
  });

  it("accepts a request naming only known ids", () => {
    const result = selectionFromRequest({ v: 2, leaves: ["WEIGHT"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selection.leaves).toEqual(["WEIGHT"]);
  });

  it("drops a retired leaf from a stored blob rather than failing", () => {
    const selection = selectionFromStoredBlob({
      v: 2,
      leaves: ["WEIGHT", "SOMETHING_RETIRED"],
    });
    expect(selection.leaves).toEqual(["WEIGHT"]);
  });

  it("resolves an unreadable blob to nothing, never to a default", () => {
    for (const raw of [
      null,
      undefined,
      {},
      { v: 1, leaves: ["WEIGHT"] },
      { bp: true, weight: true, pulse: true },
      "WEIGHT",
      [],
    ]) {
      const selection = selectionFromStoredBlob(raw);
      expect(isEmptySelection(selection), `blob ${JSON.stringify(raw)}`).toBe(
        true,
      );
    }
  });

  it("round-trips through the stored shape", () => {
    const selection = selectionFromLeaves(["WEIGHT", "LAB_RESULTS"]);
    const blob = selectionToBlob(selection);
    expect(selectionFromStoredBlob(blob).leaves).toEqual(selection.leaves);
  });

  it("has an empty selection that admits nothing", () => {
    expect(isEmptySelection(EMPTY_REPORT_SELECTION)).toBe(true);
    for (const leaf of ALL_LEAF_IDS) {
      expect(EMPTY_REPORT_SELECTION.has(leaf)).toBe(false);
    }
  });
});

describe("selectionFromSavedProfile", () => {
  it("reads the leaves of the profile the export writes", async () => {
    const { selectionFromSavedProfile } =
      await import("@/lib/report-selection/saved-profile");
    // The exact shape `POST /api/export/health-record` stores.
    const written = {
      v: 2,
      leaves: ["WEIGHT", "PULSE", "NOT_A_LEAF"],
      format: "pdf",
      rangeDays: 90,
      includeCharts: true,
    };
    expect(selectionFromSavedProfile(written).leaves).toEqual([
      "PULSE",
      "WEIGHT",
    ]);
    // A bare selection still reads; anything else is empty.
    expect(
      selectionFromSavedProfile({ v: 2, leaves: ["WEIGHT"] }).leaves,
    ).toEqual(["WEIGHT"]);
    expect(selectionFromSavedProfile({ sections: ["vitals"] }).leaves).toEqual(
      [],
    );
  });
});
