/**
 * Every `QueryClient` a server render can build keeps no garbage-collection
 * timer.
 *
 * A client component's `QueryClient` is built once per server render. With a
 * finite `gcTime`, from its defaults or from a hook, each entry the render
 * built started a timer of that length, and the timer kept the request's
 * async context: the response, the Flight stream and the compressed body.
 * Every page render stayed reachable for ten minutes after it was answered,
 * and a scanner walking unknown paths filled the heap with not-found pages.
 * `createAppQueryClient` (`src/lib/pwa/query-client-options.ts`) folds the
 * library's server default (`Infinity`) back in; its behaviour is pinned by
 * `src/lib/pwa/__tests__/query-client-server-retention.test.ts`.
 *
 * This guard keeps a client from being built around it:
 *   - a client module (`"use client"`) builds no `QueryClient` itself, it uses
 *     `createAppQueryClient`;
 *   - elsewhere, the only form allowed is a bare `new QueryClient()`, the
 *     server components' prefetch clients. Without options the library keeps
 *     `gcTime` at `Infinity` on the server, so a bare client schedules no timer
 *     unless a call site passes its own `gcTime`, which none of them do.
 *
 * Limit: the matcher is textual. A subclass of `QueryClient` declared outside
 * the options module, or a client built through an alias, slips it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceText,
  scanSourceMatches,
  stripComments,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** `new QueryClient(` with its argument list's first character. */
const CONSTRUCTION = /\bnew\s+QueryClient\s*\(\s*(\S)?/g;

const USE_CLIENT = /^\s*["']use client["']/;

function isProductionSource(rel: string): boolean {
  return (
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !rel.includes("__mocks__/") &&
    !/\.test\.tsx?$/.test(rel)
  );
}

function constructions() {
  return scanSourceMatches(SRC, CONSTRUCTION, {
    fileFloor: 500,
    // The dashboard, insights, medications, mood, coach and checkups pages
    // each prefetch on a bare client.
    matchFloor: 6,
    include: isProductionSource,
    stripComments: true,
  });
}

describe("QueryClient server garbage-collection guard", () => {
  it("builds no QueryClient inside a client module", () => {
    const offenders = constructions()
      .filter((match) =>
        USE_CLIENT.test(
          stripComments(readSourceText(join(SRC, match.file))).trimStart(),
        ),
      )
      .map((match) => `src/${match.file}:${match.line}`);

    expect(offenders).toEqual([]);
  });

  it("passes no options to a QueryClient outside the app client", () => {
    const offenders = constructions()
      .filter((match) => !match.text.endsWith(")"))
      .map((match) => `src/${match.file}:${match.line}`);

    expect(offenders).toEqual([]);
  });

  it("mounts the app client in Providers", () => {
    const source = stripComments(
      readSource("src/components/providers.tsx", "QueryClientProvider"),
    );
    expect(source).toMatch(/useState\(\s*createAppQueryClient\s*\)/);
  });

  it("still matches the constructions it is meant to catch", () => {
    const first = (code: string) => [...code.matchAll(CONSTRUCTION)][0]?.[0];
    expect(first("const c = new QueryClient();")).toBe("new QueryClient()");
    expect(first("new QueryClient({ defaultOptions })")).toBe(
      "new QueryClient({",
    );
    expect(first("new QueryClient(\n  {\n defaultOptions })")).toBe(
      "new QueryClient(\n  {",
    );
    expect(first("const c = createAppQueryClient();")).toBeUndefined();
    expect(USE_CLIENT.test('"use client";\n\nimport x from "y";')).toBe(true);
    expect(USE_CLIENT.test('import x from "y";\n"use client";')).toBe(false);
  });
});
