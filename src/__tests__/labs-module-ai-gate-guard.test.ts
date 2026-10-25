/**
 * Structural guard: no lab value reaches a model while the labs module is off.
 *
 * ## The failure this freezes
 *
 * The Coach snapshot carried a labs block "intentionally not module-gated", a
 * decision from before Labs could be switched off. Once it could, the Coach
 * prompt, its `get_labs` tool, the daily briefing, the biomarker status note,
 * the reaction line to a new panel and the MCP lab-trend prompt all kept
 * reading lab values for the model after the owner had turned the module
 * off, while the snapshot's own prelude promised that "the model never sees
 * a disabled domain". Each read was a separate module with its own
 * `prisma.labResult` query, and nothing tied them to the switch.
 *
 * ## What it proves and what it does not
 *
 * Every module under the paths that build model input (`src/lib/ai`,
 * `src/lib/insights`, `src/lib/jobs`, `src/lib/mcp`) that reads the lab
 * table either asks the labs module itself (`isModuleEnabled(…, "labs")`,
 * the `correlation:LAB_DRAWS` surface, or the MCP `whenModuleOn` wrapper) or
 * is listed below with the reason its read cannot reach a prompt. A new
 * reader fails here until it does one or the other. The data routes are not
 * in scope: a module decides what a model is given, not what the owner can
 * read (`CLAUDE.md`, "An AI capability gates model work").
 *
 * It is grep-shaped: it sees a read, not where the rows go, and a reader in
 * another directory is outside it. The behaviour is pinned per path by the
 * module-off cases in the suites of the readers themselves.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder, stripComments } from "./helpers/source-files";

const ROOTS = ["src/lib/ai", "src/lib/insights", "src/lib/jobs", "src/lib/mcp"];

/** A read of the lab table: the Prisma delegate or raw SQL naming it. */
const LAB_READ =
  /\.labResult\s*\.\s*(?:findMany|findFirst|findUnique|count|aggregate|groupBy)\s*\(|\blab_results\b/;

/** What counts as asking the labs module. */
const LABS_GATE =
  /isModuleEnabled\(\s*[\w.]+\s*,\s*"labs"\s*\)|"correlation:LAB_DRAWS"|whenModuleOn\(/;

/** Readers whose rows never reach a model, each with the reason. */
const NOT_MODEL_INPUT: Record<string, string> = {
  "src/lib/jobs/lab-biomarker-backfill.ts":
    "links stored rows to their biomarker; no model is involved",
  "src/lib/jobs/soft-delete-retention.ts":
    "purges rows past the trash window; no model is involved",
  "src/lib/insights/correlation-channel-series.ts":
    "`fetchLabDraws`: both callers gate it, the Coach on correlation:LAB_DRAWS and the correlations data route on the same surface",
  "src/lib/mcp/rich-reads.ts":
    "`getLabHistory`: reached only through the MCP get_labs tool, which runs behind whenModuleOn",
  "src/lib/ai/coach/tools/availability.ts":
    "counts lab rows for the Coach's empty-read answer; the only lab subject comes from get_labs, which answers module_disabled first",
};

function labReaders(): Array<{ path: string; gated: boolean }> {
  const out: Array<{ path: string; gated: boolean }> = [];
  for (const root of ROOTS) {
    for (const [rel, source] of readSourceFolder(root, {
      floor: 20,
      include: (r) =>
        !r.split("/").includes("__tests__") &&
        !/\.(?:test|spec)\.tsx?$/.test(r),
    })) {
      const code = stripComments(source);
      if (!LAB_READ.test(code)) continue;
      out.push({ path: `${root}/${rel}`, gated: LABS_GATE.test(code) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

describe("labs reach a model only with the labs module on", () => {
  const readers = labReaders();

  it("finds the readers it exists to check", () => {
    // An empty match set would pass every assertion below vacuously.
    expect(readers.length).toBeGreaterThanOrEqual(8);
    expect(readers.filter((r) => r.gated).length).toBeGreaterThanOrEqual(6);
  });

  it("every reader asks the labs module or is listed as not model input", () => {
    const open = readers
      .filter((r) => !r.gated && !(r.path in NOT_MODEL_INPUT))
      .map((r) => r.path);
    expect(open).toEqual([]);
  });

  it("lists no reader that has since gained the gate or gone", () => {
    const paths = new Map(readers.map((r) => [r.path, r.gated]));
    const stale = Object.keys(NOT_MODEL_INPUT).filter(
      (path) => paths.get(path) !== false,
    );
    expect(stale).toEqual([]);
  });

  it("the matchers catch what they exist to catch", () => {
    expect(LAB_READ.test("await prisma.labResult.findMany({")).toBe(true);
    expect(LAB_READ.test("tx.labResult\n  .count({")).toBe(true);
    expect(LAB_READ.test("SELECT 1 FROM lab_results")).toBe(true);
    expect(LAB_READ.test("prisma.labResultDocumentLink.findMany(")).toBe(false);
    expect(LABS_GATE.test('await isModuleEnabled(userId, "labs")')).toBe(true);
    expect(LABS_GATE.test('await isModuleEnabled(ctx.userId, "labs")')).toBe(
      true,
    );
    expect(LABS_GATE.test('isModuleEnabled(userId, "medications")')).toBe(
      false,
    );
  });
});
