/**
 * Structural invariants for the native web-handoff surface (iOS #65).
 *
 * These are tripwires, not proofs — they assert the load-bearing constructions
 * the red-team relied on stay in place: no `redirect_uri` parameter, one
 * compile-time callback constant, a trailing-slash public-path entry, the
 * cookie-only admin / step-up boundaries, and that the new routes never resolve
 * a Bearer token or mint an ApiToken.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { guardSourceOf } from "@/__tests__/helpers/auth-guards";
import { stripComments } from "../../../../../__tests__/helpers/source-files";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * Strip block + line comments so an invariant asserts against CODE, not against
 * a doc comment that legitimately names the thing it forbids (e.g. "there is no
 * `redirect_uri` parameter").
 */
function code(rel: string): string {
  return stripComments(read(rel), rel);
}

const ROUTE_FILES = [
  "app/api/auth/native/login/route.ts",
  "app/api/auth/native/complete/route.ts",
  "app/api/auth/native/token/route.ts",
];

describe("T6 — open redirect / redirect_uri removed by construction", () => {
  it("no new route or handoff module references a redirect_uri parameter", () => {
    const files = [
      ...ROUTE_FILES,
      "lib/auth/native-web-handoff.ts",
      "lib/auth/native-handoff.ts",
    ];
    // Comments legitimately state "there is no redirect_uri parameter"; the
    // invariant is that no CODE reads or builds one.
    for (const rel of files) {
      // A file read as nothing would pass the ban below.
      expect(code(rel)).toMatch(/\bexport\b/);
      expect(code(rel)).not.toMatch(/redirect_uri/);
    }
  });

  it("the callback scheme is a single compile-time constant", () => {
    // Defined exactly once, as a string literal, with no interpolation.
    const mod = read("lib/auth/native-web-handoff.ts");
    expect(mod).toMatch(
      /NATIVE_WEB_HANDOFF_REDIRECT_URI\s*=\s*"healthlog:\/\/login-callback"/,
    );
    // The routes build the Location only through the helper, never a bespoke
    // scheme string in code (doc comments naming the scheme are fine).
    for (const rel of ROUTE_FILES) {
      expect(code(rel)).toMatch(/\bexport\b/);
      expect(code(rel)).not.toMatch(/"healthlog:\/\//);
    }
  });
});

describe("A4 — public-path allowlist carries the trailing slash", () => {
  it("proxy admits exactly /api/auth/native/ (slash), never the bare prefix", () => {
    const proxy = read("proxy.ts");
    expect(proxy).toMatch(/"\/api\/auth\/native\/"/);
    // The slashless literal must not appear as its own allowlist entry.
    expect(proxy).not.toMatch(/"\/api\/auth\/native"(?!\/)/);
  });
});

describe("T12 — the new routes resolve no Bearer and mint no ApiToken", () => {
  it("no native route resolves a Bearer token or hand-rolls a tokenHash lookup", () => {
    for (const rel of ROUTE_FILES) {
      const src = read(rel);
      expect(src).not.toMatch(/resolveBearerToken/);
      expect(src).not.toMatch(/apiToken\.findUnique/);
    }
  });

  it("no native route creates an ApiToken", () => {
    for (const rel of ROUTE_FILES) {
      const src = read(rel);
      expect(src).not.toMatch(/apiToken\.create\(|issueApiToken\(/);
    }
  });
});

describe("T11/T13 — cookie-only boundaries and no bundle-in-browser", () => {
  it("the token route never sets a cookie itself", () => {
    // The bundle rides the JSON body; a Set-Cookie here would be the browser leak.
    expect(read("app/api/auth/native/token/route.ts")).not.toMatch(
      /cookies\.set|Set-Cookie/,
    );
  });

  it("requireAdmin and requireFreshMfa remain cookie-only (getSession)", () => {
    // Both resolve via getSession() (cookie-only) — restated as a tripwire so a
    // future edit that threads a Bearer into either trips this test. Read from
    // the guard module that declares each, which throws if it is gone.
    const opening = (name: string) => {
      const src = guardSourceOf(name, [`export async function ${name}(`]);
      const start = src.indexOf(`export async function ${name}(`);
      return src.slice(start, start + 600);
    };
    expect(opening("requireAdmin")).toMatch(/getSession\(\)/);
    expect(opening("requireFreshMfa")).toMatch(/getSession\(\)/);
  });
});
