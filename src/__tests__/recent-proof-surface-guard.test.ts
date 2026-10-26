/**
 * Structural guard on the recent-proof gate.
 *
 * Exporting the whole record, making a clinician share link, minting a token,
 * and the admin backup, restore, wipe and reset actions ask for a fresh proof,
 * not only a live session (`requireRecentProof` / `assertRecentCookieProof` in
 * `src/lib/auth/guards/recent-proof.ts`, imported through `src/lib/api-handler.ts`).
 * This file pins which routes those are, so a route cannot drop the gate, and a new one cannot quietly join the list of routes
 * whose Bearer arm still takes the token alone.
 *
 * Matching is on the IMPORT and then on calls of the local name, the way
 * `step-up-elevation-guard.test.ts` does it, so an aliased import is followed.
 * Every sweep asserts it matched something: a matcher that finds nothing agrees
 * with every list.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { guardSourceOf } from "./helpers/auth-guards";
import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function importedAs(rel: string, exportName: string): string[] {
  const names: string[] = [];
  for (const m of read(rel).matchAll(
    /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    if (!/api-handler$/.test(m[2])) continue;
    for (const part of m[1].split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      const aliased = piece.match(
        /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
      );
      if (aliased && aliased[1] === exportName) names.push(aliased[2]);
      else if (piece === exportName) names.push(piece);
    }
  }
  return names;
}

/** Every call of `exportName` in `rel`, as the source text of its argument. */
function callArgs(rel: string, exportName: string): string[] {
  const src = read(rel);
  const args: string[] = [];
  for (const local of importedAs(rel, exportName)) {
    for (const m of src.matchAll(
      new RegExp(`\\b${local}\\s*\\(([^)]*)\\)`, "g"),
    )) {
      args.push(m[1].replace(/\s+/g, " ").trim());
    }
  }
  return args;
}

function callers(exportName: string): string[] {
  return sourceFiles().filter(
    (rel) => rel !== "lib/api-handler.ts" && callArgs(rel, exportName).length,
  );
}

/** Routes that resolve their own caller and take the recent-proof gate. */
const RECENT_PROOF_ROUTES: Record<string, string> = {
  // Offering access to the record. No shipped client calls it on a token.
  "app/api/account/grants/route.ts": "elevation",
  // `type=all` only; the single-type exports stay on `requireAuth`.
  "app/api/export/route.ts": "elevation",
  "app/api/export/full-backup/route.ts": "elevation",
  "app/api/export/encrypted/route.ts": "elevation-if-enrolled",
  // The shipped iOS app calls these two on its token without an elevation and
  // reads a 401 outside its known paths as a dead session. Tightening them is
  // an app release first; see the iOS note for v1.39.3.
  "app/api/share-links/route.ts": "token",
  "app/api/mcp/tokens/route.ts": "token",
};

/**
 * Routes that resolve a cookie OR a token through their own resolver
 * (`requireAuth` with a scope, `requireRecordAuth`) and add the cookie arm
 * only. Their Bearer arm is the token, as with the `token` rule above: the
 * shipped app calls both with its token and no elevation.
 */
const TOKEN_ARM_COOKIE_PROOF_ROUTES = [
  "app/api/export/health-record/route.ts",
  "app/api/fhir/Patient/$everything/route.ts",
].sort();

/**
 * The connection consent. It resolves the session through `getSession`
 * (OAuth answers in its own error format, not the envelope) and asks for the
 * proof on the consent page and again on "allow".
 */
const CONSENT_PROOF_ROUTES = ["app/api/mcp/oauth/authorize/route.ts"];

/** Cookie-only routes that add the gate after their own resolver. */
const COOKIE_PROOF_ROUTES = [
  "app/api/admin/backups/[id]/download/route.ts",
  "app/api/admin/backups/[id]/restore/route.ts",
  "app/api/admin/backups/upload/route.ts",
  "app/api/admin/data/route.ts",
  "app/api/admin/users/[id]/reset-password/route.ts",
  "app/api/auth/reproof/route.ts",
  "app/api/tokens/documents/route.ts",
  "app/api/tokens/measurements/route.ts",
  "app/api/tokens/workouts/route.ts",
].sort();

describe("the recent-proof gate", () => {
  it("reads the tree it claims to sweep", () => {
    expect(sourceFiles().length).toBeGreaterThan(1500);
  });

  it("is taken by exactly the known routes, each with its Bearer rule", () => {
    const found: Record<string, string> = {};
    for (const rel of callers("requireRecentProof")) {
      const args = callArgs(rel, "requireRecentProof");
      expect(args).toHaveLength(1);
      const rule = args[0].match(/bearer:\s*"([^"]+)"/)?.[1];
      expect(rule, rel).toBeDefined();
      found[rel] = rule!;
    }
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(RECENT_PROOF_ROUTES);
  });

  it("the cookie arm is added by exactly the known routes", () => {
    const found = callers("assertRecentCookieProof");
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(
      [
        ...COOKIE_PROOF_ROUTES,
        ...TOKEN_ARM_COOKIE_PROOF_ROUTES,
        ...CONSENT_PROOF_ROUTES,
      ].sort(),
    );
  });

  it("a route that resolves either transport asks only on the cookie", () => {
    for (const rel of TOKEN_ARM_COOKIE_PROOF_ROUTES) {
      expect(read(rel), rel).toMatch(
        /if \(auth\.authMethod === "cookie"\) \{\s*await assertRecentCookieProof\(/,
      );
    }
  });

  it("each cookie-only route resolves a cookie before it asks", () => {
    for (const rel of COOKIE_PROOF_ROUTES) {
      const resolvers = [
        ...importedAs(rel, "requireAdmin"),
        ...importedAs(rel, "requireCookieAuth"),
      ];
      expect(resolvers, rel).toHaveLength(1);
      expect(importedAs(rel, "requireAuth"), rel).toEqual([]);
    }
  });

  it("every route whose Bearer arm takes an elevation spends it", () => {
    const withElevation = Object.entries(RECENT_PROOF_ROUTES).filter(
      ([, rule]) => rule !== "token",
    );
    expect(withElevation.length).toBeGreaterThan(0);
    for (const [rel] of withElevation) {
      expect(read(rel), rel).toMatch(/\.commitElevation\(\)/);
    }
  });

  it("key rotation keeps its stricter second-factor gate", () => {
    const rel = "app/api/admin/encryption/rotate/route.ts";
    expect(callArgs(rel, "requireFreshMfa").length).toBeGreaterThan(0);
  });

  it("the gate reads the session's own stamps, and only a second factor on an enrolled account", () => {
    const src = guardSourceOf("assertRecentCookieProof", [
      "export async function assertRecentCookieProof(",
    ]);
    const start = src.indexOf("export async function assertRecentCookieProof(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\nexport ", start + 1));
    // The enrolled arm names mfaVerifiedAt alone: a password re-proof
    // (`reproofAt`) or a bare sign-in (`createdAt`) must not stand in for it.
    expect(body).toMatch(/enrolled\s*\?\s*fresh\(row\?\.mfaVerifiedAt\)\s*:/);
  });
});
