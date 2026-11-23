/**
 * Nothing the Edge runtime bundles may load a Node module.
 *
 * Two entries are compiled for Edge: the request proxy (`src/proxy.ts`) and
 * the Edge pass over `src/instrumentation.ts`. The instrumentation file is
 * Node-only in effect, because everything it does sits behind
 * `process.env.NEXT_RUNTIME === "nodejs"` (or after an early return on
 * `"edge"`), which the bundler replaces and prunes. Two helpers defined
 * outside that guard kept their dynamic imports in the Edge graph, and with
 * them the notification layer and `node:net`, `node:crypto`, `node:fs` and
 * dozens more: one build warning each.
 *
 * This walks both graphs the way the bundler sees them (guarded regions
 * removed, type-only imports skipped, every reachable source file followed)
 * and refuses any `node:` module or Node builtin in them.
 */
import { builtinModules } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const BUILTINS = new Set(builtinModules);
const IMPORT =
  /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const NODE_GUARD =
  /if\s*\(\s*process\.env\.NEXT_RUNTIME\s*===\s*["']nodejs["']\s*\)\s*\{/g;
const EDGE_RETURN =
  /if\s*\(\s*process\.env\.NEXT_RUNTIME\s*(?:===\s*["']edge["']|!==\s*["']nodejs["'])\s*\)\s*return\b[^;]*;/g;

/** The index just past the `}` closing the block opened before `from`. */
function closeOf(code: string, from: number, depth: number): number {
  let d = depth;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "{") d += 1;
    else if (code[i] === "}") {
      d -= 1;
      if (d === 0) return i + 1;
    }
  }
  return code.length;
}

/** The source as the Edge bundler keeps it: Node-guarded regions cut out. */
export function edgeVisible(code: string): string {
  let out = code;
  for (;;) {
    NODE_GUARD.lastIndex = 0;
    const m = NODE_GUARD.exec(out);
    if (!m) break;
    const end = closeOf(out, m.index + m[0].length, 1);
    out = out.slice(0, m.index) + out.slice(end);
  }
  for (;;) {
    EDGE_RETURN.lastIndex = 0;
    const m = EDGE_RETURN.exec(out);
    if (!m) break;
    // Everything after the early return, to the end of its block.
    const end = closeOf(out, m.index + m[0].length, 1) - 1;
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

interface Graph {
  files: string[];
  /** A Node module, with the chain of files that reaches it. */
  nodeModules: string[];
}

function walk(entry: string, prune: boolean): Graph {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const nodeModules: string[] = [];
  const chain = (file: string) => {
    const out: string[] = [];
    for (let f: string | null = file; f; f = parent.get(f) ?? null) {
      out.push(relative(SRC, f));
    }
    return out.join(" <- ");
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    let code = stripComments(readSourceText(file));
    if (prune) code = edgeVisible(code);
    for (const m of code.matchAll(IMPORT)) {
      if (m[1]) continue; // `import type` / `export type`
      const spec = (m[2] ?? m[3])!;
      if (spec.startsWith("node:") || BUILTINS.has(spec)) {
        nodeModules.push(`${spec} <- ${chain(file)}`);
        continue;
      }
      const target = resolveSpec(file, spec);
      if (!target || parent.has(target) || !/\.tsx?$/.test(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return { files: [...parent.keys()], nodeModules };
}

describe("the Edge graphs load no Node module", () => {
  it("prunes what the bundler prunes, and only that", () => {
    const code = [
      'import { a } from "@/lib/a";',
      "export async function register() {",
      '  if (process.env.NEXT_RUNTIME === "nodejs") {',
      '    await import("@/lib/node-only");',
      "    if (x) { y(); }",
      "  }",
      '  await import("@/lib/kept");',
      "}",
      "export async function onError() {",
      '  if (process.env.NEXT_RUNTIME === "edge") return;',
      '  await import("@/lib/after-return");',
      "}",
      'await import("@/lib/top");',
    ].join("\n");
    const kept = edgeVisible(code);
    expect(kept).not.toContain("node-only");
    expect(kept).not.toContain("after-return");
    expect(kept).toContain("@/lib/kept");
    expect(kept).toContain("@/lib/top");
    expect(kept).toContain("@/lib/a");
  });

  it("the walker finds Node modules where they are", () => {
    // Unpruned, the instrumentation graph reaches the database client and
    // the worker: a walker that found nothing there would be blind.
    const unpruned = walk(join(SRC, "instrumentation.ts"), false);
    requireFloor("Node modules in the unpruned graph", unpruned.nodeModules, 1);
  });

  it("the proxy graph is Node-free", () => {
    const graph = walk(join(SRC, "proxy.ts"), true);
    requireFloor("files in the proxy graph", graph.files, 10);
    expect(graph.nodeModules).toEqual([]);
  });

  it("the Edge pass over instrumentation is Node-free", () => {
    const graph = walk(join(SRC, "instrumentation.ts"), true);
    requireFloor("files in the Edge instrumentation graph", graph.files, 1);
    expect(graph.nodeModules).toEqual([]);
  });
});
