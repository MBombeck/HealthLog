/**
 * The catalogue's own invariants — the ones the compiler cannot state.
 *
 * The two `Record` types already force a group decision for every measurement
 * type and every structured leaf. What they cannot force is that each leaf has
 * a label a human can read, that the label resolves in the shipped bundle, and
 * that the fenced tier stays last. A leaf with no label renders as a raw enum
 * string on a clinical document.
 *
 * Mutation checks:
 *   - drop `PAIN_NRS` from `MEASUREMENT_LEAF_GROUP` → typecheck fails first,
 *     and with the type widened the count assertion goes red.
 *   - point `STRUCTURED_LEAF_LABEL_KEYS.MOOD` at a key that is not in the
 *     bundle → "resolves a label for every leaf" goes red naming MOOD.
 *   - move `"sensitive"` out of last place in `REPORT_GROUP_ORDER` → the order
 *     assertion goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_LEAF_IDS,
  MEASUREMENT_LEAF_IDS,
  REPORT_GROUPS,
  REPORT_GROUP_LABEL_KEYS,
  REPORT_GROUP_ORDER,
  SENSITIVE_GROUP_ID,
  SENSITIVE_LEAF_IDS,
  SHARE_GROUPS,
  STRUCTURED_LEAF_IDS,
  leafLabelKey,
  LEAF_MODULE,
  MEASUREMENT_LEAF_GROUP,
  reportMeasurementLabelKey,
} from "../catalogue";
import { STANDARD_TEMPLATE_LEAVES, standardTemplateFor } from "../template";

const EN = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "..", "messages", "en.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function labelOf(key: string): unknown {
  let node: unknown = EN;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function resolves(key: string): boolean {
  let node: unknown = EN;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node.length > 0;
}

describe("report selection catalogue", () => {
  it("carries every measurement type and every structured leaf", () => {
    expect(MEASUREMENT_LEAF_IDS).toHaveLength(90);
    expect(STRUCTURED_LEAF_IDS).toHaveLength(20);
    expect(ALL_LEAF_IDS).toHaveLength(110);
  });

  it("resolves a label for every leaf", () => {
    const unlabelled = ALL_LEAF_IDS.filter(
      (leaf) => !resolves(leafLabelKey(leaf)),
    );
    expect(
      unlabelled,
      "these leaves have no label in messages/en.json and would render as a " +
        "raw enum string on a clinical document",
    ).toEqual([]);
  });

  it("resolves a label for every group", () => {
    const unlabelled = REPORT_GROUP_ORDER.filter(
      (group) => !resolves(REPORT_GROUP_LABEL_KEYS[group]),
    );
    expect(unlabelled).toEqual([]);
  });

  it("orders the groups the way the panel and the PDF read them", () => {
    expect(REPORT_GROUPS.map((g) => g.id)).toEqual([...REPORT_GROUP_ORDER]);
    // The fenced tier is last, so it sits below every group control rather
    // than among them.
    expect(REPORT_GROUP_ORDER[REPORT_GROUP_ORDER.length - 1]).toBe("sensitive");
  });
});

/**
 * `SHARE_GROUPS` is what `GET /api/meta/capabilities` publishes as
 * `share.groups` — the membership a native client needs to mirror the
 * sensitive-tier fence itself. It is derived from `REPORT_GROUPS`, so these
 * checks are the invariant that makes that fence trustworthy: every leaf in
 * the flat `ALL_LEAF_IDS` set lands in exactly one group, no group carries a
 * leaf the flat set doesn't have, and exactly one group — the one whose id is
 * `SENSITIVE_GROUP_ID` — carries `sensitive: true`.
 *
 * Mutation check (verified red, then reverted): push a leaf into two groups
 * in `SHARE_GROUPS` by hand → the "exactly one group" assertion goes red
 * naming the duplicated leaf.
 */
describe("share-group membership (GET /api/meta/capabilities share.groups)", () => {
  it("covers exactly the flat leaf set, no leaf in more than one group", () => {
    const seen = new Set<string>();
    for (const group of SHARE_GROUPS) {
      for (const leaf of group.leaves) {
        expect(seen.has(leaf), `${leaf} appears in more than one group`).toBe(
          false,
        );
        seen.add(leaf);
      }
    }
    expect([...seen].sort()).toEqual([...ALL_LEAF_IDS].sort());
  });

  it("flags sensitive: true on exactly the fenced group", () => {
    const flagged = SHARE_GROUPS.filter((g) => g.sensitive);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.id).toBe(SENSITIVE_GROUP_ID);
  });

  it("orders groups and leaves identically to REPORT_GROUPS", () => {
    expect(SHARE_GROUPS.map((g) => g.id)).toEqual(
      REPORT_GROUPS.map((g) => g.id),
    );
    for (const [i, group] of SHARE_GROUPS.entries()) {
      expect(group.leaves).toEqual(REPORT_GROUPS[i]!.leaves);
    }
  });
});

describe("template purity", () => {
  it("keeps the shipped template clear of the fenced tier", () => {
    const overlap = STANDARD_TEMPLATE_LEAVES.filter((leaf) =>
      SENSITIVE_LEAF_IDS.includes(leaf),
    );
    expect(
      overlap,
      "the shipped template must never preselect a fenced leaf",
    ).toEqual([]);
  });

  it("names every template leaf in the catalogue", () => {
    const unknown = STANDARD_TEMPLATE_LEAVES.filter(
      (leaf) => !ALL_LEAF_IDS.includes(leaf),
    );
    expect(unknown).toEqual([]);
  });

  it("fences exactly the ten leaves the design names", () => {
    expect([...SENSITIVE_LEAF_IDS].sort()).toEqual(
      [
        "ANAMNESIS",
        "CYCLE",
        "FAMILY_HISTORY",
        "GAD7_SCORE",
        // v1.44 — mindful minutes and the State of Mind valence are
        // mental-health self-care and self-report.
        "MINDFUL_MINUTES",
        "STATE_OF_MIND_VALENCE",
        "MOOD",
        "PHQ9_SCORE",
        "SCI_SCORE",
        "WHO5_SCORE",
      ].sort(),
    );
  });
});

/**
 * The set behind the one-click action, checked as a set.
 *
 * The button is the only thing that applies the template now, so what it
 * applies has to be exactly the shipped list and nothing beside it — a leaf
 * that crept in here would land in a document the person believes they chose
 * from a named list.
 *
 * Mutation check (verified red, then reverted): make `standardTemplateFor`
 * ignore its argument → "drops only what the surface hides" goes red.
 */
describe("the standard-report action", () => {
  it("applies exactly the shipped set and nothing outside it", () => {
    expect(standardTemplateFor()).toEqual([...STANDARD_TEMPLATE_LEAVES]);
    const outside = standardTemplateFor().filter(
      (leaf) => !STANDARD_TEMPLATE_LEAVES.includes(leaf),
    );
    expect(outside).toEqual([]);
    // Nothing fenced, on any surface: the fence is not a matter of which
    // button you press.
    expect(
      standardTemplateFor().filter((leaf) => SENSITIVE_LEAF_IDS.includes(leaf)),
    ).toEqual([]);
  });

  it("drops only what the surface hides", () => {
    const onShare = standardTemplateFor(["INSURANCE"]);
    expect(onShare).not.toContain("INSURANCE");
    expect(onShare).toEqual(
      STANDARD_TEMPLATE_LEAVES.filter((leaf) => leaf !== "INSURANCE"),
    );
  });
});

describe("heart-rate variability in the report", () => {
  // Fitbit and Google Health file nightly HRV as RMSSD (migration 0420), so
  // for those accounts RMSSD is the only HRV the report can show. It is its
  // own cardio leaf beside SDNN, never folded into it, and like SDNN no
  // module gates it: a report with Recovery off must not lose the account's
  // only HRV series for the estimator its device reports.
  it("names the statistic on both rows, so the two never read as one series", () => {
    const sdnn = reportMeasurementLabelKey("HEART_RATE_VARIABILITY");
    const rmssd = reportMeasurementLabelKey("HRV_RMSSD");
    expect(sdnn).not.toBe(rmssd);
    expect(leafLabelKey("HEART_RATE_VARIABILITY")).toBe(sdnn);
    expect(labelOf(sdnn)).toBe("HRV (SDNN)");
    expect(labelOf(rmssd)).toBe("HRV (RMSSD)");
  });

  it("files SDNN and RMSSD as separate, ungated cardio leaves", () => {
    for (const type of ["HEART_RATE_VARIABILITY", "HRV_RMSSD"] as const) {
      expect(MEASUREMENT_LEAF_GROUP[type]).toBe("cardio");
      expect(LEAF_MODULE[type]).toBeUndefined();
    }
  });
});
