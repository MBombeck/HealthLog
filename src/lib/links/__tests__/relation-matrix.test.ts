/**
 * The relation matrix has no dead ends.
 *
 * Six kinds of record (lab result, visit, document, condition, medication,
 * vaccination) make fifteen pairs. Each pair is either stored (a link table in
 * `LINK_TABLES`, readable from both ends, so both detail pages list the
 * other), derived (no table, a reader in `DERIVED_READERS` for both
 * directions), or a written exception with its reason. A pair with none of
 * the three is a place where the person reaches one record and cannot get to
 * the other, which is the class of defect this guards.
 *
 * Mutation check: delete the `"document:medication"` entry from `LINK_TABLES`
 * and the stored case names it; delete `"medication:labResult"` from
 * `DERIVED_READERS` and the derived case names it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DERIVED_READERS,
  RELATED_KIND_DOMAIN,
  RELATED_KIND_MODULE,
  RELATION_MATRIX,
  relationCell,
  type RelatedKind,
} from "@/lib/links/related";
import { RELATED_KINDS } from "@/lib/validations/relation-links";

const SERVICE = readFileSync(
  join(process.cwd(), "src", "lib", "links", "link-service.ts"),
  "utf8",
);

/** `LINK_TABLES` as `"from:to" → Prisma delegate`, read from the source. */
function linkTables(): Map<string, string> {
  const start = SERVICE.indexOf("const LINK_TABLES");
  expect(start).toBeGreaterThan(-1);
  const body = SERVICE.slice(start, SERVICE.indexOf("\n};", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(
    /"(\w+:\w+)":\s*\{\s*delegate:\s*\(tx\)\s*=>\s*narrow<LinkRowDelegate>\(\s*tx\.(\w+)\s*\)/g,
  )) {
    out.set(m[1], m[2]);
  }
  return out;
}

const KINDS = [...RELATED_KINDS] as RelatedKind[];

/**
 * Link sources that are not kinds of the matrix. An imaging exam (v1.50)
 * files its report and pictures and is read from its own page only.
 */
const OUTSIDE_MATRIX: ReadonlySet<string> = new Set(["imagingExam"]);

function pairs(): Array<[RelatedKind, RelatedKind]> {
  const out: Array<[RelatedKind, RelatedKind]> = [];
  for (let i = 0; i < KINDS.length; i++) {
    for (let j = i + 1; j < KINDS.length; j++) out.push([KINDS[i], KINDS[j]]);
  }
  return out;
}

describe("relation matrix", () => {
  const tables = linkTables();

  it("reads the link table and covers fifteen pairs", () => {
    // Non-vacuous: the matcher found the tables the service declares.
    expect(tables.size).toBeGreaterThanOrEqual(15);
    expect(pairs()).toHaveLength(15);
  });

  it("declares every pair exactly once", () => {
    const keys = Object.keys(RELATION_MATRIX);
    expect(keys).toHaveLength(15);
    for (const [a, b] of pairs()) {
      const forward = `${a}:${b}` in RELATION_MATRIX;
      const reverse = `${b}:${a}` in RELATION_MATRIX;
      expect(forward !== reverse, `${a} and ${b}`).toBe(true);
    }
  });

  it.each(pairs())("%s and %s are not a dead end", (a, b) => {
    const cell = relationCell(a, b);
    expect(cell, `${a}:${b} has no cell`).toBeDefined();
    if (!cell) return;
    if (cell.mode === "stored") {
      const forward = tables.get(`${a}:${b}`);
      const reverse = tables.get(`${b}:${a}`);
      expect(forward, `LINK_TABLES lacks ${a}:${b}`).toBeDefined();
      expect(reverse, `LINK_TABLES lacks ${b}:${a}`).toBeDefined();
      // Both directions read ONE table, so the two pages cannot disagree.
      expect(forward).toBe(reverse);
    } else if (cell.mode === "derived") {
      expect(DERIVED_READERS[`${a}:${b}`], `no reader ${a}:${b}`).toBeDefined();
      expect(DERIVED_READERS[`${b}:${a}`], `no reader ${b}:${a}`).toBeDefined();
      // A derived pair has no table on purpose; one appearing means the cell
      // is stale.
      expect(tables.has(`${a}:${b}`)).toBe(false);
    } else {
      expect(cell.reason.length, `${a}:${b} reason`).toBeGreaterThan(40);
      expect(tables.has(`${a}:${b}`) || tables.has(`${b}:${a}`)).toBe(false);
    }
  });

  it("every link table is a pair of the matrix", () => {
    for (const key of tables.keys()) {
      const [a, b] = key.split(":") as [RelatedKind, RelatedKind];
      // A record that files documents but is read only from its own page
      // (an imaging exam) sits outside the matrix by decision, named here.
      if (OUTSIDE_MATRIX.has(a) || OUTSIDE_MATRIX.has(b)) continue;
      expect(relationCell(a, b)?.mode, key).toBe("stored");
    }
  });

  it("names every link source outside the matrix on purpose", () => {
    const sources = new Set([...tables.keys()].map((k) => k.split(":")[0]));
    const outside = [...sources].filter(
      (kind) => !KINDS.includes(kind as RelatedKind),
    );
    expect(outside.sort()).toEqual([...OUTSIDE_MATRIX].sort());
  });

  it("the five v1.43 tables close their pairs", () => {
    const delegates = new Set(tables.values());
    for (const delegate of [
      "labResultDocumentLink",
      "encounterMedicationLink",
      "encounterVaccinationLink",
      "medicationDocumentLink",
      "medicationConditionLink",
    ]) {
      expect(delegates.has(delegate), delegate).toBe(true);
    }
  });

  it("names a module and a sharing section for every kind", () => {
    for (const kind of KINDS) {
      expect(kind in RELATED_KIND_MODULE, kind).toBe(true);
      expect(RELATED_KIND_DOMAIN[kind], kind).toBeTruthy();
    }
  });
});
