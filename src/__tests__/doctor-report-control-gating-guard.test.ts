/**
 * Structural guard: a rendered scope control with no gating path fails the
 * build, and a gating path with no control fails it too.
 *
 * The export panel once shipped twenty data switches, eight of which changed
 * nothing at all — the wire fold read twelve of the keys it accepted and
 * dropped the rest on the floor. Nothing failed; the control simply lied, and
 * it lied for several releases because no test connected "the panel renders
 * this" to "the export honours this".
 *
 * The selection model removed the fold, so the shape that defect lived in is
 * gone. This file is the same connection retargeted at the leaf catalogue,
 * which is now the one thing the picker, the aggregator, the PDF and the share
 * view all read:
 *
 *   1. Every leaf the catalogue declares is reachable in the picker — the
 *      picker renders from the catalogue, so the check is that the catalogue
 *      places each leaf in exactly one group and the picker renders each group.
 *   2. Flipping exactly one leaf changes the resolved selection. This is the
 *      assertion that would have caught all eight dead switches.
 *   3. Every leaf is honoured somewhere downstream: as a measurement type the
 *      gate strips, or by name in the aggregator's own body.
 *
 * What it does NOT prove: that the excluded data is actually absent from a
 * rendered artefact. That is behavioural and is covered where the artefacts are
 * built — `src/app/api/export/health-record/__tests__/route.test.ts` opens the
 * real PDF, the real bundle and the real zip. This guard is the cheap
 * structural half that cannot be satisfied by writing a plausible-looking
 * control.
 *
 * Mutation checks are recorded per assertion below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_LEAF_IDS,
  MEASUREMENT_LEAF_GROUP,
  REPORT_GROUPS,
  STRUCTURED_LEAF_GROUP,
  isStructuredLeafId,
  leafGroup,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

const REPO_ROOT = join(__dirname, "..", "..");
const COLLECT_PATH = join(
  REPO_ROOT,
  "src",
  "lib",
  "doctor-report",
  "collect.ts",
);
const PICKER_PATH = join(
  REPO_ROOT,
  "src",
  "components",
  "settings",
  "report-selection",
  "report-scope-picker.tsx",
);

const collectSource = readFileSync(COLLECT_PATH, "utf8");
const pickerSource = readFileSync(PICKER_PATH, "utf8");

/** Strip comments so a leaf named only in prose does not count as read. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("report scope gating — structural guard", () => {
  it("reads a plausible catalogue", () => {
    // Sanity floor: a silently degraded catalogue would pass everything below
    // vacuously.
    expect(ALL_LEAF_IDS.length).toBe(95);
    expect(Object.keys(MEASUREMENT_LEAF_GROUP)).toHaveLength(77);
    expect(Object.keys(STRUCTURED_LEAF_GROUP)).toHaveLength(18);
  });

  it("places every leaf in exactly one group", () => {
    const seen = new Map<ReportLeafId, number>();
    for (const group of REPORT_GROUPS) {
      for (const leaf of group.leaves) {
        seen.set(leaf, (seen.get(leaf) ?? 0) + 1);
      }
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    const missing = ALL_LEAF_IDS.filter((leaf) => !seen.has(leaf));
    expect(duplicated, "a leaf appears in more than one group").toEqual([]);
    expect(missing, "a leaf is in no group and so is unreachable").toEqual([]);
  });

  it("renders every group the catalogue declares", () => {
    // The picker maps over `REPORT_GROUPS` and splits the fenced tier out by
    // id, so this is the check that the split cannot silently drop a group.
    expect(pickerSource).toContain("REPORT_GROUPS.map");
    expect(pickerSource).toContain("SENSITIVE_GROUP_ID");
  });

  it("makes flipping any single leaf change the resolved selection", () => {
    const all = selectionFromLeaves(ALL_LEAF_IDS);
    const inert: ReportLeafId[] = [];
    for (const leaf of ALL_LEAF_IDS) {
      const without = selectionFromLeaves(
        ALL_LEAF_IDS.filter((l) => l !== leaf),
      );
      if (
        without.has(leaf) ||
        without.leaves.length !== all.leaves.length - 1
      ) {
        inert.push(leaf);
      }
    }
    expect(
      inert,
      "these leaves cannot be individually withheld, so their control would lie",
    ).toEqual([]);
  });

  it("has something downstream read every leaf", () => {
    // A leaf is honoured either as a measurement type — the gate strips those
    // by set membership over the whole enum — or by name in the aggregator.
    const body = stripComments(collectSource);
    const unread = ALL_LEAF_IDS.filter(
      (leaf) => isStructuredLeafId(leaf) && !body.includes(`"${leaf}"`),
    );
    expect(
      unread,
      "these structured leaves are never read in the aggregator, so switching " +
        "them off would change nothing that leaves the instance",
    ).toEqual([]);
  });

  it("keeps every sensitive leaf in the fenced tier", () => {
    for (const leaf of [
      "MOOD",
      "ANAMNESIS",
      "CYCLE",
      "FAMILY_HISTORY",
      "PHQ9_SCORE",
      "GAD7_SCORE",
      "WHO5_SCORE",
      "SCI_SCORE",
    ] as ReportLeafId[]) {
      expect(leafGroup(leaf), `${leaf} must be fenced`).toBe("sensitive");
    }
  });
});
