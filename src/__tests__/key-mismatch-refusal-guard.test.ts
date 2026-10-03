/**
 * Every request surface outside `apiHandler` refuses while the boot key check
 * has found a mismatch.
 *
 * `apiHandler` answers 503 `encryption.key_mismatch` before auth and before
 * the handler, so a process holding the wrong key never writes through it.
 * A route that does not wrap in `apiHandler` gets none of that: the remote
 * MCP endpoint and its OAuth bridge went without it, and an MCP write tool
 * would have sealed new rows under the wrong key, rows the next boot's probe
 * could then read as evidence that the wrong key is right.
 *
 * So: a `route.ts` under `src/app` that does not wrap in `apiHandler` must
 * call `refuseOnKeyMismatch` / `refuseOAuthOnKeyMismatch`, or sit in the
 * allowlist below with the reason it cannot touch encrypted data. A server
 * action (`"use server"`) is held to the same rule; there are none today.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Routes outside `apiHandler` that need no refusal, each with why. A file
 * belongs here only if it reads nothing from the database and writes nothing.
 */
const NO_DATA_ROUTES: Record<string, string> = {
  "app/.well-known/apple-app-site-association/route.ts":
    "static JSON built from environment variables; no database access",
  "app/.well-known/oauth-authorization-server/route.ts":
    "RFC 8414 metadata built from the configured origin; no database access",
  "app/.well-known/oauth-protected-resource/route.ts":
    "RFC 9728 metadata built from the configured origin; no database access",
};

const REFUSAL_CALL = /\brefuse(?:OAuth)?OnKeyMismatch\s*\(/;

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

/** The text of a top-level function starting at `from`, up to its closing brace. */
function functionBody(src: string, from: number): string {
  const end = src.indexOf("\n}\n", from);
  return src.slice(from, end === -1 ? undefined : end);
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("key mismatch refusal outside apiHandler", () => {
  const routes = sourceFiles().filter(
    (p) => p.startsWith("app/") && /\/route\.tsx?$/.test(p),
  );
  const outside = routes.filter((p) => !/\bapiHandler\s*\(/.test(read(p)));

  it("finds the route tree and the routes outside apiHandler", () => {
    // A matcher that matches nothing would pass every check below.
    expect(routes.length).toBeGreaterThan(300);
    expect(outside).toEqual(
      expect.arrayContaining([
        "app/mcp/route.ts",
        "app/api/mcp/oauth/authorize/route.ts",
        "app/api/mcp/oauth/register/route.ts",
        "app/api/mcp/oauth/token/route.ts",
      ]),
    );
  });

  it("every route outside apiHandler refuses, or is allowlisted with a reason", () => {
    const missing = outside.filter(
      (p) => !(p in NO_DATA_ROUTES) && !REFUSAL_CALL.test(read(p)),
    );
    expect(missing).toEqual([]);
  });

  it("an allowlisted route really stays away from the database", () => {
    for (const p of Object.keys(NO_DATA_ROUTES)) {
      expect(outside, `${p} is no longer outside apiHandler`).toContain(p);
      const src = read(p);
      expect(src, p).not.toMatch(/@\/lib\/db\b|prisma|\$queryRaw/);
    }
  });

  it("every exported handler of a refusing route calls the refusal itself", () => {
    // `export async function POST(...) { ... }` must refuse in its own body;
    // `export const POST = handleX` must refuse in `handleX`. A refusal in one
    // handler of a file proves nothing about its siblings.
    let checked = 0;
    for (const p of outside.filter((f) => !(f in NO_DATA_ROUTES))) {
      const src = read(p);
      const bodies: Array<[string, string]> = [];
      for (const m of src.matchAll(
        /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
      )) {
        bodies.push([m[1], functionBody(src, m.index)]);
      }
      for (const m of src.matchAll(
        /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*(\w+)\s*;/g,
      )) {
        const def = new RegExp(`function\\s+${m[2]}\\s*\\(`).exec(src);
        expect(def, `${p}: ${m[1]} → ${m[2]} not found`).not.toBeNull();
        bodies.push([m[1], functionBody(src, def!.index)]);
      }
      expect(bodies.length, p).toBeGreaterThan(0);
      for (const [name, body] of bodies) {
        expect(REFUSAL_CALL.test(body), `${p} ${name}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it("server actions refuse too", () => {
    const actions = sourceFiles().filter((p) =>
      /^\s*["']use server["']/m.test(read(p)),
    );
    const missing = actions.filter((p) => !REFUSAL_CALL.test(read(p)));
    expect(missing).toEqual([]);
  });
});
