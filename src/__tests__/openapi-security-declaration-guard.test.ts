/**
 * Every published operation says how a caller authenticates, or says it does
 * not have to.
 *
 * The document defined `bearerAuth` and `cookieAuth` under
 * `components.securitySchemes` and then referenced neither. There was no
 * document-level `security` and no operation-level one, so the schemes were
 * decoration: a client generated from the contract wires no `Authorization`
 * header and no cookie, and reads all of it as an open API. The schemes being
 * present is what made it invisible, because the obvious check ("are the
 * schemes declared?") passed.
 *
 * So this guard checks the reference, not the declaration. Each operation must
 * resolve to exactly one of two states:
 *
 *   - it inherits the document-level `security`, which offers the two schemes
 *     as alternatives, or
 *   - it carries `security: []`, the explicit way OpenAPI says "no credential
 *     required", and its path appears in {@link UNAUTHENTICATED} below.
 *
 * ## Why the allowlist is derived from handlers, not from the proxy
 *
 * `PUBLIC_PATHS` in `src/proxy.ts` is a different question. It says which paths
 * the edge lets through without a session; it does not say the handler behind
 * one accepts an anonymous caller. `/api/ingest/medication` is on that list and
 * resolves a Bearer token itself, so it is authenticated in the contract sense
 * while being public at the edge. Reading the proxy list as the answer would
 * publish that route as open.
 *
 * ## What this does NOT prove
 *
 * It proves the operation names a scheme, not that the server enforces the one
 * it names. A route documented as `cookieAuth` that in fact admits a Bearer
 * would pass here; `bearer-scope-enforcement-guard.test.ts` and
 * `session-surface-guard.test.ts` are what hold that end.
 *
 * Mutation check: drop the document-level `security` from the registry and
 * every authenticated operation fails here; add `security: []` to an operation
 * that is not on the list below and it fails naming that operation.
 */
import { describe, expect, it } from "vitest";

import { openApiPaths } from "@/lib/openapi/routes";
import { buildOpenApiDocument } from "@/lib/openapi/registry";
import { RETIRED_ROUTES } from "@/lib/http/retired-routes";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Operations that genuinely take no credential, with what makes each one so.
 *
 * Every entry is a route whose handler serves an anonymous caller. A route that
 * merely sits on the proxy's public-path list does not belong here.
 */
const UNAUTHENTICATED: Readonly<Record<string, string>> = {
  // `/api/auth/oidc/callback` is deliberately absent. It is anonymous, but it
  // is not published at all: the provider drives it with its own query string
  // and no client constructs one, so it is exempted from the contract by the
  // coverage guard rather than published with an opt-out. This test is what
  // caught the entry when it was written from the proxy's public-path list
  // instead of from the published set.
  "/api/health":
    "Container healthcheck. Answers before any user exists and outside the response envelope.",
  "/api/version":
    "Build identity. Read by operators and by the update check; carries nothing account-scoped.",
  "/api/auth/login":
    "Mints the session. There is no credential to present yet.",
  "/api/auth/register":
    "Creates the first credential. Refused outright when registration is closed.",
  "/api/auth/registration-status":
    "Says whether registration is open, so the sign-in screen can decide what to offer.",
  "/api/auth/passkey/login-options":
    "The WebAuthn challenge that precedes a passkey sign-in.",
  "/api/auth/passkey/login-verify":
    "Completes the passkey sign-in; the assertion is the credential.",
  "/api/auth/oidc/login":
    "Starts the identity-provider handoff, for the browser and for the native client.",
  "/api/auth/oidc/status":
    "Says whether single sign-on is configured, so the sign-in screen can offer it.",
  "/api/notifications/vapid":
    "The instance's public Web Push key. Public by definition.",
  "/api/auth/claim/preview":
    "Previews a managed-profile handover link for a person who has no credential yet; the one-time token in the body is the credential.",
  "/api/auth/claim":
    "Turns a managed profile into the claimant's own account and creates their first credential; the one-time token in the body authorises it.",
  // The tombstones, sourced from the registry rather than restated one by one.
  // A retired path answers 410 from the proxy before any handler runs, and that
  // answer never reads the request's cookies or Authorization header — so it is
  // genuinely credential-free, and publishing it as authenticated would tell a
  // client to sign in to be told the path is gone. Sourced rather than listed
  // because a hand-written entry per retirement is a step someone forgets, and
  // forgetting it here would fail the opt-out check rather than the retirement.
  ...Object.fromEntries(
    RETIRED_ROUTES.map((route) => [
      route.path,
      `Removed in v${route.removedIn}. The 410 is produced at the edge and reads no credential.`,
    ]),
  ),
};

describe("the contract says how each operation is authenticated", () => {
  const doc = buildOpenApiDocument() as unknown as {
    security?: unknown[];
    components?: { securitySchemes?: Record<string, unknown> };
  };
  const paths = openApiPaths as Record<string, Record<string, unknown>>;

  it("declares a document-level default that references the schemes", () => {
    const schemes = Object.keys(doc.components?.securitySchemes ?? {});
    expect(
      schemes.length,
      "the schemes themselves went missing, which is a different failure",
    ).toBeGreaterThan(0);

    const declared = JSON.stringify(doc.security ?? []);
    const unreferenced = schemes.filter(
      (scheme) => !declared.includes(`"${scheme}"`),
    );

    expect(
      unreferenced,
      "these schemes are defined and referenced by nothing, so a generated client ignores them",
    ).toEqual([]);
  });

  it("every operation either inherits that default or opts out on purpose", () => {
    const undeclaredOptOut: string[] = [];

    for (const [path, item] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method] as { security?: unknown[] } | undefined;
        if (!operation) continue;
        // No `security` key at all means the document-level default applies,
        // which is the authenticated case and needs nothing here.
        if (operation.security === undefined) continue;
        if (
          Array.isArray(operation.security) &&
          operation.security.length === 0 &&
          !(path in UNAUTHENTICATED)
        ) {
          undeclaredOptOut.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(
      undeclaredOptOut,
      "these operations publish themselves as needing no credential without a reason on record",
    ).toEqual([]);
  });

  it("the opt-out list names operations that are published", () => {
    const stale = Object.keys(UNAUTHENTICATED).filter(
      (path) => !(path in paths),
    );

    expect(
      stale,
      "an opt-out for a path the document does not publish hides the next one that needs a look",
    ).toEqual([]);
  });

  it("each opted-out operation actually carries the empty array", () => {
    // The counterpart to the check above. A path listed as unauthenticated but
    // silently inheriting the authenticated default publishes the opposite of
    // what this file records, and the list would read as if it had been applied.
    const missing: string[] = [];

    for (const path of Object.keys(UNAUTHENTICATED)) {
      const item = paths[path];
      if (!item) continue;
      const declared = HTTP_METHODS.filter((method) => item[method]).filter(
        (method) => {
          const operation = item[method] as { security?: unknown[] };
          return (
            Array.isArray(operation.security) && operation.security.length === 0
          );
        },
      );
      if (declared.length === 0) missing.push(path);
    }

    expect(
      missing,
      "these paths are recorded as needing no credential and do not say so in the document",
    ).toEqual([]);
  });
});
