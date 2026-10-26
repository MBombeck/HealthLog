/**
 * The native OIDC leg ends at `healthlog://oidc-callback?error=<reason>`, and
 * the app maps each reason to its own message. The only written contract for
 * that vocabulary is the login route's 302 description in the OpenAPI
 * registry (the callback itself is provider-driven and has no entry).
 *
 * An app build once matched against hyphenated shorthand from a coordination
 * note (`identity-conflict`) while the server sent `oidc_identity_conflict`,
 * so every reason fell through to the generic message. This binds the two
 * ends that can be read exactly: every reason either route can send on a
 * redirect a native client may receive is named in that description, and
 * nothing is named there that no route sends.
 *
 * Its limit: it reads string literals passed to the redirect helpers, so a
 * reason assembled at runtime would slip past it. None is today.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Literal reasons passed to one of the named redirect helpers. */
function reasons(source: string, helpers: string[]): Set<string> {
  const found = new Set<string>();
  const pattern = new RegExp(
    `\\b(?:${helpers.join("|")})\\(\\s*"(oidc_[a-z_]+)"\\s*\\)`,
    "g",
  );
  for (const m of source.matchAll(pattern)) found.add(m[1]);
  return found;
}

describe("native OIDC error reasons are documented", () => {
  // The login route answers both legs through `loginError`; the callback's
  // native-aware helper is `failRedirect`. `errorRedirect` in the callback is
  // the browser-only branch taken before the state (and so the native flag)
  // could be read, and never reaches the app. The account resolution the
  // callback calls names its refusals through `refuse`, and the callback
  // hands each one to `failRedirect`.
  const sent = new Set([
    ...reasons(read("app/api/auth/oidc/login/route.ts"), ["loginError"]),
    ...reasons(read("app/api/auth/oidc/callback/route.ts"), ["failRedirect"]),
    ...reasons(read("lib/auth/oidc-callback/resolve-account.ts"), ["refuse"]),
  ]);

  // The login route's 302 description is one string literal on one line.
  const description =
    read("lib/openapi/routes/auth.ts")
      .split("\n")
      .find(
        (line) =>
          line.includes("healthlog://oidc-callback?error=<reason>") &&
          line.includes("oidc_invalid_request"),
      ) ?? "";
  const documented = new Set(
    [...description.matchAll(/`(oidc_[a-z_]+)`/g)].map((m) => m[1]),
  );

  it("finds the reasons on both ends", () => {
    expect(sent.size).toBeGreaterThanOrEqual(8);
    expect(documented.size).toBeGreaterThanOrEqual(8);
  });

  it("documents every reason a route sends", () => {
    expect([...sent].filter((r) => !documented.has(r))).toEqual([]);
  });

  it("documents no reason that no route sends", () => {
    expect([...documented].filter((r) => !sent.has(r))).toEqual([]);
  });
});
