/**
 * No structural guard loads a module graph inside a test.
 *
 * The guard project shares one module cache per worker (`isolate: false`,
 * `tests/unit-projects.ts`), so a guard's static imports load once, at
 * collection. A dynamic `import()` inside a test body loads its graph against
 * that test's timeout instead, and how long it takes depends on the machine
 * rather than on the code under test. `step-up-elevation-guard` imported
 * `@/lib/auth/step-up` that way, which reached the database client and the
 * generated Prisma client, and timed out under load in three separate gates
 * while passing every time on its own. `next-image-optimizer-guard` loaded
 * Next's config and plugins the same way.
 *
 * So no file of the guard project calls `import()`. A guard that needs a
 * value imports it statically, or reads the source; a test that must load a
 * module late is an isolated test, not a guard. The files are read with the
 * TypeScript parser, so an `import(` inside a string (a matcher's own test
 * case) is not one.
 */
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { classifyUnitFiles } from "../../tests/unit-projects";
import {
  readSourceText,
  requireFloor,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = join(__dirname, "..", "..");

/** The guard project's files, classified the way the config classifies them. */
function guardFiles(): string[] {
  const under = (dir: string, floor: number, extensions?: string[]) =>
    walkSourceFiles(join(ROOT, dir), { floor, extensions }).map(
      (rel) => `${dir}/${rel}`,
    );
  const candidates = [
    ...under("src/__tests__", 200),
    ...under("scripts/__tests__", 5),
    ...under("tests/quarantine", 1),
    ...under("eslint-plugins", 10, [".mjs"]),
  ].filter((rel) => /\.test\.(?:tsx?|mjs)$/.test(rel));
  return classifyUnitFiles(ROOT, candidates).guards;
}

function dynamicImports(rel: string): number[] {
  const text = readSourceText(join(ROOT, rel));
  const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("guards load their modules with the file", () => {
  const files = requireFloor("guard files", guardFiles(), 150);

  it("finds a dynamic import where there is one", () => {
    const probe = ts.createSourceFile(
      "probe.ts",
      'it("x", async () => { await import("@/lib/db"); }); const s = "import(\\"a\\")";',
      ts.ScriptTarget.Latest,
      true,
    );
    let found = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        found += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(found).toBe(1);
  });

  it("calls import() in no guard", () => {
    const found = files.flatMap((rel) =>
      dynamicImports(rel).map((line) => `${rel}:${line}`),
    );
    expect(found).toEqual([]);
  });
});
