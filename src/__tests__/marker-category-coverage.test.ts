/**
 * Every analyte the catalog can recognise by name has a catalog category.
 *
 * The labs list groups a marker without a panel by the analyte its name
 * resolves to (`catalogKeyForName`), and that analyte's panel comes from its
 * seed or, for an analyte with no seed, from `ALIAS_PANEL`. An alias key added
 * to `ANALYTE_ALIASES` or `LAB_NAME_ALIASES` without an `ALIAS_PANEL` entry
 * would put every marker of that analyte under "Other" without a word. This
 * holds the lists together.
 *
 * The check is a function of the alias table, so the guard proves it can
 * fail: the same check over the table minus one entry must name that entry.
 */
import { describe, expect, it } from "vitest";

import {
  ALIAS_PANEL,
  ANALYTE_ALIASES,
  BIOMARKER_CATALOG,
  BIOMARKER_PANELS,
  LAB_NAME_ALIASES,
  type BiomarkerPanelKey,
} from "@/lib/labs/biomarker-catalog";

function uncategorised(
  aliasPanel: Readonly<Record<string, BiomarkerPanelKey>>,
): { checked: number; missing: string[] } {
  const panels = new Set<string>(BIOMARKER_PANELS);
  const seedPanel = new Map(BIOMARKER_CATALOG.map((s) => [s.slug, s.panel]));
  const keys = new Set<string>([
    ...BIOMARKER_CATALOG.map((s) => s.slug),
    ...ANALYTE_ALIASES.map((a) => a.key),
    ...LAB_NAME_ALIASES.map((a) => a.key),
  ]);
  const missing: string[] = [];
  for (const key of keys) {
    const panel = seedPanel.get(key) ?? aliasPanel[key];
    if (panel === undefined || !panels.has(panel)) missing.push(key);
  }
  return { checked: keys.size, missing };
}

describe("marker category coverage", () => {
  it("gives every seed and alias key a catalog panel", () => {
    const { checked, missing } = uncategorised(ALIAS_PANEL);
    expect(checked).toBeGreaterThan(BIOMARKER_CATALOG.length);
    expect(missing).toEqual([]);
  });

  it("lists no alias panel for a key the catalog does not know", () => {
    const known = new Set<string>([
      ...ANALYTE_ALIASES.map((a) => a.key),
      ...LAB_NAME_ALIASES.map((a) => a.key),
    ]);
    const seeds = new Set(BIOMARKER_CATALOG.map((s) => s.slug));
    const stale = Object.keys(ALIAS_PANEL).filter(
      (key) => !known.has(key) || seeds.has(key),
    );
    expect(stale).toEqual([]);
  });

  it("fails when an alias panel entry is removed", () => {
    const [dropped] = Object.keys(ALIAS_PANEL);
    const reduced = Object.fromEntries(
      Object.entries(ALIAS_PANEL).filter(([key]) => key !== dropped),
    );
    expect(uncategorised(reduced).missing).toEqual([dropped]);
  });
});
