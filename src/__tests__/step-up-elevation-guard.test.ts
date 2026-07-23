/**
 * Structural guards on the step-up elevation boundary.
 *
 * An elevation lets a Bearer token reach a surface that is otherwise
 * cookie-only. That is a deliberate, narrow widening, and its entire safety
 * argument rests on the set of routes it can unlock being small, known, and
 * unable to grow by accident. Behavioural tests prove the mechanism works;
 * these prove nobody quietly pointed it somewhere else.
 *
 * MATCHING IS ON THE IMPORT, NOT THE CALL. An earlier revision grepped for
 * `requireMfaManagementAuth(` and was evadable in one line:
 *
 *     import { requireMfaManagementAuth as gate } from "@/lib/api-handler";
 *     const auth = await gate();
 *
 * A call-shaped regex sees nothing there. An import-shaped one cannot be dodged
 * that way, because the binding has to be imported from the module under some
 * local name before it can be called at all. The helpers below parse the import
 * specifier — including its `as` alias — and check calls against the LOCAL name,
 * so a rename is followed rather than lost.
 *
 * They remain tripwires, not proofs. They cannot show an allowlist is correct,
 * only that it has not changed without someone editing this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { globSync } from "node:fs";

const SRC = join(process.cwd(), "src");

function sourceFiles(): string[] {
  return globSync("**/*.{ts,tsx}", { cwd: SRC })
    .filter(
      (p) => !p.startsWith(`generated${sep}`) && !p.startsWith("generated/"),
    )
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((p) => p.split(sep).join("/"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Local names bound for `exportName` from any module matching `moduleRe`. */
function importedAs(
  rel: string,
  exportName: string,
  moduleRe: RegExp,
): string[] {
  const src = read(rel);
  const names: string[] = [];
  for (const m of src.matchAll(
    /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    const [, clause, specifier] = m;
    if (!moduleRe.test(specifier)) continue;
    for (const part of clause.split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const aliased = piece.match(
        /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
      );
      if (aliased) {
        if (aliased[1] === exportName) names.push(aliased[2]);
      } else if (piece === exportName) {
        names.push(piece);
      }
    }
  }
  return names;
}

const API_HANDLER = /api-handler$/;
const STEP_UP_MODULE = /auth\/step-up$/;

/** Files that import `exportName` from the module AND call it. */
function callers(exportName: string, moduleRe: RegExp): string[] {
  return sourceFiles()
    .filter((rel) => {
      const locals = importedAs(rel, exportName, moduleRe);
      if (locals.length === 0) return false;
      const src = read(rel);
      return locals.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(src));
    })
    .sort();
}

/**
 * Every route an elevation can unlock. This is the whole set — the second-factor
 * management MUTATIONS and nothing besides.
 *
 * What is deliberately ABSENT is as much the point as what is present:
 *   - `GET /api/auth/me/mfa`. The status read is plain `requireAuth()`: it
 *     carries no credential material (no secret, no code, no public key, no
 *     credential id — only names, dates, and a count), the web shows the same
 *     screen to any authenticated session, and `/api/auth/me` already exposes
 *     `totpConfirmedAt` over Bearer. Gating it would force a factor re-proof to
 *     render a screen and buy nothing;
 *   - every `/api/admin/*` route. `requireAdmin` is cookie-only and does not
 *     consult this mechanism at all;
 *   - the trusted-device routes. "Remember this browser" is a browser concept
 *     with no native equivalent to manage;
 *   - `requireFreshMfaIfEnrolled`'s callers (password change, account deletion,
 *     data reset, encrypted export, encryption-key rotation). Those are
 *     destructive account actions, not second-factor management, and letting an
 *     elevation satisfy them would be exactly the silent widening this file
 *     exists to prevent.
 */
const ELEVATION_ROUTES = [
  "app/api/auth/me/mfa/disable/route.ts",
  "app/api/auth/me/mfa/recovery-codes/regenerate/route.ts",
  "app/api/auth/me/mfa/totp/confirm/route.ts",
  "app/api/auth/me/mfa/totp/setup/route.ts",
  "app/api/auth/me/mfa/webauthn/[id]/route.ts",
  "app/api/auth/me/mfa/webauthn/register/options/route.ts",
  "app/api/auth/me/mfa/webauthn/register/verify/route.ts",
].sort();

describe("S1 — the elevation-accepting route set is frozen", () => {
  it("only the known MFA-management mutations call the gate", () => {
    const found = callers("requireMfaManagementAuth", API_HANDLER).filter(
      (rel) => rel !== "lib/api-handler.ts",
    );
    expect(found).toEqual(ELEVATION_ROUTES);
  });

  it("follows an aliased import rather than losing it", () => {
    // Guards the guard. Without this the allowlist above is one rename away
    // from meaningless, which is precisely how the previous revision was
    // evadable.
    const probe = `
      import { requireMfaManagementAuth as gate } from "@/lib/api-handler";
      const auth = await gate();
    `;
    const names: string[] = [];
    for (const m of probe.matchAll(
      /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
    )) {
      for (const part of m[1].split(",")) {
        const aliased = part
          .trim()
          .match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliased && aliased[1] === "requireMfaManagementAuth") {
          names.push(aliased[2]);
        }
      }
    }
    expect(names).toEqual(["gate"]);
    expect(new RegExp(`\\b${names[0]}\\s*\\(`).test(probe)).toBe(true);
  });

  it("no admin route calls the gate", () => {
    const admin = callers("requireMfaManagementAuth", API_HANDLER).filter(
      (rel) => rel.startsWith("app/api/admin/"),
    );
    expect(admin).toEqual([]);
  });

  it("the old cookie-only gates no longer linger on the MFA surface", () => {
    for (const rel of ELEVATION_ROUTES) {
      expect(importedAs(rel, "requireCookieAuth", API_HANDLER)).toEqual([]);
      expect(importedAs(rel, "requireFreshMfa", API_HANDLER)).toEqual([]);
    }
  });

  it("every gated route spends its elevation", () => {
    // `commitElevation` is what makes the proof single-use. A route that gates
    // but never commits would leave the elevation redeemable for the rest of
    // its window — the one fail-open the two-phase split introduces, closed
    // here.
    for (const rel of ELEVATION_ROUTES) {
      expect(read(rel)).toMatch(/\.commitElevation\(\)/);
    }
  });
});

describe("S2 — mint and redeem happen in exactly one place each", () => {
  it("only the gate claims an elevation", () => {
    const found = callers("claimStepUpElevation", STEP_UP_MODULE).filter(
      (rel) => rel !== "lib/auth/step-up.ts",
    );
    expect(found).toEqual(["lib/api-handler.ts"]);
  });

  it("only the gate validates one", () => {
    const found = callers("validateStepUpElevation", STEP_UP_MODULE).filter(
      (rel) => rel !== "lib/auth/step-up.ts",
    );
    expect(found).toEqual(["lib/api-handler.ts"]);
  });

  it("only the mint route mints one", () => {
    const found = callers("mintStepUpElevation", STEP_UP_MODULE).filter(
      (rel) => rel !== "lib/auth/step-up.ts",
    );
    expect(found).toEqual(["app/api/auth/step-up/route.ts"]);
  });

  it("no file outside the gate reads the elevation header", () => {
    // Both spellings — the literal string AND the exported constant — across
    // every source file, not only `route.ts`. A helper could read it too.
    const offenders = sourceFiles()
      .filter((rel) => rel !== "lib/api-handler.ts")
      .filter((rel) => {
        const src = read(rel);
        if (/["']x-step-up["']/i.test(src)) return true;
        return (
          importedAs(rel, "STEP_UP_ELEVATION_HEADER", API_HANDLER).length > 0
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe("S3 — requireAdmin stays cookie-only", () => {
  it("resolves through getSession and nothing else", () => {
    const src = read("lib/api-handler.ts");
    const body = src.slice(
      src.indexOf("export async function requireAdmin("),
      src.indexOf("export async function requireCookieAuth("),
    );
    expect(body).toContain("await getSession()");
    expect(body).not.toMatch(/authenticateBearer|resolveBearerToken/);
    expect(body).not.toMatch(
      /claimStepUpElevation|validateStepUpElevation|STEP_UP_ELEVATION_HEADER|requireMfaManagementAuth/,
    );
  });
});

describe("S4 — the mint surface refuses a cookie", () => {
  it("both step-up routes resolve via requireBearerAuth only", () => {
    for (const rel of [
      "app/api/auth/step-up/route.ts",
      "app/api/auth/step-up/options/route.ts",
    ]) {
      expect(importedAs(rel, "requireBearerAuth", API_HANDLER)).toEqual([
        "requireBearerAuth",
      ]);
      expect(importedAs(rel, "requireAuth", API_HANDLER)).toEqual([]);
      expect(importedAs(rel, "requireCookieAuth", API_HANDLER)).toEqual([]);
    }
  });

  it("requireBearerAuth never consults the session cookie", () => {
    const src = read("lib/api-handler.ts");
    const body = src.slice(
      src.indexOf("export async function requireBearerAuth("),
      src.indexOf("export const STEP_UP_ELEVATION_HEADER"),
    );
    expect(body).not.toContain("getSession(");
  });
});

describe("S5 — a password proof cannot satisfy a fresh-factor gate", () => {
  it("the fresh-factor set excludes password", async () => {
    // The B1 invariant, pinned at the definition. The web stamps
    // `mfaVerifiedAt` only for a completed second factor or a primary passkey
    // login; the Bearer arm must not be looser.
    const { FRESH_FACTOR_METHODS, isFreshFactorMethod } =
      await import("@/lib/auth/step-up");
    expect([...FRESH_FACTOR_METHODS].sort()).toEqual([
      "passkey",
      "totp",
      "webauthn",
    ]);
    expect(isFreshFactorMethod("password")).toBe(false);
  });

  it("the destructive routes all request the fresh-factor arm", () => {
    // Miss this on one route and a password-proved elevation tears down the
    // second factor there.
    for (const rel of [
      "app/api/auth/me/mfa/disable/route.ts",
      "app/api/auth/me/mfa/recovery-codes/regenerate/route.ts",
      "app/api/auth/me/mfa/webauthn/[id]/route.ts",
    ]) {
      expect(read(rel)).toMatch(/freshFactor:\s*true/);
    }
  });

  it("the claim re-checks the factor rather than trusting the validation", () => {
    const src = read("lib/auth/step-up.ts");
    const claim = src.slice(
      src.indexOf("export async function claimStepUpElevation("),
    );
    expect(claim).toMatch(/requireFreshFactor\s*&&\s*!isFreshFactorMethod/);
  });
});
