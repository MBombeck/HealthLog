/**
 * A redirect from the session resolve must reach the framework.
 *
 * `getSession` confines a browser session past its second-factor due date by
 * throwing Next's `redirect("/enroll-mfa")` during a page render. That is an
 * exception, and a `catch` around the resolve took it for a failure: the root
 * layout and the dashboard's prefetch both caught everything, so the page
 * rendered as if signed out and only the next click reached the enrolment.
 * A catch that may see such an error has to hand it on with
 * `unstable_rethrow(error)` as its first statement.
 *
 * Two places are held to it:
 *   - every `try` in a server page, layout or template under `src/app` (the
 *     render that can redirect), whatever its body;
 *   - every `try` elsewhere outside the API routes whose body calls a
 *     session resolver directly, and every `.catch(...)` chained on such a
 *     call.
 *
 * The walk asserts it found the cases it exists for, so a renamed resolver
 * that matches nothing fails here instead of passing on an empty set.
 */
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = path.resolve(__dirname, "..");
const RESOLVERS = new Set([
  "getSession",
  "getUnswitchedSession",
  "enforceMfaEnrollment",
]);
const PAGE_FILE = /\/(page|layout|template)\.tsx$/;

function callsResolver(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      RESOLVERS.has(n.expression.text)
    ) {
      found = true;
      return;
    }
    // A nested function is its own scope: what it throws is not this try's.
    if (ts.isFunctionLike(n) && n !== node) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function rethrowsFirst(
  body: ts.Block | ts.ConciseBody | undefined,
  binding: string | undefined,
): boolean {
  if (!body || !binding || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isCallExpression(first.expression) &&
    ts.isIdentifier(first.expression.expression) &&
    first.expression.expression.text === "unstable_rethrow" &&
    first.expression.arguments.length === 1 &&
    ts.isIdentifier(first.expression.arguments[0]) &&
    first.expression.arguments[0].text === binding
  );
}

interface Finding {
  file: string;
  line: number;
  ok: boolean;
}

function scanSource(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const isPage =
    PAGE_FILE.test(file) &&
    !/^\s*["']use client["']/.test(text) &&
    !file.includes(`${path.sep}app${path.sep}api${path.sep}`);
  const findings: Finding[] = [];
  const lineOf = (n: ts.Node) =>
    source.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const visit = (n: ts.Node): void => {
    if (ts.isTryStatement(n) && n.catchClause) {
      if (isPage || callsResolver(n.tryBlock)) {
        const decl = n.catchClause.variableDeclaration;
        const binding =
          decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
        findings.push({
          file,
          line: lineOf(n.catchClause),
          ok: rethrowsFirst(n.catchClause.block, binding),
        });
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "catch" &&
      callsResolver(n.expression.expression)
    ) {
      const handler = n.arguments[0];
      let ok = false;
      if (
        handler &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
      ) {
        const param = handler.parameters[0];
        const binding =
          param && ts.isIdentifier(param.name) ? param.name.text : undefined;
        ok = rethrowsFirst(handler.body, binding);
      }
      findings.push({ file, line: lineOf(n), ok });
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return findings;
}

describe("redirects from the session resolve propagate", () => {
  const files = walkSourceFiles(SRC, { floor: 1000 })
    .filter(
      (rel) =>
        !rel.startsWith("generated/") &&
        !rel.startsWith("app/api/") &&
        !rel.includes("__tests__/") &&
        !/\.test\.tsx?$/.test(rel),
    )
    .map((rel) => path.join(SRC, rel));
  const findings = files.flatMap((f) => scanSource(f, readSourceText(f)));

  it("finds the catches it guards", () => {
    // The root layout, the dashboard and the acting-carrier resolve at least.
    expect(findings.length).toBeGreaterThanOrEqual(10);
    const rel = (f: string) => path.relative(SRC, f);
    const seen = new Set(findings.map((f) => rel(f.file)));
    expect(seen).toContain(path.join("app", "layout.tsx"));
    expect(seen).toContain(path.join("app", "page.tsx"));
    expect(seen).toContain(path.join("lib", "auth", "acting-carrier.ts"));
  });

  it("every one of them hands a framework error on first", () => {
    const bad = findings
      .filter((f) => !f.ok)
      .map((f) => `${path.relative(SRC, f.file)}:${f.line}`);
    expect(bad).toEqual([]);
  });

  it("refuses a catch that swallows", () => {
    const page = path.join(SRC, "app", "x", "page.tsx");
    const swallow = `export default async function P() {
  try { await getSession(); } catch { return null; }
}`;
    expect(scanSource(page, swallow).map((f) => f.ok)).toEqual([false]);
    const lib = path.join(SRC, "lib", "x.ts");
    const late = `async function f() {
  try { await getSession(); } catch (e) { log(e); unstable_rethrow(e); }
  await getUnswitchedSession().catch(() => null);
}`;
    expect(scanSource(lib, late).map((f) => f.ok)).toEqual([false, false]);
    const good = `async function f() {
  try { await getSession(); } catch (e) { unstable_rethrow(e); return null; }
  await getUnswitchedSession().catch((e) => { unstable_rethrow(e); return null; });
}`;
    expect(scanSource(lib, good).map((f) => f.ok)).toEqual([true, true]);
  });
});
