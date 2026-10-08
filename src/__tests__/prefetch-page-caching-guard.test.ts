import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Structural guard over the server-prefetching pages.
 *
 * A page that calls `dehydrate()` inside a `HydrationBoundary` serialises a
 * health record into the HTML document and seeds it into the client's query
 * cache. Three things must hold for every such page, and none is enforced by
 * the type system:
 *
 *  1. It must be session-gated at the edge, so `src/proxy.ts` stamps
 *     `Cache-Control: private, no-store` on the document. A prefetching page
 *     placed on a public path would ship a record with no cache directive at
 *     all.
 *  2. It must not opt into static or revalidated rendering. `export const
 *     revalidate = <n>` or `dynamic = "force-static"` would let Next serve one
 *     account's prefetched HTML to the next caller out of its own cache,
 *     before the request ever reaches a header.
 *  3. It must resolve its session through `getUnswitchedSession()`, never
 *     `getSession()`. The first two rules keep one account's record away from
 *     the NEXT caller; this one keeps it away from the CURRENT one. Under an
 *     account switch `getSession()` answers with the delegate — that is its
 *     documented job — so a page that prefetches off it dehydrates the
 *     delegate's own numbers into a document opened on the owner's record.
 *
 * The guard walks the app tree rather than naming files, so a NEW prefetching
 * page is covered the moment it lands. That is the whole point of rule 3 being
 * here rather than a line each page remembers: the five pages that prefetch
 * today all made the same mistake independently, which is what a rule looks
 * like when nothing states it.
 *
 * Rule 3 was checked by two regexes until 2026-08-04, and neither could fail
 * on the shape that matters. `/getUnswitchedSession\s*\(/` is satisfied by the
 * doc comment every one of these pages carries, so the "calls the right
 * helper" leg passed on prose. `/getSession\s*\(/` is not satisfied by
 * `import { getSession as loadSession }` — no parenthesis follows the name —
 * so the "never reaches the wrong one" leg passed on an aliased import. Both
 * legs were green with the dashboard genuinely prefetching off the
 * switch-blind session, which is the exact defect they exist for.
 *
 * So membership is decided from the AST now: the module's import table
 * resolves every local name back to the symbol it was exported as, and only
 * CALL expressions count. A comment cannot enrol a page and an alias cannot
 * hide one. `describe("the call matcher sees what it looks for")` proves both
 * halves against synthetic modules, so the day the matcher stops matching is
 * the day this file goes red rather than quiet.
 */

const APP_DIR = join(process.cwd(), "src", "app");

/** Mirrors the public-path allowlist in `src/proxy.ts`. */
const PUBLIC_ROUTE_PREFIXES = [
  "/auth/",
  "/privacy",
  "/about",
  "/c/",
  "/invite/",
  "/onboarding",
  "/mcp",
  "/i18n/",
  "/.well-known/",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry === "page.tsx" || entry === "page.ts") {
      out.push(full);
    }
  }
  return out;
}

/** Turn `src/app/insights/workouts/page.tsx` into `/insights/workouts`. */
function routePathFor(file: string): string {
  const rel = relative(APP_DIR, file).split(sep).slice(0, -1);
  const segments = rel.filter(
    // Route groups `(name)` and parallel/intercepting slots contribute no
    // URL segment.
    (s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"),
  );
  return "/" + segments.join("/");
}

function isPublicRoute(routePath: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((p) => routePath.startsWith(p));
}

/**
 * The names of every function this module CALLS, resolved back to the symbol
 * each one was exported as.
 *
 * Calls only — an import the page never reaches proves nothing, and neither
 * does a sentence in a comment. Aliases resolve through the module's own
 * import table (`getSession as loadSession` comes back as `getSession`), and a
 * namespace-qualified call (`auth.getSession()`) comes back the same way. Both
 * are the shapes the regexes could not see.
 */
export function calledSymbolsIn(source: string, fileName: string): Set<string> {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  parsed.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const spec of bindings.elements) {
      aliases.set(spec.name.text, (spec.propertyName ?? spec.name).text);
    }
  });

  const called = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        called.add(aliases.get(callee.text) ?? callee.text);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        called.add(callee.name.text);
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return called;
}

const prefetchingPages = walk(APP_DIR)
  .map((file) => ({ file, source: readFileSync(file, "utf8") }))
  .filter(
    ({ source }) =>
      source.includes("HydrationBoundary") && source.includes("dehydrate"),
  )
  .map(({ file, source }) => ({
    file,
    source,
    routePath: routePathFor(file),
    rel: relative(process.cwd(), file),
    called: calledSymbolsIn(source, file),
  }));

/**
 * Every page that prefetches today, named.
 *
 * The walk is what covers a NEW page; this literal is what covers a page that
 * stops being found. Rule 3's legs report an empty offender list both when
 * every page complies and when the detector stopped seeing them, and the
 * dashboard pin alone would not notice four of the five going quiet.
 */
const PREFETCHING_ROUTES = [
  "/",
  "/checkups",
  "/coach",
  "/insights",
  "/insights/mood",
  "/insights/workouts",
  "/medications",
  "/mood",
] as const;

describe("server-prefetching pages cannot leak a cacheable record", () => {
  it("finds the prefetching pages at all (guard is not vacuous)", () => {
    expect(prefetchingPages.length).toBeGreaterThan(0);
    // The dashboard is the canonical one; if it stops matching, the detection
    // heuristic has drifted and every assertion below is silently skipped.
    expect(prefetchingPages.map((p) => p.routePath)).toContain("/");
    // And the other four with it. A page that stops being detected takes its
    // own coverage down silently, so the set is frozen: adding a prefetching
    // page is a line here, and losing one is a failure rather than a shrug.
    expect(prefetchingPages.map((p) => p.routePath).sort()).toEqual(
      [...PREFETCHING_ROUTES].sort(),
    );
  });

  it("keeps every prefetching page behind the session gate", () => {
    const publicOnes = prefetchingPages.filter((p) =>
      isPublicRoute(p.routePath),
    );
    expect(
      publicOnes.map((p) => `${p.rel} (${p.routePath})`),
      "a page that dehydrates a record onto a public path gets no no-store header from the proxy",
    ).toEqual([]);
  });

  it("lets no prefetching page opt into static or revalidated rendering", () => {
    const offenders: string[] = [];
    for (const page of prefetchingPages) {
      if (/export\s+const\s+revalidate\s*=/.test(page.source)) {
        offenders.push(`${page.rel}: exports revalidate`);
      }
      const dynamicMatch = page.source.match(
        /export\s+const\s+dynamic\s*=\s*["']([^"']+)["']/,
      );
      if (dynamicMatch && dynamicMatch[1] !== "force-dynamic") {
        offenders.push(`${page.rel}: exports dynamic = "${dynamicMatch[1]}"`);
      }
    }
    expect(
      offenders,
      "a prefetched page must never be served from Next's own render cache",
    ).toEqual([]);
  });
});

describe("server-prefetching pages cannot seed a switched session", () => {
  /**
   * Both halves are asserted, and the pair is the guard.
   *
   * "Calls the right helper" alone passes a page that calls both — the import
   * sits there, the accessor is used for a null-check, and the read underneath
   * still goes through `getSession()`. "Does not call the wrong one" alone
   * passes a page that resolves no session at all and prefetches nothing,
   * which is green for a reason nobody wanted. Together they say the one thing
   * meant: the session a prefetching page acts on came from the accessor that
   * refuses under a switch.
   */
  const UNSWITCHED = "getUnswitchedSession";
  const RAW_SESSION = "getSession";

  it("resolves every prefetching page's session through getUnswitchedSession", () => {
    // Non-vacuous, and it has to be said again in this block: `missing` is
    // empty both when every page complies and when the walker found no pages
    // at all. The first describe asserts the same thing, and asserting it once
    // there would let a drifted detector take this leg down with it silently.
    expect(prefetchingPages.length).toBeGreaterThan(0);

    const missing = prefetchingPages
      .filter((p) => !p.called.has(UNSWITCHED))
      .map((p) => p.rel);
    expect(
      missing,
      "a prefetching page must take its session from getUnswitchedSession()",
    ).toEqual([]);
  });

  it("lets no prefetching page reach getSession directly", () => {
    const offenders = prefetchingPages
      .filter((p) => p.called.has(RAW_SESSION))
      .map((p) => p.rel);
    expect(
      offenders,
      "getSession() answers who is CALLING — prefetching off it seeds the delegate's record onto the owner's page",
    ).toEqual([]);
  });
});

describe("the call matcher sees what it looks for", () => {
  /**
   * Against strings, not the tree. Every leg above reports an empty offender
   * list, and that sentence is worth exactly as much as the evidence that the
   * matcher could have said otherwise. Each case below is a shape the two
   * regexes this file used to carry got wrong.
   */
  it("does not read a call out of a doc comment", () => {
    const PROSE_ONLY = `
      /**
       * Record identity: the session comes from \`getUnswitchedSession()\`,
       * which refuses to answer under a switch.
       */
      import { getSession } from "@/lib/auth/session";

      export default async function Page() {
        const session = await getSession();
        return <HydrationBoundary state={dehydrate(qc)} />;
      }
    `;
    const called = calledSymbolsIn(PROSE_ONLY, "prose.tsx");
    // The parse produced calls, so the negative below is a measurement.
    expect(called.size).toBeGreaterThan(0);
    expect(called.has("getUnswitchedSession")).toBe(false);
    expect(called.has("getSession")).toBe(true);
    // …and the raw text says otherwise, which is what the old leg read.
    expect(/getUnswitchedSession\s*\(/.test(PROSE_ONLY)).toBe(true);
  });

  it("resolves an aliased import back to the symbol it was exported as", () => {
    const ALIASED = `
      import { getSession as loadSession } from "@/lib/auth/session";

      export default async function Page() {
        const session = await loadSession();
        return null;
      }
    `;
    expect(calledSymbolsIn(ALIASED, "alias.tsx").has("getSession")).toBe(true);
    // The alias is why the old leg missed it: nothing in the file reads
    // `getSession(`, so a regex keyed on the call shape found nothing.
    expect(/\bgetSession\s*\(/.test(ALIASED)).toBe(false);
  });

  it("resolves a namespace-qualified call", () => {
    const NAMESPACED = `
      import * as auth from "@/lib/auth/session";

      export default async function Page() {
        const session = await auth.getSession();
        return null;
      }
    `;
    expect(calledSymbolsIn(NAMESPACED, "ns.tsx").has("getSession")).toBe(true);
  });

  it("does not count an imported-but-uncalled helper", () => {
    const IMPORTED_ONLY = `
      import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
      import { getSession } from "@/lib/auth/session";

      export default async function Page() {
        const session = await getSession();
        return <span>{getUnswitchedSession.name}</span>;
      }
    `;
    const called = calledSymbolsIn(IMPORTED_ONLY, "io.tsx");
    expect(called.has("getUnswitchedSession")).toBe(false);
    expect(called.has("getSession")).toBe(true);
  });

  it("finds the plain call the compliant pages make", () => {
    const COMPLIANT = `
      import { getUnswitchedSession } from "@/lib/auth/acting-carrier";

      export default async function Page() {
        const session = await getUnswitchedSession();
        return null;
      }
    `;
    const called = calledSymbolsIn(COMPLIANT, "ok.tsx");
    expect(called.has("getUnswitchedSession")).toBe(true);
    expect(called.has("getSession")).toBe(false);
  });
});
