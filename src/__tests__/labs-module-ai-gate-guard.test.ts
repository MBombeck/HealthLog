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
 * Every lab read under the paths that build model input (`src/lib/ai`,
 * `src/lib/insights`, `src/lib/jobs`, `src/lib/mcp`) either sits in a
 * function that asks the labs module itself (`isModuleEnabled(…, "labs")`,
 * the `correlation:LAB_DRAWS` surface, or the MCP `whenModuleOn(…, "labs")`
 * wrapper), or sits in a private helper of its file whose every caller in
 * that file does, or is listed below by file and function with the reason
 * its rows cannot reach a prompt. A new reader fails here until it does one
 * of those. The data routes are not in scope: a module decides what a model
 * is given, not what the owner can read (`CLAUDE.md`, "An AI capability
 * gates model work").
 *
 * The check is per read, not per file. It used to ask whether a file that
 * reads the table mentions the gate anywhere, so one ungated read in a file
 * with a gated one passed, and `whenModuleOn` for any module counted as the
 * labs gate. It still sees a read and the function around it, not where the
 * rows go: a gate in the function is taken to cover the read, and a reader
 * in another directory is outside it. The behaviour is pinned per path by
 * the module-off cases in the suites of the readers themselves.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { readSourceFolder, stripComments } from "./helpers/source-files";

const ROOTS = ["src/lib/ai", "src/lib/insights", "src/lib/jobs", "src/lib/mcp"];

const READ_METHODS = new Set([
  "findMany",
  "findFirst",
  "findUnique",
  "count",
  "aggregate",
  "groupBy",
]);

/** Raw SQL naming the lab table. */
const LAB_TABLE = /\blab_results\b/;

/** What counts as asking the labs module. */
const LABS_GATE =
  /isModuleEnabled\(\s*[\w.]+\s*,\s*"labs"\s*\)|"correlation:LAB_DRAWS"|whenModuleOn\(\s*[\w.]+\s*,\s*"labs"/;

/**
 * Reads whose rows never reach a model, by `file#top-level name`, each with
 * the reason.
 */
const NOT_MODEL_INPUT: Record<string, string> = {
  "src/lib/jobs/lab-biomarker-backfill.ts#runLabBiomarkerBackfillForUser":
    "links stored rows to their biomarker; no model is involved",
  "src/lib/jobs/lab-biomarker-backfill.ts#enqueueBootTimeLabBiomarkerBackfill":
    "finds the accounts whose rows need linking; no model is involved",
  "src/lib/jobs/lab-document-date-repair.ts#candidateQuery":
    "finds document lab values filed at their confirmation moment to re-date them; no model is involved",
  "src/lib/jobs/soft-delete-retention.ts#SOFT_DELETE_RETENTION":
    "purges rows past the trash window; no model is involved",
  "src/lib/insights/correlation-channel-series.ts#fetchLabDraws":
    "both callers gate it, the Coach on correlation:LAB_DRAWS and the correlations data route on the same surface",
  "src/lib/mcp/rich-reads.ts#getLabHistory":
    'reached only through the MCP get_labs tool, which runs behind whenModuleOn(ctx, "labs")',
  "src/lib/ai/coach/tools/availability.ts#readTableBounds":
    "counts lab rows for the Coach's empty-read answer; the only lab subject comes from get_labs, which answers module_disabled first",
  "src/lib/ai/coach/tools/availability.ts#holdsRowsBefore":
    "whether lab rows predate the lookback, for the same empty-read answer and the same get_labs subject",
};

type FunctionNode = ts.SignatureDeclaration & { body?: ts.Node };

function isReadCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!READ_METHODS.has(callee.name.text)) return false;
  const target = callee.expression;
  return (
    ts.isPropertyAccessExpression(target) && target.name.text === "labResult"
  );
}

function isTableLiteral(node: ts.Node): boolean {
  return (
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) &&
    LAB_TABLE.test(node.text)
  );
}

function enclosingFunctions(node: ts.Node): FunctionNode[] {
  const out: FunctionNode[] = [];
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) out.push(at as FunctionNode);
  }
  return out;
}

/** The statement directly under the file that holds `node`. */
function topLevelStatement(node: ts.Node): ts.Statement | null {
  let at: ts.Node = node;
  while (at.parent && !ts.isSourceFile(at.parent)) at = at.parent;
  return at.parent ? (at as ts.Statement) : null;
}

function declaredName(statement: ts.Statement): string | null {
  if (ts.isFunctionDeclaration(statement)) return statement.name?.text ?? null;
  if (ts.isVariableStatement(statement)) {
    const [first] = statement.declarationList.declarations;
    return first && ts.isIdentifier(first.name) ? first.name.text : null;
  }
  return null;
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/**
 * Whether the read at `node` is behind the labs gate: a function around it
 * asks, or it sits in a private top-level helper every one of whose
 * references in the file is itself behind the gate.
 */
function gated(
  file: ts.SourceFile,
  node: ts.Node,
  seen: Set<string> = new Set(),
): boolean {
  for (const fn of enclosingFunctions(node)) {
    if (LABS_GATE.test(stripComments(fn.getText(file)))) return true;
  }
  const statement = topLevelStatement(node);
  const name = statement ? declaredName(statement) : null;
  if (!statement || !name || isExported(statement) || seen.has(name)) {
    return false;
  }
  seen.add(name);
  const references: ts.Node[] = [];
  const visit = (at: ts.Node) => {
    if (
      ts.isIdentifier(at) &&
      at.text === name &&
      topLevelStatement(at) !== statement
    ) {
      references.push(at);
    }
    ts.forEachChild(at, visit);
  };
  visit(file);
  return (
    references.length > 0 &&
    references.every((ref) => gated(file, ref, new Set(seen)))
  );
}

interface LabRead {
  /** `file#top-level name`. */
  site: string;
  line: number;
  gated: boolean;
}

function readsIn(path: string, source: string): LabRead[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: LabRead[] = [];
  const visit = (node: ts.Node) => {
    if (isReadCall(node) || isTableLiteral(node)) {
      const statement = topLevelStatement(node);
      const name = (statement && declaredName(statement)) ?? "(top level)";
      out.push({
        site: `${path}#${name}`,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        gated: gated(file, node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

function labReads(): LabRead[] {
  const out: LabRead[] = [];
  for (const root of ROOTS) {
    for (const [rel, source] of readSourceFolder(root, {
      floor: 20,
      include: (r) =>
        !r.split("/").includes("__tests__") &&
        !/\.(?:test|spec)\.tsx?$/.test(r),
    })) {
      out.push(...readsIn(`${root}/${rel}`, source));
    }
  }
  return out.sort((a, b) => a.site.localeCompare(b.site) || a.line - b.line);
}

describe("labs reach a model only with the labs module on", () => {
  const reads = labReads();

  it("finds the reads it exists to check", () => {
    // An empty match set would pass every assertion below vacuously.
    expect(reads.length).toBeGreaterThanOrEqual(14);
    expect(reads.filter((r) => r.gated).length).toBeGreaterThanOrEqual(8);
  });

  it("every read asks the labs module or is listed as not model input", () => {
    const open = reads
      .filter((r) => !r.gated && !(r.site in NOT_MODEL_INPUT))
      .map((r) => `${r.site}:${r.line}`);
    expect(open).toEqual([]);
  });

  it("lists no site that has since gained the gate or gone", () => {
    const stale = Object.keys(NOT_MODEL_INPUT).filter(
      (site) => !reads.some((r) => r.site === site && !r.gated),
    );
    expect(stale).toEqual([]);
  });

  it("judges each read on its own, not the file it is in", () => {
    const source = `
      export async function gatedRead(userId: string) {
        if (!(await isModuleEnabled(userId, "labs"))) return null;
        return prisma.labResult.findMany({ where: { userId } });
      }
      export async function openRead(userId: string) {
        return prisma.labResult.count({ where: { userId } });
      }
      async function helper(userId: string) {
        return prisma.labResult.findFirst({ where: { userId } });
      }
      export async function callsHelperGated(userId: string) {
        if (!(await isModuleEnabled(userId, "labs"))) return null;
        return helper(userId);
      }
      async function helperTwo(userId: string) {
        return prisma.$queryRaw\`SELECT 1 FROM lab_results\`;
      }
      export async function callsHelperTwo(userId: string) {
        return helperTwo(userId);
      }
      export function medsOnly(ctx: Ctx) {
        return whenModuleOn(ctx, "medications", "t", () =>
          prisma.labResult.findMany({}),
        );
      }
    `;
    const verdicts = readsIn("fixture.ts", source).map(
      (r) => `${r.site}:${r.gated}`,
    );
    expect(verdicts).toEqual([
      "fixture.ts#gatedRead:true",
      "fixture.ts#openRead:false",
      "fixture.ts#helper:true",
      "fixture.ts#helperTwo:false",
      "fixture.ts#medsOnly:false",
    ]);
  });

  it("the gate matcher takes the labs module only", () => {
    expect(LABS_GATE.test('await isModuleEnabled(userId, "labs")')).toBe(true);
    expect(LABS_GATE.test('await isModuleEnabled(ctx.userId, "labs")')).toBe(
      true,
    );
    expect(LABS_GATE.test('whenModuleOn(ctx, "labs", "get_labs"')).toBe(true);
    expect(LABS_GATE.test('isModuleEnabled(userId, "medications")')).toBe(
      false,
    );
    expect(LABS_GATE.test('whenModuleOn(ctx, "environment", "x"')).toBe(false);
  });
});
