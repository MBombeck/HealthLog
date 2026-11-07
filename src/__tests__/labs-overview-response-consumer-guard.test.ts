/**
 * Per-envelope response/consumer guard for the labs categories.
 *
 * The registered Zod schemas are the producer: `LabOverviewResponse`
 * (`GET /api/labs/overview`), `ListBiomarkersResponse` (`GET /api/biomarkers`)
 * and `BiomarkerMergeResult` (`POST /api/biomarkers/{id}/merge`). Every leaf
 * of the parts this guard owns is walked out of the schema itself and must be
 * tied to the web reader that renders it, or to a named exemption with its
 * reason. A leaf added to a schema without either fails, so a field cannot
 * ship write-only. Matchers are qualified (`category.status`, not `status`),
 * so another response's field of the same name cannot satisfy them.
 *
 * Scope: the category fields and their two companions. The overview's
 * `markers` subtree predates this guard and is read through `LabResultDto`;
 * it is exempt as a whole, by name.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";

import {
  biomarkerListResponse,
  biomarkerMergeResult,
} from "@/lib/openapi/routes/biomarkers";
import { labOverviewResponse } from "@/lib/openapi/routes/labs";

import { readSource } from "./helpers/source-files";

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  in?: z.ZodType;
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/** Leaf paths of a schema: `a.b`, arrays as `a[]`. */
function leaves(schema: z.ZodType, prefix: string): string[] {
  const def = defOf(schema);
  if (def.type === "object" && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) =>
      leaves(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  if (def.type === "array" && def.element) {
    return leaves(def.element, `${prefix}[]`);
  }
  const inner = def.innerType ?? def.in;
  if (inner) return leaves(inner, prefix);
  return [prefix];
}

interface Reader {
  file: string;
  pattern: RegExp;
}

const LIST = "src/components/labs/lab-list.tsx";
const GROUPS = "src/components/labs/lab-list-groups.tsx";
const FORM_PANEL = "src/components/labs/biomarker-panel-field.tsx";
const MERGE_SHEET = "src/components/labs/biomarker-merge-sheet.tsx";

const COUNTS_DESTRUCTURE = (name: string) =>
  new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*category\\.counts\\b`);

const READERS: Record<string, Reader> = {
  "overview:grouped": { file: LIST, pattern: /\bdata\?\.grouped\b/ },
  "overview:categories[].key": { file: GROUPS, pattern: /\bcategory\.key\b/ },
  "overview:categories[].label": {
    file: GROUPS,
    pattern: /\{category\.label\}/,
  },
  "overview:categories[].markerKeys[]": {
    file: GROUPS,
    pattern: /\bof\s+category\.markerKeys\b/,
  },
  "overview:categories[].counts.inRange": {
    file: GROUPS,
    pattern: COUNTS_DESTRUCTURE("inRange"),
  },
  "overview:categories[].counts.below": {
    file: GROUPS,
    pattern: COUNTS_DESTRUCTURE("below"),
  },
  "overview:categories[].counts.above": {
    file: GROUPS,
    pattern: COUNTS_DESTRUCTURE("above"),
  },
  "overview:categories[].counts.unknown": {
    file: GROUPS,
    pattern: COUNTS_DESTRUCTURE("unknown"),
  },
  "overview:categories[].status": {
    file: GROUPS,
    pattern: /\bcategory\.status\s*===\s*"above"/,
  },
  "biomarkers:customPanels[]": {
    file: FORM_PANEL,
    pattern: /\bdata\?\.customPanels\b/,
  },
  "merge:adoptedPanel": {
    file: MERGE_SHEET,
    pattern: /\bpreview\.adoptedPanel\b/,
  },
};

/** Leaves this guard does not own, with the reason. Prefix match on `[]`. */
const EXEMPT: Record<string, string> = {
  "overview:markers[]":
    "the per-marker rows predate the categories and are rendered through LabResultDto in lab-list-rows.tsx",
};

function ownedLeaves(): string[] {
  const overview = leaves(labOverviewResponse, "").map((l) => `overview:${l}`);
  const list = leaves(biomarkerListResponse, "")
    .filter((l) => l.startsWith("customPanels"))
    .map((l) => `biomarkers:${l}`);
  const merge = leaves(biomarkerMergeResult, "")
    .filter((l) => l === "adoptedPanel")
    .map((l) => `merge:${l}`);
  return [...overview, ...list, ...merge];
}

function isExempt(leaf: string): boolean {
  return Object.keys(EXEMPT).some((prefix) => leaf.startsWith(prefix));
}

describe("labs categories response/consumer guard", () => {
  const owned = ownedLeaves();

  it("walks the schemas it guards", () => {
    // Nine category leaves, `grouped`, the panels and the adopted panel, plus
    // the exempt marker rows; far fewer means the walk broke.
    expect(owned.filter((leaf) => !isExempt(leaf)).length).toBe(
      Object.keys(READERS).length,
    );
    expect(owned.filter(isExempt).length).toBeGreaterThan(10);
  });

  it("ties every leaf to a reader or a named exemption", () => {
    const orphans = owned.filter((leaf) => !isExempt(leaf) && !READERS[leaf]);
    expect(orphans).toEqual([]);
    const stale = Object.keys(READERS).filter((leaf) => !owned.includes(leaf));
    expect(stale).toEqual([]);
  });

  for (const [leaf, reader] of Object.entries(READERS)) {
    it(`${leaf} is read in ${reader.file}`, () => {
      // `readSource` throws when the anchor is gone from the file.
      const source = readSource(reader.file, reader.pattern);
      expect(reader.pattern.test(source)).toBe(true);
    });
  }

  it("cannot pass on a reader that reads nothing", () => {
    expect(
      COUNTS_DESTRUCTURE("inRange").test("const { below } = category.counts;"),
    ).toBe(false);
    expect(READERS["overview:grouped"].pattern.test("data?.groupedX")).toBe(
      false,
    );
  });
});
