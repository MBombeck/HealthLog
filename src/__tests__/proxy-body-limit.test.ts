/**
 * The proxy's body ceiling, and the routes that stay out of the proxy so their
 * larger bodies are never read before authentication.
 *
 * Next reads the body of every non-GET request the proxy matcher covers into
 * memory before the route runs. At 512 MB that let any anonymous POST make the
 * server hold half a gigabyte. The ceiling is 1 MB; the routes whose bodies are
 * legitimately larger are excluded from the matcher and bound their own body
 * after the caller is known. Three things have to stay true together, and this
 * pins each:
 *
 *   1. the ceiling in next.config.ts is 1 MB;
 *   2. the matcher, compiled exactly as Next compiles it, skips precisely the
 *      bypass list and still covers every other API route (and the tesseract
 *      worker, which needs its CSP);
 *   3. every route that reads a body larger than the ceiling is on the list.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";
import {
  PROXY_BYPASS_ROUTES,
  isProxyBypassRoute,
} from "@/lib/http/proxy-bypass-routes";

vi.mock("@/lib/process-type", () => ({ shouldRunWeb: () => true }));

const ROOT = process.cwd();
const ONE_MB = 1024 * 1024;

async function compiledMatcher(): Promise<RegExp> {
  const { config } = await import("../proxy");
  // Next's own compiler for `config.matcher`, so the test sees the regex the
  // server will actually run. Not part of Next's typed surface.
  const analysis =
    (await import("next/dist/build/analysis/get-page-static-info.js")) as unknown as {
      getMiddlewareMatchers: (
        m: unknown,
        c: Record<string, unknown>,
      ) => Array<{ regexp: string }>;
    };
  const { getMiddlewareMatchers } = analysis;
  const [m] = getMiddlewareMatchers(config.matcher, {});
  return new RegExp(m.regexp);
}

/** Every API route path, with dynamic segments filled in. */
function apiRoutePaths(): string[] {
  const appDir = join(ROOT, "src", "app");
  return walkSourceFiles(appDir, { floor: 500 })
    .filter((p) => p.startsWith("api/") && p.endsWith("/route.ts"))
    .filter((p) => !p.includes("__tests__"))
    .map((p) =>
      (
        "/" + p.replace(/\/route\.ts$/, "").replace(/\[\.{0,3}[^\]]+\]/g, "x")
      ).replace(/\/\([^)]+\)/g, ""),
    )
    .sort();
}

describe("proxy body ceiling", () => {
  it("is 1 MB, under the current option name", () => {
    const src = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(src).toMatch(/proxyClientMaxBodySize:\s*"1mb"/);
    expect(src).not.toMatch(/middlewareClientMaxBodySize/);
  });
});

describe("proxy matcher", () => {
  it("skips exactly the bypass routes and covers every other API route", async () => {
    const re = await compiledMatcher();
    const routes = apiRoutePaths();
    expect(routes.length).toBeGreaterThan(300);

    for (const route of PROXY_BYPASS_ROUTES) {
      // A dynamic segment is filled the way `apiRoutePaths` fills it.
      const path = route.replace(/\[[^\]]+\]/g, "x");
      expect(routes, `${path} is not a route`).toContain(path);
      expect(re.test(path), `${path} still passes the proxy`).toBe(false);
      expect(re.test(`${path}/`), `${path}/ still passes the proxy`).toBe(
        false,
      );
    }
    const covered = routes.filter((p) => !isProxyBypassRoute(p));
    const escaped = covered.filter((p) => !re.test(p));
    expect(escaped).toEqual([]);
  });

  it("still covers pages, the tesseract worker and sub-paths of bypass routes", async () => {
    const re = await compiledMatcher();
    for (const path of [
      "/",
      "/dashboard",
      "/labs",
      "/documents",
      "/tesseract/worker.min.js",
      "/api/auth/login",
      "/api/user/avatar/abc",
      "/api/documents/inbound/abc/extract",
      "/api/import/csv/preview",
      // The composition PUT beside the label upload stays behind the proxy.
      "/api/medications/abc/ingredients",
      // An API path ending in a static-file extension is still an API call:
      // the last segment is the caller's choice.
      "/api/mood/tags/custom/x.png",
      "/api/documents/inbound/abc.txt",
      "/api/measurements/x.svg",
    ]) {
      expect(re.test(path), path).toBe(true);
    }
    // Static files outside the API still skip it.
    for (const path of ["/icons/icon-192.png", "/og.jpg", "/robots.txt"]) {
      expect(re.test(path), path).toBe(false);
    }
  });
});

/** Byte caps a route file declares, from `maxBytes:` literals and `*_BYTES` constants. */
function declaredCaps(src: string): number[] {
  const consts = new Map<string, number>();
  for (const m of src.matchAll(
    /const\s+([A-Z0-9_]*BYTES)\s*=\s*([\d.\s*_]+);/g,
  )) {
    const value = Function(`return (${m[2].replace(/_/g, "")})`)() as number;
    consts.set(m[1], value);
  }
  const caps: number[] = [...consts.values()];
  for (const m of src.matchAll(/maxBytes:\s*([\d\s*_]+)[,\s}]/g)) {
    caps.push(Function(`return (${m[1].replace(/_/g, "")})`)() as number);
  }
  return caps;
}

describe("the bypass list is complete", () => {
  const appDir = join(ROOT, "src", "app");
  const files = walkSourceFiles(appDir, { floor: 500 }).filter(
    (p) =>
      p.startsWith("api/") &&
      p.endsWith("/route.ts") &&
      !p.includes("__tests__"),
  );
  const pathOf = (rel: string) =>
    "/" + rel.replace(/\/route\.ts$/, "").replace(/\[\.{0,3}[^\]]+\]/g, "x");

  it("lists every route whose declared body cap exceeds the ceiling", () => {
    const over = files
      .filter((rel) =>
        declaredCaps(readFileSync(join(appDir, rel), "utf8")).some(
          (n) => n > ONE_MB,
        ),
      )
      .map(pathOf);
    expect(over.length).toBeGreaterThan(5);
    expect(over.filter((p) => !isProxyBypassRoute(p))).toEqual([]);
  });

  it("lists every route that streams or multipart-parses its body", () => {
    // The OAuth forms are tiny url-encoded bodies with their own 16 KB cap.
    const SMALL_FORMS = new Set([
      "/api/mcp/oauth/token",
      "/api/mcp/oauth/register",
      "/api/mcp/oauth/authorize",
    ]);
    const streaming = files
      .filter((rel) =>
        /readBoundedBody\(|Readable\.fromWeb\(|\.formData\(\)|request\.body\b/.test(
          readFileSync(join(appDir, rel), "utf8"),
        ),
      )
      .map(pathOf)
      .filter((p) => !SMALL_FORMS.has(p));
    expect(streaming.length).toBeGreaterThan(3);
    expect(streaming.filter((p) => !isProxyBypassRoute(p))).toEqual([]);
  });
});
