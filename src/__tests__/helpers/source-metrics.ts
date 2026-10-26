/**
 * Measurements over the production source tree, shared by the ratchet
 * guards: which files count as production code, how long each file and each
 * function is, and the value-import graph between modules.
 *
 * Everything is read through the TypeScript compiler, not grepped, so a
 * function is a function node (declaration, expression, arrow, method,
 * constructor, accessor) and an import's kind is the parser's answer, not a
 * regex's guess. `typescript` is already a dependency; nothing new is pulled
 * in.
 *
 * Production code means every `.ts`/`.tsx` file under `src/` outside
 * `src/generated/`, test files, `__tests__/`, `__mocks__/`, `test-utils` and
 * declaration files. The walk goes through `walkSourceFiles`, so dot-prefixed
 * directories (`app/.well-known/`) are included and an empty walk throws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { requireFloor, walkSourceFiles } from "./source-files";

export const SRC = join(process.cwd(), "src");

const TEST_PATH =
  /(^|\/)__tests__\/|(^|\/)__mocks__\/|\.(test|spec)\.tsx?$|(^|\/)test-utils(\/|\.)/;

export function isTestPath(rel: string): boolean {
  return TEST_PATH.test(rel);
}

/** Production source files, relative to `src/`, sorted. */
export function productionSources(): string[] {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (rel) =>
      !rel.startsWith("generated/") &&
      !rel.endsWith(".d.ts") &&
      !isTestPath(rel),
  );
  return requireFloor("production source files", files, 3000) as string[];
}

/** Test files under `src/`, relative to `src/`, sorted. */
export function testSources(): string[] {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (rel) => !rel.startsWith("generated/") && /\.(test|spec)\.tsx?$/.test(rel),
  );
  return requireFloor("test files", files, 2000) as string[];
}

export function readSrc(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Line count the way an editor shows it: a trailing newline adds none. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

export function parse(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return null;
}

function calleeText(call: ts.CallExpression, sf: ts.SourceFile): string {
  const text = call.expression.getText(sf).replace(/\s+/g, "");
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * A readable, stable name for a function node: its own name, the variable or
 * property it is assigned to, or the call it is passed to
 * (`apiHandler(arg)`, `$transaction(arg)`). Positions are deliberately not
 * part of it, so an edit above a function does not rename it.
 */
function ownName(node: FunctionNode, sf: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    const text = ts.isIdentifier(node.name)
      ? node.name.text
      : propertyNameText(node.name as ts.PropertyName);
    if (text) return text;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    return propertyNameText(parent.name) ?? "(property)";
  }
  if (ts.isPropertyDeclaration(parent)) {
    return propertyNameText(parent.name) ?? "(property)";
  }
  if (ts.isExportAssignment(parent)) return "default";
  if (ts.isCallExpression(parent)) return `${calleeText(parent, sf)}(arg)`;
  if (ts.isJsxExpression(parent)) return "(jsx callback)";
  return "(anonymous)";
}

export interface MeasuredFunction {
  /** `outer > inner` chain of names, unique within the file. */
  name: string;
  /** 1-based first line. */
  line: number;
  lines: number;
}

/**
 * Every function in the file with its length in lines, nested functions
 * included (a 2,800-line function holding a 2,100-line callback reports
 * both). Names that collide within a file get a `#2`, `#3` suffix in source
 * order.
 */
export function measureFunctions(sf: ts.SourceFile): MeasuredFunction[] {
  const out: MeasuredFunction[] = [];
  const seen = new Map<string, number>();
  const visit = (node: ts.Node, chain: string[]): void => {
    let next = chain;
    if (isFunctionNode(node)) {
      const base = [...chain, ownName(node, sf)].join(" > ");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const name = n === 1 ? base : `${base} #${n}`;
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      out.push({ name, line: start + 1, lines: end - start + 1 });
      next = [...chain, ownName(node, sf)];
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, []);
  return out;
}

// ── Value-import graph ──────────────────────────────────────────────────────

const COMPILER_OPTIONS: ts.CompilerOptions = {
  baseUrl: process.cwd(),
  paths: { "@/*": ["./src/*"] },
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  resolveJsonModule: true,
  allowJs: true,
};

export interface ModuleImports {
  /** Specifiers this module evaluates at runtime, static and dynamic. */
  value: string[];
  /** True when every statement is an `export … from` (or an import). */
  reexportOnly: boolean;
  /** The value imports evaluated when the module loads: `value` without `import("…")`. */
  staticValue: string[];
}

/**
 * The specifiers a module needs at runtime: static imports and re-exports
 * that are not type-only, side-effect imports, and dynamic `import("…")`
 * with a literal specifier. `import type`, `export type` and lists whose
 * every name is `type` are erased by the compiler and left out.
 */
export function moduleImports(sf: ts.SourceFile): ModuleImports {
  const value: string[] = [];
  let reexports = 0;
  let other = 0;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
        value.push(st.moduleSpecifier.text);
      }
      continue;
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      reexports += 1;
      const typeOnly =
        st.isTypeOnly ||
        (!!st.exportClause &&
          ts.isNamedExports(st.exportClause) &&
          st.exportClause.elements.length > 0 &&
          st.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
        value.push(st.moduleSpecifier.text);
      }
      continue;
    }
    other += 1;
  }
  const staticValue = [...value];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      value.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { value, staticValue, reexportOnly: reexports > 0 && other === 0 };
}

export interface ImportGraph {
  /** Module → modules it imports at runtime, both relative to `src/`. */
  edges: Map<string, string[]>;
  /** Modules whose every statement is a re-export. */
  reexportOnly: string[];
  /** Specifiers resolved to a module inside `src/`. */
  resolved: number;
}

/**
 * The runtime import graph over the production sources, resolved with the
 * compiler's own module resolution under the app's `@/*` path mapping.
 * Imports of `src/generated/` and of packages are not edges.
 */
export function buildImportGraph(files: readonly string[]): ImportGraph {
  const cache = ts.createModuleResolutionCache(
    process.cwd(),
    (x) => x,
    COMPILER_OPTIONS,
  );
  const known = new Set(files);
  const edges = new Map<string, string[]>();
  const reexportOnly: string[] = [];
  let resolved = 0;
  for (const rel of files) {
    const abs = join(SRC, rel);
    const sf = parse(rel, readFileSync(abs, "utf8"));
    const imports = moduleImports(sf);
    if (imports.reexportOnly) reexportOnly.push(rel);
    const deps = new Set<string>();
    for (const spec of imports.value) {
      const hit = ts.resolveModuleName(
        spec,
        abs,
        COMPILER_OPTIONS,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!hit || hit.isExternalLibraryImport) continue;
      const target = hit.resolvedFileName;
      if (!target.startsWith(`${SRC}/`)) continue;
      const targetRel = target.slice(SRC.length + 1);
      if (!known.has(targetRel)) continue;
      deps.add(targetRel);
      resolved += 1;
    }
    edges.set(rel, [...deps].sort());
  }
  return { edges, reexportOnly, resolved };
}

/** Strongly connected components with more than one module, or a self-loop. */
export function stronglyConnected(edges: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  const strong = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (edges.get(v) ?? []).includes(v)) {
        out.push(component.sort());
      }
    }
  };

  for (const v of [...edges.keys()].sort()) if (!idx.has(v)) strong(v);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Cycles the way a depth-first walk in sorted order meets them: one cycle
 * per back edge, each listed from the module the walk re-entered. This is
 * the count `madge --circular` reports, so the number reads the same as the
 * audits that measured it.
 */
export function backEdgeCycles(edges: Map<string, string[]>): string[][] {
  const visited = new Set<string>();
  const cycles: string[][] = [];
  const path: string[] = [];
  const onPath = new Set<string>();
  const walk = (v: string): void => {
    if (onPath.has(v)) {
      cycles.push([...path.slice(path.indexOf(v)), v]);
      return;
    }
    if (visited.has(v)) return;
    visited.add(v);
    path.push(v);
    onPath.add(v);
    for (const w of edges.get(v) ?? []) walk(w);
    path.pop();
    onPath.delete(v);
  };
  for (const v of [...edges.keys()].sort()) walk(v);
  return cycles;
}

/**
 * Every module under `src/` that loading `entries` evaluates: static value
 * imports and re-exports, transitively. A dynamic `import("…")` is not
 * followed, since it loads only when it runs. Paths are relative to `src/`.
 */
export function staticImportClosure(entries: readonly string[]): Set<string> {
  const cache = ts.createModuleResolutionCache(
    process.cwd(),
    (x) => x,
    COMPILER_OPTIONS,
  );
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(SRC, rel);
    for (const spec of moduleImports(parse(rel, readFileSync(abs, "utf8")))
      .staticValue) {
      const hit = ts.resolveModuleName(
        spec,
        abs,
        COMPILER_OPTIONS,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!hit || hit.isExternalLibraryImport) continue;
      if (!hit.resolvedFileName.startsWith(`${SRC}/`)) continue;
      const target = hit.resolvedFileName.slice(SRC.length + 1);
      if (target.startsWith("generated/") || target.endsWith(".d.ts")) continue;
      stack.push(target);
    }
  }
  return seen;
}
