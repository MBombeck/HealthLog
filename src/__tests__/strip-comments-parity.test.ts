/**
 * The shared comment stripper reads comments the way the compiler does.
 *
 * Every structural guard that must not read prose as code goes through
 * `stripComments` (`helpers/source-files.ts`). The private copies it replaced
 * each got one case wrong (a `/*` inside a line comment, a `/*` inside a
 * string, a trailing `//` after code, a URL), and a wrong strip is silent: a
 * guard that loses real code reports a clean sweep. So the stripper is a
 * scanner held to the TypeScript parser: every source file is stripped both
 * ways, and the first file where they differ fails here with the line.
 */
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = join(__dirname, "..", "..");

/** The parser's answer: remove exactly the ranges it reports as comments. */
function parserStrip(text: string, fileName: string): string {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  const ranges = new Map<number, number>();
  const take = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) ranges.set(range.pos, range.end);
  };
  const visit = (node: ts.Node) => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()));
    take(ts.getTrailingCommentRanges(text, node.getEnd()));
    if (
      node.kind >= ts.SyntaxKind.FirstToken &&
      node.kind <= ts.SyntaxKind.LastToken
    ) {
      return;
    }
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  let out = "";
  let at = 0;
  for (const [pos, end] of [...ranges].sort(([a], [b]) => a - b)) {
    if (pos < at) continue;
    out += text.slice(at, pos) + text.slice(pos, end).replace(/[^\n]/g, "");
    at = end;
  }
  return out + text.slice(at);
}

/** Trailing whitespace differs where a comment left the line; nothing else may. */
function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd());
}

describe("stripComments", () => {
  it("keeps the code a block opener inside a line comment used to hide", () => {
    const source = [
      "// Every `/api/mood-entries/*` route also enforces the gate.",
      "if (!enabled) return notFound();",
      "/* a real block */ const x = 1;",
    ].join("\n");
    expect(lines(stripComments(source))).toEqual([
      "",
      "if (!enabled) return notFound();",
      " const x = 1;",
    ]);
  });

  it("opens nothing inside strings, templates and regular expressions", () => {
    const source = [
      'await page.route("**/api/day/**", stub); // a stub',
      'const url = "https://host/*"; const next = `/*${id /* gone */}*/`;',
      "const slash = /\\/\\*/g; const ratio = a / b; // c",
    ].join("\n");
    expect(lines(stripComments(source))).toEqual([
      'await page.route("**/api/day/**", stub);',
      'const url = "https://host/*"; const next = `/*${id }*/`;',
      "const slash = /\\/\\*/g; const ratio = a / b;",
    ]);
  });

  it("keeps line numbers, so a finding points at the file's own line", () => {
    const source = "/**\n * doc\n */\nexport const a = 1;\n";
    expect(stripComments(source).split("\n")[3]).toBe("export const a = 1;");
  });

  it("strips only block comments from CSS", () => {
    expect(
      stripComments(".a { background: url(//cdn/x.png); } /* note */", "x.css"),
    ).toBe(".a { background: url(//cdn/x.png); } ");
  });

  it("agrees with the TypeScript parser on every source file", () => {
    const files = requireFloor(
      "source files",
      [
        ...walkSourceFiles(join(ROOT, "src"), { floor: 3000 })
          .filter((rel) => !rel.startsWith("generated/"))
          .map((rel) => join("src", rel)),
        ...walkSourceFiles(join(ROOT, "e2e"), { floor: 100 }).map((rel) =>
          join("e2e", rel),
        ),
      ].filter((rel) => /\.tsx?$/.test(rel)),
      3500,
    );
    const differing: string[] = [];
    for (const rel of files) {
      const text = readSourceText(join(ROOT, rel));
      const ours = lines(stripComments(text, rel));
      const parser = lines(parserStrip(text, rel));
      const at = ours.findIndex((line, index) => line !== parser[index]);
      if (at !== -1 || ours.length !== parser.length) {
        differing.push(`${rel}:${at + 1}`);
      }
    }
    expect(differing).toEqual([]);
  }, 180_000);
});
