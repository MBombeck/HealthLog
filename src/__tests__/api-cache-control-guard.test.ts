/**
 * No API answer is kept in a cache unless the route says why.
 *
 * `apiHandler` answers every response that names no `Cache-Control` of its
 * own with `private, no-store` (`src/lib/http/api-cache-policy.ts`). Two ways
 * around that would go unnoticed without this guard:
 *
 *   - a route handler that does not run through `apiHandler` (the OAuth
 *     routes, whose error bodies the envelope cannot express, and the MCP
 *     endpoint, whose answer the protocol library builds) and so never gets
 *     the default. Each such file must apply the policy itself or be
 *     listed below as public metadata;
 *   - a route that sets a weaker posture of its own (`max-age`, `no-cache`,
 *     `public`). Each such value is listed below with its reason. A new one
 *     fails until it is looked at here.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSource,
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Route files outside `apiHandler` that answer public metadata only. */
const PUBLIC_ROUTES_OUTSIDE_THE_WRAPPER: Record<string, string> = {
  "app/.well-known/apple-app-site-association/route.ts":
    "the universal-links file every iOS device fetches; public, the same for everyone",
  "app/.well-known/oauth-authorization-server/route.ts":
    "OAuth server metadata (RFC 8414); public, sets no-store itself",
  "app/.well-known/oauth-protected-resource/route.ts":
    "OAuth resource metadata (RFC 9728); public, sets no-store itself",
};

/**
 * `Cache-Control` values without `no-store`, by file. Everything else an API
 * answers is `no-store`.
 */
const WEAKER_POSTURES: Record<string, { values: string[]; why: string }> = {
  "app/.well-known/apple-app-site-association/route.ts": {
    values: ["public, max-age=3600"],
    why: "public file, no account data",
  },
  "app/api/monitoring/umami-script/route.ts": {
    values: ["public, max-age=60", "public, max-age=1800"],
    why: "a proxied public analytics script, no account data",
  },
  "app/api/measurement-categories/route.ts": {
    values: ["public, max-age=600"],
    why: "the static category map, the same for every account; no account data",
  },
  "app/api/feature-flags/route.ts": {
    values: ["private, max-age=60"],
    why: "the operator's deployment switches, no record data; deprecated route kept for older native builds",
  },
  "app/api/user/avatar/[id]/route.ts": {
    values: ["private, max-age=31536000, immutable"],
    why: "the caller's own avatar under a versioned URL (`?v=`), so a re-upload is a new URL; never in a shared cache",
  },
  "app/api/medications/intake/route.ts": {
    values: ["private, no-cache"],
    why: "the ETag'ed today list: the client revalidates every read with If-None-Match and gets a 304; never in a shared cache",
  },
  "lib/http/url-credential.ts": {
    values: ["private, no-cache, max-age=0"],
    why: "the ETag'ed calendar feeds a calendar app polls with If-None-Match; never in a shared cache",
  },
};

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

/** Every literal `Cache-Control` value a source text sets. */
function cacheControlValues(source: string): string[] {
  const code = stripComments(source);
  const values: string[] = [];
  const pattern = /["']cache-control["']\s*[,:]\s*["'`]([^"'`]+)["'`]/gi;
  for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
    values.push(m[1]);
  }
  return values;
}

describe("API cache posture", () => {
  const files = sourceFiles();

  it("finds the values at all (a matcher that matches nothing is no guard)", () => {
    expect(
      cacheControlValues(
        `r.headers.set("Cache-Control", "private, no-cache");`,
      ),
    ).toEqual(["private, no-cache"]);
    expect(
      cacheControlValues(`{ "cache-control": "no-store", Pragma: "no-cache" }`),
    ).toEqual(["no-store"]);
    expect(cacheControlValues(`// "Cache-Control": "public"`)).toEqual([]);
    const all = files.flatMap((f) =>
      cacheControlValues(readSourceText(join(SRC, f))),
    );
    expect(all.length).toBeGreaterThanOrEqual(20);
  });

  it("sets a posture without no-store only where listed", () => {
    const found: Record<string, string[]> = {};
    for (const rel of files) {
      const weak = cacheControlValues(readSourceText(join(SRC, rel))).filter(
        (v) => !/\bno-store\b/i.test(v),
      );
      if (weak.length > 0) found[rel] = [...new Set(weak)].sort();
    }
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(WEAKER_POSTURES).map(([f, p]) => [
          f,
          [...p.values].sort(),
        ]),
      ),
    );
  });

  it("gives every route handler outside apiHandler the same default", () => {
    const routes = files.filter(
      (p) => p.startsWith("app/") && /\/route\.tsx?$/.test(p),
    );
    expect(routes.length).toBeGreaterThan(300);
    const bare = routes.filter((rel) => {
      const code = stripComments(readSourceText(join(SRC, rel)));
      return (
        !/\bapiHandler\s*\(/.test(code) &&
        !/\b(applyApiCachePolicy|enforceApiNoStore)\s*\(/.test(code)
      );
    });
    expect(bare.sort()).toEqual(
      Object.keys(PUBLIC_ROUTES_OUTSIDE_THE_WRAPPER).sort(),
    );
  });

  it("applies the default in apiHandler itself", () => {
    const handler = stripComments(
      readSource("src/lib/api-handler.ts", "export function apiHandler"),
    );
    expect(handler).toMatch(/\bapplyApiCachePolicy\s*\(\s*nr\.headers\s*\)/);
  });
});
