/**
 * Every file under a URL-credential route segment (`[token]`, `[secret]`,
 * the same rule as `session-surface-guard.test.ts`), with how it answers a
 * link it does not know, or one that was revoked or has ended.
 *
 * Read by two guards: `src/__tests__/url-credential-miss-guard.test.ts` holds
 * the list to the tree and checks the pages through the proxy, and
 * `tests/integration/url-credential-miss.test.ts` calls every route against
 * a real database and checks the status.
 */

/** Matches a URL-credential route segment. */
export const URL_CREDENTIAL_SEGMENT = /^\[.*(token|secret).*\]$/i;

export interface CredentialPage {
  /** A path under this page with a token nobody holds. */
  probe: string;
  /** Where the proxy sends that probe before any page renders. */
  redirectsTo: RegExp;
  why: string;
}

/**
 * Pages. A page renders under the root loading boundary, which sends the
 * status line before its lookup ends, so a page can never answer a dead link
 * with a 404 itself. Each page here is answered at the edge first.
 */
export const CREDENTIAL_PAGES: Record<string, CredentialPage> = {
  "c/[token]/view/page.tsx": {
    probe: `/c/hls_${"0".repeat(48)}/view`,
    redirectsTo: /\/c\/hls_0{48}$/,
    why: "without the entry route's gate cookie the proxy sends it to /c/<token>, which answers 404",
  },
  "claim/[token]/page.tsx": {
    probe: `/claim/hlp_${"0".repeat(64)}`,
    redirectsTo: /\/auth\/claim\?token=/,
    why: "the proxy hops every handover link to /auth/claim, the same for any token; the claim checks it by POST",
  },
  "invite/[token]/page.tsx": {
    probe: `/invite/hlv_${"0".repeat(64)}`,
    redirectsTo: /\/auth\/register\?invite=/,
    why: "the proxy hops every invite to /auth/register, the same for any token; registration checks it",
  },
};

/** Files under a credential segment that are neither page nor route. */
export const CREDENTIAL_SUPPORT_FILES: Record<string, string> = {
  "c/[token]/not-found.tsx":
    "the copy a link that dies after the gate shows; reads no token",
};

export interface CredentialRoute {
  /** The verb a dead link is probed with, or null when none applies. */
  method: "GET" | null;
  /** The status every miss answers with. */
  missStatus: 404 | 401;
  /** Route params for the probe, the credential segment left to the test. */
  params?: Record<string, string>;
  /** A well-formed token of this surface's shape that nobody holds. */
  unknownToken?: string;
  why: string;
}

/** Route handlers. */
export const CREDENTIAL_ROUTES: Record<string, CredentialRoute> = {
  "c/[token]/route.ts": {
    method: "GET",
    missStatus: 404,
    unknownToken: `hls_${"0".repeat(48)}`,
    why: "the share link's entry",
  },
  "c/[token]/d/[id]/route.ts": {
    method: "GET",
    missStatus: 404,
    params: { id: "probe" },
    unknownToken: `hls_${"0".repeat(48)}`,
    why: "a shared document",
  },
  "c/[token]/fhir/route.ts": {
    method: "GET",
    missStatus: 404,
    unknownToken: `hls_${"0".repeat(48)}`,
    why: "the shared FHIR bundle",
  },
  "c/[token]/report.pdf/route.ts": {
    method: "GET",
    missStatus: 404,
    unknownToken: `hls_${"0".repeat(48)}`,
    why: "the shared report",
  },
  "e/[token]/route.ts": {
    method: "GET",
    missStatus: 404,
    unknownToken: `hlm_${"0".repeat(48)}`,
    why: "the emergency card",
  },
  "api/cycle/feed/[token]/route.ts": {
    method: "GET",
    missStatus: 404,
    unknownToken: `hlf_${"0".repeat(48)}`,
    why: "the cycle calendar feed",
  },
  "api/care/feed/[token]/route.ts": {
    method: "GET",
    missStatus: 404,
    unknownToken: `hlf_${"0".repeat(48)}`,
    why: "the care calendar feed",
  },
  "api/c/[token]/unlock/route.ts": {
    method: null,
    missStatus: 401,
    why: "POST only: the passphrase check answers one blunt refusal for every failure",
  },
  "api/notifications/action/[token]/route.ts": {
    method: null,
    missStatus: 401,
    why: "POST only, a notification app's machine action with its own documented refusal",
  },
  "api/whoop/webhook/[token]/route.ts": {
    method: null,
    missStatus: 401,
    why: "POST only, the provider's webhook protocol",
  },
  "api/withings/webhook/[token]/route.ts": {
    method: "GET",
    missStatus: 401,
    unknownToken: "probe",
    why: "the provider's webhook protocol, which expects 401 for a wrong secret",
  },
};
