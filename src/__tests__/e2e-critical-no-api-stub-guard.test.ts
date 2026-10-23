/**
 * Structural guard: an `@critical` e2e journey talks to the real server.
 *
 * The `@critical` tag marks the journeys a release is gated on — sign-in,
 * a reading reaching the dashboard, a dose moving compliance, a backup coming
 * back. They are only worth that role if the server under them is the one
 * that ships. A spec that stubs `/api/*` with `page.route(...)` proves that
 * the UI renders a payload somebody typed into the test, which is how a broken
 * write path stays green: the mock answers 200 whatever the route does.
 *
 * So a spec FILE that carries `@critical` anywhere may not intercept the app's
 * API, and the rule is per file rather than per test because a route armed in
 * a `beforeEach` or a `describe`-level hook covers every test beside it.
 * What it catches:
 *
 *   - `.route(` / `.routeFromHAR(` in the spec whose first argument mentions
 *     `api`, or is not a literal at all (a pattern held in a variable cannot be
 *     shown to miss `/api`, so it is refused rather than trusted);
 *   - a helper imported from a relative module whose exported function arms
 *     such a route (`stubDashboardAnalytics`, `mockMedicationsApi`, …). The
 *     helper is read, its exported functions are cut apart at each top-level
 *     `export`, and any that intercepts `/api` may not be imported by name.
 *
 * Stubbing a third-party host that is unreachable from CI and is not the
 * journey's subject stays possible: a literal pattern without `api` passes.
 * The spec is expected to say why next to the call.
 *
 * It is a tripwire with a scanner's limits, not a parser: a route armed
 * through a helper that is not imported by name (a default export, a
 * re-export chain) is not followed. The synthetic cases at the bottom prove
 * each matcher fires; the floor proves the sweep found the tagged tests at
 * all.
 */
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  requireFloor,
  walkSourceFiles,
} from "./helpers/source-files";

const E2E = join(process.cwd(), "e2e");

/**
 * The `@critical` tests found in `e2e/*.spec.ts`. Pinned at the real count:
 * the set is the release gate, so a journey that loses its tag is a change
 * somebody should see here. It counts title literals in the source, so a
 * title written once inside a loop counts once however many tests it names.
 */
const CRITICAL_TEST_FLOOR = 16;

/** A test whose title literal carries the tag, however the call is spelled. */
const CRITICAL_TEST =
  /\btest(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(["'`])((?:(?!\1)[\s\S])*?@critical(?:(?!\1)[\s\S])*?)\1/g;

/** A route interception call; the first argument is examined separately. */
const ROUTE_CALL = /\.route(?:FromHAR)?\(\s*/g;

interface StubFinding {
  /** Where the interception lives (the spec, or the helper it imports). */
  where: string;
  /** What was found. */
  detail: string;
}

/**
 * The first argument of a call whose open paren ends at `start`: a string,
 * template or regex literal is returned whole; anything else is returned up to
 * the first comma or closing paren and flagged as not a literal.
 */
function firstArgument(
  source: string,
  start: number,
): { text: string; literal: boolean } {
  const opener = source[start];
  if (opener === '"' || opener === "'" || opener === "`") {
    const end = source.indexOf(opener, start + 1);
    return { text: source.slice(start, end + 1), literal: true };
  }
  if (opener === "/") {
    // A regex literal: up to the next unescaped slash.
    let i = start + 1;
    while (i < source.length && !(source[i] === "/" && source[i - 1] !== "\\"))
      i += 1;
    return { text: source.slice(start, i + 1), literal: true };
  }
  const rest = source.slice(start);
  const stop = rest.search(/[,)]/);
  return { text: rest.slice(0, stop === -1 ? 80 : stop), literal: false };
}

/** Every `/api` (or unprovable) interception in one source text. */
function apiStubsIn(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const m of code.matchAll(ROUTE_CALL)) {
    const arg = firstArgument(code, (m.index ?? 0) + m[0].length);
    if (!arg.literal) {
      hits.push(`route pattern is not a literal: ${arg.text.trim()}`);
    } else if (/api/i.test(arg.text)) {
      hits.push(`route intercepts the app's API: ${arg.text}`);
    }
  }
  return hits;
}

/** The names a spec imports from each relative module. */
function relativeImports(
  source: string,
): Array<{ names: string[]; from: string }> {
  const code = stripComments(source);
  const out: Array<{ names: string[]; from: string }> = [];
  for (const m of code.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const names = m[1]
      .split(",")
      .map((n) =>
        n
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    out.push({ names, from: m[2] });
  }
  return out;
}

/**
 * Exported functions of a helper that intercept `/api`, by name. The helper is
 * cut at each top-level `export`, so each slice is one export's body.
 */
function stubbingExports(helperSource: string): string[] {
  const code = stripComments(helperSource);
  const starts = [...code.matchAll(/^export\s+/gm)].map((m) => m.index ?? 0);
  const names: string[] = [];
  starts.forEach((start, i) => {
    const slice = code.slice(start, starts[i + 1] ?? code.length);
    const name = slice.match(
      /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)([A-Za-z0-9_$]+)/,
    )?.[1];
    if (name && apiStubsIn(slice).length > 0) names.push(name);
  });
  return names;
}

function resolveHelper(specRel: string, from: string): string | null {
  const base = join(E2E, dirname(specRel), from);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Everything that stubs `/api` in one spec file, its imported helpers included. */
function findApiStubs(
  specRel: string,
  source: string,
  readHelper: (absolute: string) => string = readSourceText,
): StubFinding[] {
  const findings: StubFinding[] = apiStubsIn(source).map((detail) => ({
    where: specRel,
    detail,
  }));
  for (const { names, from } of relativeImports(source)) {
    const helper = resolveHelper(specRel, from);
    if (!helper) continue;
    const stubbing = new Set(stubbingExports(readHelper(helper)));
    for (const name of names) {
      if (stubbing.has(name)) {
        findings.push({
          where: relative(E2E, helper),
          detail: `\`${name}\` (imported by ${specRel}) intercepts the app's API`,
        });
      }
    }
  }
  return findings;
}

function specFiles(): string[] {
  return walkSourceFiles(E2E, { floor: 100, extensions: [".ts"] }).filter(
    (rel) => !rel.includes("/") && rel.endsWith(".spec.ts"),
  );
}

function criticalTests(): Array<{ file: string; title: string }> {
  const tests: Array<{ file: string; title: string }> = [];
  for (const file of specFiles()) {
    const code = stripComments(readSourceText(join(E2E, file)));
    for (const m of code.matchAll(CRITICAL_TEST)) {
      tests.push({ file, title: m[2] });
    }
  }
  return tests;
}

describe("@critical e2e journeys run against the real API", () => {
  it("finds the tagged journeys", () => {
    requireFloor("@critical e2e tests", criticalTests(), CRITICAL_TEST_FLOOR);
  });

  it("no file carrying @critical intercepts /api, directly or through a helper", () => {
    const files = new Set(criticalTests().map((t) => t.file));
    // A file that mentions the tag outside a test title (a describe title, a
    // `grep` option) is held to the same rule.
    for (const file of specFiles()) {
      if (stripComments(readSourceText(join(E2E, file))).includes("@critical"))
        files.add(file);
    }
    const offenders = [...files].flatMap((file) =>
      findApiStubs(file, readSourceText(join(E2E, file))).map(
        (f) => `${f.where}: ${f.detail}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  describe("the matchers fire", () => {
    it("on a glob, a regex and a non-literal pattern", () => {
      expect(
        apiStubsIn(`await page.route("**/api/measurements*", f);`),
      ).toHaveLength(1);
      expect(
        apiStubsIn(`await page.route(/\\/api\\/analytics(\\?|$)/, f);`),
      ).toHaveLength(1);
      expect(apiStubsIn(`await context.route(PATTERN, f);`)).toHaveLength(1);
      expect(
        apiStubsIn(`await page.routeFromHAR("api.har", { update: false });`),
      ).toHaveLength(1);
    });

    it("not on a third-party host, a comment, or an unrelated call", () => {
      expect(
        apiStubsIn(`await page.route("https://tiles.example.org/**", f);`),
      ).toEqual([]);
      expect(apiStubsIn(`// page.route("**/api/x", f)`)).toEqual([]);
      expect(apiStubsIn(`router.push("/api/x");`)).toEqual([]);
    });

    it("on a stubbing helper imported by name, and not on its siblings", () => {
      const helper = [
        `export function mockThings(page) {`,
        `  void page.route("**/api/things**", (r) => r.fulfill({}));`,
        `}`,
        `export async function openThing(page) {`,
        `  await page.goto("/things");`,
        `}`,
      ].join("\n");
      expect(stubbingExports(helper)).toEqual(["mockThings"]);

      const read = () => helper;
      const uses = `import { mockThings, openThing } from "./medications-wizard-helpers";`;
      expect(findApiStubs("x.spec.ts", uses, read)).toHaveLength(1);
      const clean = `import { openThing } from "./medications-wizard-helpers";`;
      expect(findApiStubs("x.spec.ts", clean, read)).toEqual([]);
    });
  });
});
