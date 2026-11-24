/**
 * Structural guards: a web session cookie, and the two hint cookies that ride
 * with it, reach a browser and nothing else.
 *
 * The native client keeps every `Set-Cookie` it is sent in a shared store and
 * replays it beside its Bearer token, after its own sign-out and under the
 * next account to sign in on the device. Three routes (the password change,
 * registration, the passkey sign-in) once handed it a session cookie, and the
 * cookie used to win over the token. The behaviour is pinned by
 * `src/lib/auth/__tests__/token-transport-cookies.test.ts` and the integration
 * file `tests/integration/bearer-wins-over-cookie.test.ts`; what this file
 * keeps true is the shape that makes those few cases cover every route:
 *
 *   W1. One minter. `issueSessionCookie` is called from `session.ts` only, by
 *       `createSession` and the sliding expiry in `getSession`, and each of
 *       those two refuses the token transport before it reaches the cookie.
 *   W2. Every caller of `createSession` is named, with how it stays a browser
 *       arm. The floor in `createSession` holds regardless; the list is what
 *       makes a new caller someone's decision rather than an accident.
 *   W3. The hint cookies are written by their one setter each, and each
 *       setter refuses the token transport first.
 *
 * Every matcher asserts it found something, so a rename that empties a match
 * set fails here instead of passing for the wrong reason.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function code(rel: string): string {
  return stripComments(readSourceText(join(SRC, rel)));
}

function filesCalling(callee: string): string[] {
  const re = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`);
  return sourceFiles().filter((rel) => {
    const src = code(rel);
    // A declaration is not a call.
    const withoutDecl = src.replace(
      new RegExp(`function\\s+${callee}\\s*\\(`, "g"),
      "",
    );
    return re.test(withoutDecl);
  });
}

/** The body of `function name(...) { ... }` in `src`, braces balanced. */
function functionBody(src: string, name: string): string {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!decl) throw new Error(`no function ${name}`);
  // Past the parameter list, which may hold object types with braces.
  let i = decl.index + decl[0].length;
  for (let depth = 1; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
  }
  // Past the return type: the body opens at the first brace outside any
  // angle brackets (`Promise<{ ... } | null>` holds braces of its own).
  for (let angle = 0; i < src.length; i++) {
    if (src[i] === "<") angle++;
    else if (src[i] === ">" && src[i - 1] !== "=") angle--;
    else if (src[i] === "{" && angle === 0) break;
  }
  const bodyStart = i;
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(bodyStart, i + 1);
}

/** Whether `first` appears in `body`, and before `second` when that is given. */
function precedes(body: string, first: RegExp, second: RegExp): boolean {
  const a = first.exec(body);
  const b = second.exec(body);
  return a !== null && b !== null && a.index < b.index;
}

describe("W1 — the session cookie has one minter, and it refuses the token transport", () => {
  it("only session.ts calls issueSessionCookie", () => {
    const callers = filesCalling("issueSessionCookie");
    expect(callers.length).toBeGreaterThan(0);
    expect(callers).toEqual(["lib/auth/session.ts"]);
  });

  it("createSession refuses the token transport before it writes a row or a cookie", () => {
    const body = functionBody(code("lib/auth/session.ts"), "createSession");
    expect(
      precedes(
        body,
        /requestUsesTokenTransport\s*\(/,
        /prisma\.session\.create\s*\(/,
      ),
    ).toBe(true);
    expect(
      precedes(
        body,
        /requestUsesTokenTransport\s*\(/,
        /issueSessionCookie\s*\(/,
      ),
    ).toBe(true);
  });

  it("getSession does not read a cookie beside a Bearer", () => {
    const body = functionBody(code("lib/auth/session.ts"), "getSession");
    expect(
      precedes(body, /requestCarriesBearer\s*\(/, /readSessionCookie\s*\(/),
    ).toBe(true);
    expect(
      precedes(body, /requestCarriesBearer\s*\(/, /issueSessionCookie\s*\(/),
    ).toBe(true);
  });

  it("the caller resolver tries the Bearer before the cookie", () => {
    const body = functionBody(
      code("lib/auth/guards/caller.ts"),
      "authenticateCaller",
    );
    expect(precedes(body, /authenticateBearer\s*\(/, /getSession\s*\(/)).toBe(
      true,
    );
    const bearer = functionBody(
      code("lib/auth/guards/caller.ts"),
      "authenticateBearer",
    );
    expect(bearer).toMatch(/refuseCookieIdentityConflict\s*\(/);
  });
});

describe("W2 — every caller of createSession is a named browser arm", () => {
  /**
   * `branch` is a pattern the file must contain: the test that sends a
   * token-transport caller elsewhere before `createSession` is reached. A
   * caller with no branch is reached by a browser only, and says why.
   */
  const CREATE_SESSION_CALLERS: Record<
    string,
    { reason: string; branch?: RegExp }
  > = {
    "lib/auth/login-response.ts": {
      reason:
        "the sign-in tail: a native caller is answered with tokens and returns before the browser arm",
      branch: /shouldIssueBearerToken\s*\(|usesTokenTransport\s*\(/,
    },
    "app/api/auth/password/route.ts": {
      reason:
        "a Bearer caller is answered with a fresh token pair and returns before the session is issued",
      branch: /authMethod\s*===\s*["']bearer["']/,
    },
    "app/api/auth/passkey/login-verify/route.ts": {
      reason: "the session is issued only off the token transport",
      branch: /usesTokenTransport\s*\(/,
    },
    "app/api/auth/register/route.ts": {
      reason:
        "the session is issued only off the token transport; the app signs in afterwards",
      branch: /usesTokenTransport\s*\(/,
    },
    "app/api/auth/claim/route.ts": {
      reason:
        "the handover link is claimed from its web page; the floor in createSession covers any other caller",
    },
    "lib/auth/oidc-callback/complete-sign-in.ts": {
      reason:
        "a browser navigation back from the identity provider; the native sign-in mints a handoff code instead",
    },
    "lib/managed-profiles/claim-sso.ts": {
      reason: "the single-sign-on claim completes in the same browser callback",
    },
  };

  it("the caller set is frozen", () => {
    const callers = filesCalling("createSession");
    expect(callers.length).toBeGreaterThan(0);
    expect(callers).toEqual(Object.keys(CREATE_SESSION_CALLERS).sort());
  });

  it("each caller that also answers the token transport branches on it", () => {
    for (const [rel, { reason, branch }] of Object.entries(
      CREATE_SESSION_CALLERS,
    )) {
      expect(reason.trim().length, `${rel} has no reason`).toBeGreaterThan(0);
      if (branch) expect(code(rel), rel).toMatch(branch);
    }
  });
});

describe("W3 — the hint cookies have one setter each, and both refuse the token transport", () => {
  const SETTERS: Array<[file: string, fn: string, cookieName: RegExp]> = [
    ["lib/auth/session.ts", "setOnboardingPendingCookie", /ONBOARDING_COOKIE/],
    ["lib/auth/mfa-enrollment.ts", "setMfaEnrollCookie", /MFA_ENROLL_COOKIE/],
  ];

  it("no other file writes either cookie", () => {
    const writers = sourceFiles().filter((rel) =>
      /\.set\(\s*(ONBOARDING_COOKIE|MFA_ENROLL_COOKIE|["']hl_onboarding["']|["']hl_mfa_enroll["'])/.test(
        code(rel),
      ),
    );
    expect(writers.length).toBeGreaterThan(0);
    expect(writers).toEqual(SETTERS.map(([file]) => file).sort());
  });

  it("each setter refuses the token transport before it touches the cookie", () => {
    for (const [file, fn, cookieName] of SETTERS) {
      const body = functionBody(code(file), fn);
      expect(
        precedes(body, /requestUsesTokenTransport\s*\(/, /cookies\s*\(/),
        `${fn} must refuse first`,
      ).toBe(true);
      expect(body).toMatch(cookieName);
    }
  });
});
