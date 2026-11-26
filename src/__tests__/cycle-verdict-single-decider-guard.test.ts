/**
 * One decider for the cycle verdict.
 *
 * The server resolves the cycle day, the ring's arcs, the fertile-window state
 * and the overdue judgement with its day count, and publishes them on
 * `GET /api/cycle/calendar`. Client code renders that. It does not recompute
 * any part of it, and it does not keep its own grace-period constant — while
 * such a constant exists in client code it can be copied into another client,
 * which is exactly how a cycle ring came to show a person a day their record
 * did not hold.
 *
 * Two halves, because either one alone is satisfiable by broken code:
 * nothing in the client tree may derive the verdict, AND the surfaces that
 * show it must still be reading the published field.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative as relativeTo } from "node:path";

import { describe, expect, it } from "vitest";

import {
  accessPaths,
  derivationFindings,
  mayBeCycleContext,
  parse,
} from "./helpers/cycle-verdict-derivation";
import { readSource, readSourceText } from "./helpers/source-files";

const ROOT = process.cwd();

/** Client-side code: the component tree, the hooks, and the app's pages. */
const CLIENT_ROOTS = ["src/components", "src/hooks", "src/app"];
/**
 * Pruned on purpose: the generated Prisma client, build output, vendored
 * dependencies, and the suites themselves are not the tree under audit. Note
 * what is NOT pruned — this walk descends into dot-prefixed directories, so
 * `src/app/.well-known` is inside the sweep. `fs.globSync` would drop it.
 */
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", "generated"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx") &&
      // Route handlers under `src/app/api` are the server; the verdict is
      // resolved there on purpose.
      !p.includes(`${join("src", "app", "api")}`)
    ) {
      out.push(relativeTo(ROOT, p));
    }
  }
  return out;
}

function clientFiles(): string[] {
  return CLIENT_ROOTS.flatMap((root) => walk(join(ROOT, root)));
}

function parseFile(relative: string) {
  return parse(relative, readSourceText(join(ROOT, relative)));
}

describe("the cycle verdict is decided in one place", () => {
  it("finds no client file that re-derives it", () => {
    const files = clientFiles();
    // A guard over an empty file list proves nothing.
    expect(files.length).toBeGreaterThan(100);

    const findings = files
      .filter((relative) =>
        mayBeCycleContext(readSourceText(join(ROOT, relative))),
      )
      .flatMap((relative) => derivationFindings(parseFile(relative)));

    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.kind} — ${f.where}`),
    ).toEqual([]);
  });

  it("keeps the grace window out of client code entirely", () => {
    // The specific constant that was copied. Named here so its return is loud
    // rather than merely structural.
    const offenders = clientFiles().filter((relative) =>
      readSourceText(join(ROOT, relative)).includes("OVERDUE_GRACE_DAYS"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the surfaces that show the verdict actually read it", () => {
  const CONSUMERS = [
    "src/components/cycle/cycle-view.tsx",
    "src/components/cycle/cycle-insight-summary-card.tsx",
  ];

  it.each(CONSUMERS)("%s reads the published verdict", (relative) => {
    const paths = accessPaths(parseFile(relative));
    const readsVerdict = [...paths].some((p) => p.endsWith(".verdict"));
    expect(readsVerdict).toBe(true);
  });

  it("the temperature chart takes the cycle start from the verdict", () => {
    // The BBT chart used to walk the calendar itself to find the cycle start,
    // which was a second copy of the same walk. It now takes the resolved
    // value as a prop, and the cycle page feeds it from the verdict.
    const chart = readSource(
      "src/components/cycle/bbt-chart.tsx",
      "cycleStartDate",
    );
    expect(chart).toContain("cycleStartDate");

    const view = "src/components/cycle/cycle-view.tsx";
    const paths = accessPaths(parse(view, readSource(view, "verdict")));
    expect([...paths]).toContain("verdict.cycleStartDate");
  });

  it("the calendar response type declares the verdict as always present", () => {
    // An optional verdict is a plausible default that lets a client fall back
    // to deriving its own.
    const types = readSource("src/components/cycle/types.ts", "CycleVerdict");
    expect(types).toContain("verdict: CycleVerdict;");
    expect(types).not.toContain("verdict?:");
  });
});
