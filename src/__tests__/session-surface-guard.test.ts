/**
 * Structural guards on the surfaces that resolve a caller's identity.
 *
 * `bearer-scope-enforcement-guard.test.ts` freezes ONE mechanism: the files
 * that turn an `Authorization: Bearer` value into a user. That guard is
 * correct and it holds. What it is not is coverage of "who can resolve a
 * caller". Two other families do the same job by other means, and a sweep
 * written by copying the Bearer guard sees neither of them:
 *
 *   A. A route or page that reads the session cookie itself, instead of
 *      going through `requireAuth()` inside `apiHandler`. `requireAuth` is
 *      where the fail-closed scope arm, the audit row, and the admin
 *      boundary live; a direct `getSession()` has none of them and answers
 *      to nothing but the file it sits in.
 *   B. A surface whose whole credential is a token in the URL — the
 *      clinician share tree serves one person's complete health record to
 *      an anonymous caller holding an `hls_` path segment, and never
 *      touches a session at all. No amount of grepping for `getSession`
 *      will ever show it to you.
 *
 * Neither family is wrong. Both are deliberate, and both are documented at
 * their own call sites. The defect this file closes is that nothing said so
 * when a new member joined.
 *
 * These are tripwires, not proofs. They cannot show an allowlist is
 * correct — only that it has not changed without someone editing this file.
 *
 * A note on why every matcher carries its own count assertion: several legs
 * below overlap (four of the five share-token files also sit under a
 * `[token]` segment). If one leg's regex silently stopped matching, the
 * union would be unchanged and the guard would stay green for the wrong
 * reason. Each leg therefore asserts its own membership, so a matcher that
 * matches nothing fails instead of passing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Every non-test `.ts` / `.tsx` under `src/app/`, which is the whole of the
 * request-handling tree: API routes, RSC pages, layouts, route handlers.
 * The generated Prisma client is excluded by construction (it is not under
 * `app/`) and never read — see CLAUDE.md.
 */
function appFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => p.startsWith("app/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function appFilesMatching(re: RegExp): string[] {
  return appFiles().filter((rel) => re.test(read(rel)));
}

describe("S1 — the direct session-resolution set is frozen", () => {
  /**
   * Files under `src/app` that resolve the caller from the session cookie
   * WITHOUT going through `requireAuth()`. Every other authenticated route
   * in the tree — 300-odd of them — reaches its user through `apiHandler`
   * plus `requireAuth`, which is what makes this list short enough to read.
   *
   * An entry here is not a finding. It is a place where the protections
   * `requireAuth` applies centrally have to be argued locally, so the
   * reason is the point of the entry.
   */
  const SESSION_RESOLUTION_ALLOWLIST: Record<string, string> = {
    // Completes the native ASWebAuthenticationSession handoff. Validates the
    // browser session itself because it also needs `session.createdAt` for
    // the freshness comparison, which `requireAuth` does not project.
    "app/api/auth/native/complete/route.ts":
      "reads createdAt for the handoff freshness check",
    // Anonymous IdP callback. Probes for an already-valid session so a
    // replayed callback redirects instead of minting a second identity.
    "app/api/auth/oidc/callback/route.ts":
      "duplicate-callback probe on an otherwise anonymous route",
    // Public liveness probe. The session read only decides whether the body
    // carries operational detail; the status code is computed without it.
    "app/api/health/route.ts": "admin-only detail on a public probe",
    // OAuth authorize runs under `withBackgroundEvent`, not `apiHandler`,
    // because it owes RFC-format error bodies — so it resolves the
    // consenting human itself.
    "app/api/mcp/oauth/authorize/route.ts":
      "consent decision on a route outside apiHandler",
    // Provider OAuth callbacks. The browser arrives as a top-level
    // navigation, so the code is bound to the session user and redirected.
    "app/api/oura/callback/route.ts":
      "binds the OAuth code to the session user",
    "app/api/polar/callback/route.ts":
      "binds the OAuth code to the session user",
    "app/api/strava/callback/route.ts":
      "binds the OAuth code to the session user",
    "app/api/whoop/callback/route.ts":
      "binds the OAuth code to the session user",
    // RSC prefetch: the server component hydrates the client query cache
    // with the session user's own data. Absence of a session skips the
    // prefetch rather than failing the render.
    //
    // These seven resolve through `getUnswitchedSession()`, not `getSession()`,
    // and they stay listed here BECAUSE of it. The helper is still a session
    // derivation outside `requireAuth` — moving the call one file deeper into
    // `lib/` would have taken them off this list while changing nothing about
    // what they do, and a guard that a refactor can walk out of is not one.
    // What the helper adds is the record identity: it answers null while the
    // browser acts on somebody else's record, so the cache these pages seed
    // can only ever hold the caller's own. See
    // `prefetch-page-caching-guard.test.ts` for the rule that keeps a sixth
    // prefetching page from reaching for the bare helper.
    "app/checkups/page.tsx":
      "RSC prefetch of the session user's reminder list, skipped under a switch",
    "app/coach/page.tsx":
      "RSC prefetch of the session user's coach state, skipped under a switch",
    "app/insights/page.tsx":
      "RSC prefetch of the session user's insights, skipped under a switch",
    "app/insights/workouts/page.tsx":
      "RSC prefetch of the session user's workouts, skipped under a switch",
    "app/medications/page.tsx":
      "RSC prefetch of the session user's medications, skipped under a switch",
    "app/mood/page.tsx":
      "RSC prefetch of the session user's mood list, skipped under a switch",
    "app/page.tsx":
      "RSC prefetch of the session user's dashboard snapshot, skipped under a switch",
    // Onboarding routing. Reads the actor's OWN setup state through
    // `loadOnboardingFlowState` (a `getSession` wrapper, listed in the regex
    // below) to guard the step URL and to render the screens; the three
    // writes behind them refuse under a switch, so the pages read the same
    // record the routes write.
    "app/onboarding/[step]/page.tsx":
      "guards the step URL on the actor's own setup state",
    "app/onboarding/page.tsx":
      "resumes or welcomes on the actor's own setup state",
  };

  /**
   * The identity-deriving helpers exported by `lib/auth/session.ts`, plus the
   * one that wraps it. The lifecycle exports (`createSession`,
   * `destroySession`, `destroyAllSessions`, `destroySessionById`,
   * `destroyOtherSessions`) are deliberately NOT here: they act on a session,
   * they do not hand the handler an identity to scope a query by. Adding a
   * further deriving helper means adding it to this regex.
   *
   * `getUnswitchedSession` (`lib/auth/acting-carrier.ts`) is listed for the
   * reason a wrapper is the easiest way to disappear from a guard: it returns
   * `getSession()`'s answer or null, so a caller of it derives an identity
   * exactly as much as a caller of the thing it wraps. v1.39 (C2) —
   * `loadOnboardingFlowState` (`lib/onboarding/load-flow-state.ts`) is the
   * same shape: `getSession()` plus the caller's own setup row.
   */
  const SESSION_DERIVING_HELPERS =
    /\b(getSession|getUnswitchedSession|getSessionUserLocale|validateSessionFromCookieValue|validateSessionWithCreatedAt|loadOnboardingFlowState)\s*\(/;

  /**
   * Reaching for the cookie by name is the way around the helpers. Both the
   * exported constant and the raw literal count.
   */
  const RAW_SESSION_COOKIE = /\bSESSION_COOKIE_NAME\b|"healthlog_session"/;

  it("no file under src/app derives a session outside requireAuth unlisted", () => {
    const resolvers = appFilesMatching(SESSION_DERIVING_HELPERS);

    // Non-zero proof. If the helper names are ever renamed out from under
    // this regex, the match set collapses to empty — which must fail here
    // rather than quietly agree with an emptied allowlist.
    expect(resolvers.length).toBeGreaterThan(0);
    expect(resolvers).toEqual(Object.keys(SESSION_RESOLUTION_ALLOWLIST).sort());
  });

  it("no file under src/app reads the session cookie by name unlisted", () => {
    const cookieReaders = appFilesMatching(RAW_SESSION_COOKIE);

    // Same non-zero proof, for this leg's own matcher. These two files also
    // appear in the leg above, which is exactly why this count is asserted
    // separately: an overlapping leg cannot borrow another leg's evidence.
    expect(cookieReaders.length).toBeGreaterThan(0);
    expect(cookieReaders).toEqual([
      "app/api/auth/native/complete/route.ts",
      "app/api/auth/oidc/callback/route.ts",
    ]);

    // And whatever it finds must already be an argued session surface.
    for (const rel of cookieReaders) {
      expect(Object.keys(SESSION_RESOLUTION_ALLOWLIST)).toContain(rel);
    }
  });

  it("every allowlist entry carries a reason", () => {
    for (const [rel, reason] of Object.entries(SESSION_RESOLUTION_ALLOWLIST)) {
      expect(reason.trim().length, `${rel} has no reason`).toBeGreaterThan(0);
    }
  });
});

describe("S2 — the URL-token authentication set is frozen", () => {
  /**
   * Files whose credential is a token in the URL — a path segment or a
   * query parameter — rather than a session cookie or a Bearer header.
   *
   * This is the family the Bearer guard cannot see and a `getSession` sweep
   * cannot see. `src/app/c/[token]/**` resolves one user's entire health
   * record from an `hls_` path segment held by an anonymous caller. That is
   * the product's design, it predates every guard in this file, and it is
   * not a defect. What was a defect is that a sixth door could have been
   * cut next to it without anything saying so.
   */
  const URL_TOKEN_ALLOWLIST: Record<string, string> = {
    // Clinician share link: the `hls_` path segment is the whole credential.
    "app/c/[token]/page.tsx": "serves the shared record view",
    "app/c/[token]/d/[id]/route.ts": "serves a shared document's bytes",
    "app/c/[token]/fhir/route.ts": "serves the shared record as a FHIR bundle",
    "app/c/[token]/report.pdf/route.ts": "serves the shared record as a PDF",
    // The passphrase gate for the same token. Anonymous by design; mints the
    // token-scoped unlock cookie the view above checks.
    "app/api/c/[token]/unlock/route.ts": "verifies the share-link passphrase",
    // Webhook entrypoints. The provider supports no headers on a delivery,
    // so the shared secret rides the path segment and is scrubbed from logs
    // by `PATH_SECRET_PATHS`. These resolve a record from the payload after
    // the secret compares equal.
    "app/api/whoop/webhook/[token]/route.ts":
      "path-segment shared secret, plus an HMAC body signature",
    "app/api/withings/webhook/[token]/route.ts":
      "path-segment shared secret; no body signature is available",
    // The legacy form of the same Withings secret, still alive for
    // subscriptions that have not rotated to the path-segment URL.
    "app/api/withings/webhook/route.ts":
      "legacy query-parameter form of the Withings webhook secret",
    // Shape check only. Validates the `hlv_` prefix and redirects; touches
    // no database, resolves nothing, and is not an enumeration oracle.
    // Listed because it is a URL-token surface, with the reason being that
    // it authenticates nothing.
    "app/invite/[token]/page.tsx":
      "validates the invite token's shape and redirects; no lookup",
  };

  /**
   * Leg 1 — route shape. A dynamic segment whose name carries `token` or
   * `secret` puts a credential in the URL by construction. This matcher
   * reads the filesystem, not the file, so no variable name can slip past
   * it; a new such route is caught before anyone reads its body.
   */
  function urlCredentialSegmentFiles(): string[] {
    return appFiles().filter((rel) =>
      rel.split("/").some((seg) => /^\[.*(token|secret).*\]$/i.test(seg)),
    );
  }

  /**
   * Leg 2 — share-token resolution by content, so a share surface that ever
   * moves out from under a `[token]` segment is still caught.
   */
  const SHARE_TOKEN_RESOLVERS =
    /\b(resolveShareToken|resolveShareGateState|resolveShareReportDownload|loadShareViewData)\s*\(/;

  /**
   * Leg 3 — a credential read out of the query string.
   */
  const QUERY_CREDENTIAL =
    /searchParams\.get\(\s*["'](secret|token|key|passphrase)["']\s*\)/;

  it("every URL-credential route segment is named", () => {
    const bySegment = urlCredentialSegmentFiles();

    expect(bySegment.length).toBeGreaterThan(0);
    expect(bySegment).toEqual([
      "app/api/c/[token]/unlock/route.ts",
      "app/api/whoop/webhook/[token]/route.ts",
      "app/api/withings/webhook/[token]/route.ts",
      "app/c/[token]/d/[id]/route.ts",
      "app/c/[token]/fhir/route.ts",
      "app/c/[token]/page.tsx",
      "app/c/[token]/report.pdf/route.ts",
      "app/invite/[token]/page.tsx",
    ]);
  });

  it("every share-token resolver is named", () => {
    const byResolver = appFilesMatching(SHARE_TOKEN_RESOLVERS);

    expect(byResolver.length).toBeGreaterThan(0);
    expect(byResolver).toEqual([
      "app/api/c/[token]/unlock/route.ts",
      "app/c/[token]/d/[id]/route.ts",
      "app/c/[token]/fhir/route.ts",
      "app/c/[token]/page.tsx",
      "app/c/[token]/report.pdf/route.ts",
    ]);
  });

  it("every query-string credential read is named", () => {
    const byQuery = appFilesMatching(QUERY_CREDENTIAL);

    expect(byQuery.length).toBeGreaterThan(0);
    expect(byQuery).toEqual(["app/api/withings/webhook/route.ts"]);
  });

  it("the three legs together equal the frozen allowlist", () => {
    const union = [
      ...new Set([
        ...urlCredentialSegmentFiles(),
        ...appFilesMatching(SHARE_TOKEN_RESOLVERS),
        ...appFilesMatching(QUERY_CREDENTIAL),
      ]),
    ].sort();

    expect(union.length).toBeGreaterThan(0);
    expect(union).toEqual(Object.keys(URL_TOKEN_ALLOWLIST).sort());
  });

  it("every allowlist entry carries a reason", () => {
    for (const [rel, reason] of Object.entries(URL_TOKEN_ALLOWLIST)) {
      expect(reason.trim().length, `${rel} has no reason`).toBeGreaterThan(0);
    }
  });
});

describe("S3 — the two families stay distinct", () => {
  /**
   * A file that both resolves a session AND authenticates by a URL token is
   * not forbidden, but it is a shape nobody has reviewed. If one appears,
   * it should appear in a diff that says so rather than in production.
   */
  it("no file authenticates by both a session and a URL token", () => {
    const sessionFiles = appFilesMatching(
      /\b(getSession|getSessionUserLocale|validateSessionFromCookieValue|validateSessionWithCreatedAt)\s*\(/,
    );
    const tokenFiles = appFiles().filter((rel) =>
      rel.split("/").some((seg) => /^\[.*(token|secret).*\]$/i.test(seg)),
    );

    expect(sessionFiles.length).toBeGreaterThan(0);
    expect(tokenFiles.length).toBeGreaterThan(0);

    const both = sessionFiles.filter((rel) => tokenFiles.includes(rel));
    expect(both).toEqual([]);
  });
});
