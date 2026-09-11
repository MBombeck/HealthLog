import { NextResponse, type NextRequest } from "next/server";
import { shouldRunWeb } from "@/lib/process-type";
import {
  findRetiredRoute,
  retiredRouteEnvelope,
  RETIRED_ROUTE_STATUS,
} from "@/lib/http/retired-routes";

/**
 * Paths that do NOT require a session cookie (public pages + external webhooks).
 *
 * `/api/version` is intentionally public — both the in-app About page and the
 * compose healthcheck rely on it. `/api/health` stays public for the same
 * reason.
 */
export const PUBLIC_PATHS = [
  "/auth/",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/registration-status",
  "/api/auth/passkey/login-options",
  "/api/auth/passkey/login-verify",
  // OIDC SSO login. `login` starts the redirect to the IdP, `callback`
  // completes it and mints the session — both must be reachable with no
  // existing session, since they authenticate the user in the first
  // place. `status` is the public flag the login page reads to decide
  // whether to render the SSO button.
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
  "/api/auth/oidc/status",
  // v1.32.11 — first-party web-handoff login (iOS #65). `login` sets the state
  // cookie and redirects to the web login page, `complete` mints the handoff
  // code after an interactive login, `token` exchanges it. All three
  // authenticate the flow themselves (state cookie / session / handoff code),
  // never by a pre-existing session, so they bypass the page auth gate. The
  // TRAILING SLASH is load-bearing: `isPublicPath` is a bare `startsWith`, so
  // `/api/auth/native/` admits exactly this family and never `/api/auth/native-…`.
  "/api/auth/native/",
  "/api/health",
  "/api/version",
  "/api/notifications/vapid",
  "/api/monitoring/",
  "/api/send",
  "/api/withings/webhook",
  // v1.11.0 — WHOOP webhook (`recovery.updated` / `sleep.updated` /
  // `workout.updated`, + `*.deleted`). Authenticated by the path-segment
  // secret + the HMAC body signature, never by a session cookie, so it
  // must bypass the auth gate (mirrors the Withings webhook entry).
  "/api/whoop/webhook",
  "/api/telegram/webhook",
  "/api/ingest/",
  // v1.4.26 — `/privacy` is a public legal page. iOS App Store Connect
  // requires a publicly reachable Privacy-Policy URL during submission;
  // GDPR Art. 13 expects the same for any visitor before they sign up.
  "/privacy",
  // v1.4.27 B3 — `/about` carries the GeoLite2 CC BY-SA 4.0 attribution
  // alongside the project credits. The CC licence requires the
  // attribution to be reachable without a sign-in.
  "/about",
  // v1.11.0 — `/c/<token>` is the public clinician view (Epic C). It is
  // authenticated solely by the unguessable `hls_` token in the path, NOT
  // by a session cookie, so it must reach the page without an auth gate.
  // The page renders a flat 404 for any unknown / revoked / expired token.
  "/c/",
  // v1.18.7 — `/api/c/<token>/unlock` is the public passphrase-gate verifier
  // for a protected share link. Like the view it carries no session — the raw
  // path token plus the submitted passphrase are the only credentials — so it
  // must reach the route handler without an auth gate. It is rate-limited and
  // answers one blunt error for every failure class.
  "/api/c/",
  // v1.17.0 — `/invite/<hlv_token>` is the invite universal-link landing
  // (iOS #16). It is a thin shape-validated redirect onto
  // `/auth/register?invite=…`, carries no session, touches no database,
  // and is not an enumeration oracle — so it must reach the page without
  // an auth gate, like the `/auth/` register surface it forwards to.
  "/invite/",
  // Locale-catalog boot script (`/i18n/<locale>?v=…`). The login page loads
  // it pre-auth, and the body is the same public catalog JSON that ships in
  // the repository — no tenant data, no secrets. Immutable-cacheable.
  "/i18n/",
  // `/onboarding` itself + its subroutes are matched exactly via
  // `isPublicPath()` so we don't admit `/onboarding-export` etc.
  "/robots.txt",
];

/**
 * Exact-match allowlist for IETF-registered discovery endpoints
 * (RFC 8615). Apple reads `/.well-known/apple-app-site-association`
 * without credentials to wire passkey sharing and Universal Links;
 * the bare JSON body has to answer 200 before any auth gate runs.
 *
 * Exact match (not prefix) — a future `/.well-known/openid-configuration`
 * or `/.well-known/security.txt` must be added here explicitly so a new
 * sub-path doesn't auto-inherit "no auth" status.
 */
const WELL_KNOWN_PUBLIC_PATHS = new Set<string>([
  "/.well-known/apple-app-site-association",
  // v1.22.0 — OAuth discovery for the remote MCP connector. A remote client
  // (Claude.ai / ChatGPT) reads these unauthenticated to bootstrap the OAuth
  // 2.1 + PKCE flow from the pasted `/mcp` URL alone: RFC 9728 Protected
  // Resource Metadata + RFC 8414 Authorization Server Metadata. Both are
  // public, deterministic, secret-free discovery documents.
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
]);

/**
 * v1.4.22 W5 reconcile (Sec-MED-2) — `/onboarding` matches exact
 * page + subroutes (`/onboarding`, `/onboarding/*`) only, NOT the
 * loose `pathname.startsWith("/onboarding")` family that would admit
 * `/onboarding-export`, `/onboarding.json`, etc. Every other entry
 * is either a literal terminal path (`/api/version`, `/robots.txt`)
 * or already trailing-slashed (`/auth/`, `/api/auth/`); the lone
 * exception was the unsegmented `/onboarding` literal.
 */
function isPublicPath(pathname: string): boolean {
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) {
    return true;
  }
  // v1.22.0 — the remote MCP endpoint authenticates by `Authorization:
  // Bearer hlk_…`, never by a session cookie, so it must skip the page
  // cookie-redirect (mirroring the webhook / `/api/c/` header-authed
  // surfaces). The route handler resolves the Bearer token itself, gates on
  // the off-by-default `mcp` module, and rate-limits per credential. Exact
  // `/mcp` plus `/mcp/` only — a `/mcp-something` page can never inherit
  // the bypass.
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return true;
  }
  if (WELL_KNOWN_PUBLIC_PATHS.has(pathname)) {
    return true;
  }
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

/**
 * API paths that are allowed to accept mutations (POST/PUT/PATCH/DELETE)
 * even when DEMO_MODE is enabled. Everything else is read-only.
 *
 * Each entry pins the exact path AND the exact method, so admitting one
 * verb on a route never opens its siblings (e.g. the dashboard-widgets
 * PUT must not drag in the layout-reset DELETE on the same path).
 *
 * The login family is the historical baseline — a demo visitor still has
 * to authenticate. The two dashboard entries are display-only preference
 * writes: idempotent, user-scoped, Zod-validated, and touching nothing but
 * the caller's own `User.dashboardWidgetsJson` blob (chart-overlay toggles
 * + comparison-baseline selector). They carry no health data and are safe
 * to exercise in the demo so the above-chart toggles work there. This whole
 * block only runs under `DEMO_MODE=true`, so production (apps01) is
 * unaffected by construction.
 */
const DEMO_MUTATION_ALLOWLIST: ReadonlyArray<{ path: string; method: string }> =
  [
    { path: "/api/auth/login", method: "POST" },
    { path: "/api/auth/passkey/login-options", method: "POST" },
    { path: "/api/auth/passkey/login-verify", method: "POST" },
    // Chart display-pref toggles above the charts (dashboard + insights):
    { path: "/api/dashboard/chart-overlay-prefs", method: "PUT" },
    { path: "/api/dashboard/widgets", method: "PUT" },
    // v1.39 (C1) — the needs-based setup flow, which the demo has to be able
    // to complete with preset answers (design spec §Principles 5). All three
    // are user-scoped preference writes: closed enum answers, the step ledger,
    // and the module map derived from them. No health data is created by any
    // of them, and the demo account's own record is the only thing they touch.
    { path: "/api/onboarding/answers", method: "PATCH" },
    { path: "/api/onboarding/complete", method: "POST" },
    { path: "/api/onboarding/restart", method: "POST" },
    // v1.39 (C2) — the two writes the flow's welcome and exit make: the
    // one-time disclaimer acknowledgment gates both welcome buttons, and the
    // tour's progress checkpoint is what the done screen's offer leads to.
    // Without the first, a demo account on a fresh seed (or after a version
    // bump of the disclaimer) got a 403 from "Set up" and "Skip for now" both.
    // Neither creates health data.
    { path: "/api/onboarding/disclaimer", method: "POST" },
    { path: "/api/onboarding/tour", method: "POST" },
    // v1.39 (Wave C, C6) — the three writes the confirm screen makes. Without
    // them a demo visitor who typed a height got a 403 and a generic toast,
    // and the "someone I look after" arm could only take "Finish without the
    // profile" — only the empty-form/Skip path completed, so the demo did not
    // in fact walk the same flow (design spec §Principles 5). None of the
    // three creates health data: the caller's own profile fields, the
    // encrypted self-context behind the optional anamnesis card, and the
    // managed record the guardian arm of the flow exists to create. The
    // per-profile routes (`/api/managed-profiles/{id}`, its guardians) are
    // different paths and stay closed.
    { path: "/api/auth/profile", method: "PUT" },
    { path: "/api/coach/about-me", method: "PUT" },
    { path: "/api/managed-profiles", method: "POST" },
  ];

// Legacy route redirects (German → English)
const LEGACY_REDIRECTS: Record<string, string> = {
  "/stimmung": "/mood",
};

/**
 * v1.5 admin refactor — sections moved from `/admin#section-<id>` anchors
 * to per-section dynamic routes under `/admin/<slug>`. Pure URL fragments
 * (`#foo`) are never sent to the server, so we cannot redirect those
 * here; the in-app callsites (status-card-grid, anything else linking
 * into admin) have all been rewritten to use the new routes directly.
 *
 * What we *can* redirect server-side is the path-style form, in case
 * anyone bookmarked `/admin/section-XYZ` (which never existed but is a
 * plausible mis-typing) or is following an old URL where the fragment
 * was somehow promoted to a path segment by a referrer rewriter.
 */
const LEGACY_ADMIN_ANCHORS: Record<string, string> = {
  "/admin/section-system-status": "/admin/system-status",
  "/admin/section-admin-general": "/admin/general",
  "/admin/section-admin-services": "/admin/services",
  "/admin/section-admin-umami": "/admin/integrations",
  "/admin/section-admin-glitchtip": "/admin/integrations",
  "/admin/section-admin-webpush": "/admin/integrations",
  "/admin/section-admin-reminders": "/admin/reminders",
  "/admin/section-user-management": "/admin/users",
  "/admin/section-api-tokens": "/admin/api-tokens",
  "/admin/section-login-overview": "/admin/login-overview",
  "/admin/section-danger-zone": "/admin/danger-zone",
};

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Transport-level security headers every response carries, including the early
 * exits (worker-only 503, legacy 301s, demo-mode 403, and the login /
 * onboarding / MFA redirects) that return before the full header block below.
 *
 * Those exits used to answer with no HSTS, no framing refusal and no nosniff at
 * all. The gap was one hop — a redirect has no rendered body and the follow-up
 * navigation re-enters this function and does get the full set — but "the next
 * request will be protected" is not a reason for this one not to be, and HSTS
 * in particular is worth the most on the first hop over a hostile network.
 *
 * Deliberately the transport subset, not the whole block: the per-route CSP
 * below is nonce-bound and carries carve-outs for the document-serve and share
 * routes that only make sense for a response with a body to protect.
 */
function applyBaselineSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");
  if (process.env.NODE_ENV !== "development") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Worker-only container: refuse HTTP traffic with a clear hint instead of
  // serving requests that would either crash (no DB pool ready for writes from
  // the worker) or duplicate work that the dedicated web container is doing.
  if (!shouldRunWeb() && pathname !== "/api/health") {
    return applyBaselineSecurityHeaders(
      NextResponse.json(
        {
          data: null,
          error:
            "This container runs the worker only — point HTTP at the web service.",
        },
        { status: 503, headers: { "X-HealthLog-Process-Type": "worker" } },
      ),
    );
  }

  // 301 redirects for renamed routes
  const redirect = LEGACY_REDIRECTS[pathname];
  if (redirect) {
    return applyBaselineSecurityHeaders(
      NextResponse.redirect(new URL(redirect, request.url), 301),
    );
  }

  // 301 for the v1.5 admin section-anchor → dynamic-route migration.
  const legacyAdmin = LEGACY_ADMIN_ANCHORS[pathname];
  if (legacyAdmin) {
    return applyBaselineSecurityHeaders(
      NextResponse.redirect(new URL(legacyAdmin, request.url), 301),
    );
  }

  // A route that existed and is gone answers 410, not 404 — see
  // `src/lib/http/retired-routes.ts` for why the status carries the message
  // and the error code only fills in the detail.
  //
  // Placed before the demo-mode block and before the page session gate on
  // purpose. A retired path is retired on a demo deploy too, and answering a
  // logged-out caller with a login redirect would send them to authenticate
  // for something that no longer exists. It reads nothing off the request but
  // the path, so it cannot answer differently for an authenticated caller than
  // for an anonymous one.
  const retired = findRetiredRoute(pathname);
  if (retired) {
    return applyBaselineSecurityHeaders(
      NextResponse.json(retiredRouteEnvelope(retired), {
        status: RETIRED_ROUTE_STATUS,
      }),
    );
  }

  // Demo mode: block all mutations except login
  if (process.env.DEMO_MODE === "true") {
    const method = request.method.toUpperCase();
    const isMutation =
      method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const isApi = pathname.startsWith("/api/");
    if (
      isApi &&
      isMutation &&
      !DEMO_MUTATION_ALLOWLIST.some(
        (entry) => pathname === entry.path && method === entry.method,
      )
    ) {
      return applyBaselineSecurityHeaders(
        NextResponse.json(
          {
            data: null,
            error: "Demo mode: modifications are disabled",
            meta: { demo: true },
          },
          { status: 403 },
        ),
      );
    }
  }

  // v1.38.19 — the invite universal-link landing answers at the EDGE.
  //
  // `src/app/invite/[token]/page.tsx` has always redirected onto
  // `/auth/register?invite=…`, but Next does not deliver that as a server 307:
  // it streams the root layout first and puts the redirect in the RSC flight
  // payload. `<AuthShell>` therefore mounted on the pathname `/invite/…`, and
  // before the entry added beside this one it read the route as protected,
  // took a 401 from `/api/auth/me` and raced its own
  // `router.replace("/auth/login")` against the redirect — logged out the
  // login bounce won, and the visitor held a one-time invite on a page that
  // cannot use it. Answering here means no HTML, no hydration, no race.
  //
  // The page stays as the fallback for any path that bypasses the matcher.
  // The shape gate is the twin of `looksLikeInviteToken` in
  // `src/lib/auth/invite-token.ts`, restated rather than imported: that module
  // pulls the Prisma client, which has no business in the proxy bundle. A
  // segment that fails it is dropped rather than reflected, so the target can
  // never echo attacker-controlled text.
  if (pathname.startsWith("/invite/")) {
    const token = pathname.slice("/invite/".length).split("/")[0] ?? "";
    const target = new URL("/auth/register", request.url);
    if (/^hlv_[0-9a-f]{64}$/.test(token)) {
      target.searchParams.set("invite", token);
    }
    const redirected = applyBaselineSecurityHeaders(
      NextResponse.redirect(target, 307),
    );
    // The secret rides in the path of the request that produced this hop, so
    // the hop itself carries the same defence the landing page earned in
    // v1.17.0: uncacheable, unindexable, and never leaked as a `Referer`.
    redirected.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate",
    );
    redirected.headers.set("X-Robots-Tag", "noindex, nofollow");
    redirected.headers.set("Referrer-Policy", "no-referrer");
    return redirected;
  }

  // Server-side route protection for pages (not API routes — those have their own getSession checks)
  const isApiRoute = pathname.startsWith("/api/");
  const isStaticFile = /\.\w+$/.test(pathname);
  const isPublic = isPublicPath(pathname);
  // Every page behind the session gate. The same predicate drives the
  // auth redirect below and the `no-store` header further down, so a page
  // can never be session-gated without also being uncacheable.
  const isSessionGatedPage = !isApiRoute && !isStaticFile && !isPublic;
  if (isSessionGatedPage) {
    const hasSession = request.cookies.has("healthlog_session");
    if (!hasSession) {
      return applyBaselineSecurityHeaders(
        NextResponse.redirect(new URL("/auth/login", request.url)),
      );
    }

    // v1.4.22 C4 — server-side onboarding redirect. Previously the
    // `<AuthShell>` ran this in a post-hydration `useEffect`, so a user
    // with `onboardingCompletedAt === null` briefly saw the dashboard
    // flash before the redirect fired. The auth flows (login, passkey,
    // register, /api/auth/me) keep an `hl_onboarding` cookie in sync
    // with the DB state; the proxy reads it without a DB roundtrip so
    // the redirect lands on the first server response. The /onboarding
    // page itself is in PUBLIC_PATHS above, so this branch only runs
    // for the surfaces that need to redirect away.
    const onboardingPending =
      request.cookies.get("hl_onboarding")?.value === "pending";
    // v1.4.22 W5 reconcile (Sec-MED-2) — exact match the redirect
    // short-circuit so a hypothetical `/onboarding-export` route can
    // never inherit the silent-pass-through.
    const isOnboardingSurface =
      pathname === "/onboarding" || pathname.startsWith("/onboarding/");
    if (onboardingPending && !isOnboardingSurface) {
      return applyBaselineSecurityHeaders(
        NextResponse.redirect(new URL("/onboarding", request.url)),
      );
    }

    // v1.23 — admin-enforced MFA forced-enrollment gate. When the operator
    // requires a second factor and the account has none, `/api/auth/me` (and
    // every auth surface) sets `hl_mfa_enroll=required`; the proxy reads it
    // without a DB round-trip — mirroring the onboarding hint — and walls the
    // app behind the enrollment surface. Only `/enroll-mfa` and
    // `/settings/security` stay reachable so the user can actually enrol;
    // logout + the enrollment APIs are `/api/*` and never page-gated here.
    // Onboarding takes precedence (the branch above already returned), so a
    // brand-new account finishes onboarding first.
    const mfaEnrollRequired =
      request.cookies.get("hl_mfa_enroll")?.value === "required";
    const isMfaEnrollSurface =
      pathname === "/enroll-mfa" || pathname.startsWith("/settings/security");
    if (mfaEnrollRequired && !isMfaEnrollSurface && !isOnboardingSurface) {
      return applyBaselineSecurityHeaders(
        NextResponse.redirect(new URL("/enroll-mfa", request.url)),
      );
    }
  }

  // Generate or propagate x-request-id for request correlation
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();

  // 128 bits of random, base64-encoded. randomUUID().toString() only carries
  // ~122 bits and has a predictable structure that base64-encodes to a
  // partially guessable pattern.
  const nonce = generateNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Request ID for log correlation
  response.headers.set("x-request-id", requestId);

  // The document vault's decrypt-and-serve route is framed SAME-ORIGIN by
  // the document detail preview (an <iframe> for inline-class PDFs). The
  // blanket `X-Frame-Options: DENY` + `frame-ancestors 'none'` below would
  // refuse that embed, and the blanket page CSP would clobber the route's
  // own `Content-Security-Policy: sandbox` (middleware headers win over
  // route headers). Scope: exactly the `/original` path — list/detail API
  // routes keep the full DENY posture. The replacement CSP keeps the
  // sandbox (the served bytes are user-uploaded and must never script in
  // the app origin) and narrows framing to 'self' instead of dropping it.
  const isDocumentServeRoute =
    /^\/api\/documents\/inbound\/[^/]+\/original$/.test(pathname);

  // v1.28 — the public share-scoped document serve route at
  // `/c/<token>/d/<id>` is the share analogue of the owner `/original` route:
  // it decrypts and serves a user-uploaded document that the clinician view
  // (`/c/<token>`) frames same-origin (an <iframe> for inline-class PDFs). It
  // needs the SAME narrow posture — SAMEORIGIN framing + a document CSP — and
  // NOT the `/c/` page CSP, which pins `frame-ancestors 'none'` and would
  // refuse the preview embed. Anchored to EXACTLY two dynamic segments so a
  // `/c/<token>` page, a `/c/<token>/d/<id>/extra`, or a `/c/<token>/dx/<id>`
  // lookalike never inherits the carve-out.
  const isShareDocumentServeRoute = /^\/c\/[^/]+\/d\/[^/]+$/.test(pathname);

  // Both serve routes take the narrow, document-only header posture.
  const isServeRoute = isDocumentServeRoute || isShareDocumentServeRoute;

  // Session-gated pages carry one account's health record in the document
  // itself. Several of them server-prefetch their data and serialise it into
  // the HTML through a TanStack `HydrationBoundary` — the dashboard, Insights,
  // the workouts list, the medications list, the Coach. Those pages are
  // dynamic today only as a side effect of reading the session cookie, which
  // is a property of the page code, not a guarantee: a stray `revalidate`
  // export, a `force-static` segment, or a caching proxy in front of the app
  // would be enough to retain one account's record and hand it to the next
  // caller. Pin the guarantee at the edge instead, where no page-level change
  // can weaken it.
  //
  // `private` bars shared caches (CDN, reverse proxy) outright; `no-store`
  // additionally stops the browser's own disk cache and the bfcache snapshot,
  // so a back-navigation after logout cannot repaint the record. The public
  // surfaces (`/auth/*`, `/privacy`, `/about`, `/i18n/*`) are excluded by the
  // same predicate that governs the auth redirect, so the statically
  // rendered marketing/legal pages stay cacheable.
  if (isSessionGatedPage) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  // Security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", isServeRoute ? "SAMEORIGIN" : "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  // v1.11.0 (Epic C, C6) — the public clinician share view at `/c/<token>`
  // is a scoped health record authenticated by an unguessable bearer token
  // in the path. Defend it at the edge regardless of what the RSC emits:
  //   - `Cache-Control: no-store` so no shared proxy / CDN ever retains a
  //     scoped record (the page is `force-dynamic`, but that governs Next's
  //     cache, not a downstream intermediary).
  //   - `X-Robots-Tag: noindex, nofollow` as the header peer of the page's
  //     `robots` meta — a crawler that never parses the document still obeys
  //     the header, and the token must never reach a search index.
  //   - `Referrer-Policy: no-referrer` so the token-bearing URL is not
  //     leaked in the `Referer` of any outbound navigation from the page.
  //
  // v1.17.0 — `/invite/<hlv_token>` (iOS #16) carries an equally sensitive
  // secret in the path, so it earns the same edge defence even though it is
  // a pure server redirect: no shared proxy / CDN may cache it and no
  // crawler may index the token-bearing URL.
  if (pathname.startsWith("/c/") || pathname.startsWith("/invite/")) {
    response.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate",
    );
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  // COOP isolates this BrowsingContextGroup from cross-origin popups,
  // closing the Spectre-class side-channel surface a stray
  // `window.opener` reference would otherwise carry. CORP narrows the
  // page's resources to same-origin loaders, complementing the
  // `frame-ancestors 'none'` CSP rule for non-document subresources.
  // The legacy `X-Permitted-Cross-Domain-Policies` line shuts the
  // Flash/PDF crossdomain.xml channel that some scanners still flag.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // COEP `credentialless` completes the cross-origin-isolation triad
  // without the operational hazard of `require-corp`: cross-origin
  // no-CORS subresources load with credentials stripped instead of
  // being blocked outright. The app's CSP already pins `img-src` to
  // `'self' data:` (Gravatar is proxied same-origin since v1.5.5), so
  // no shipped surface loads cross-origin subresources at all — the
  // header is pure defence-in-depth against a future regression and
  // unlocks `crossOriginIsolated` capabilities should they be needed.
  response.headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");

  // CSP — permissive in dev, strict in production. Third-party hosts in
  // `connect-src` are gated to the surfaces that actually need them so a
  // DOM-XSS on an unrelated page can't exfiltrate to them (V3 audit:
  // blanket chatgpt.com on /auth/login was a DOM-XSS exfil channel).
  //
  // F-5 (mobile security audit, 2026-05-16): `wbsapi.withings.net` used
  // to live in the global `connect-src` and shipped on every page. The
  // Withings client lives server-side, so the browser never needs to
  // reach it from a non-Withings surface; mirror the AI gating shape.
  const isDev = process.env.NODE_ENV === "development";
  const cspReportEndpoint = "/api/monitoring/csp-report";
  const isAiSettingsRoute = pathname.startsWith("/settings/ai");
  const aiConnectSrc = isAiSettingsRoute
    ? " https://api.openai.com https://chatgpt.com"
    : "";
  const isWithingsRoute =
    pathname.startsWith("/settings/integrations/withings") ||
    pathname.startsWith("/api/withings/");
  const withingsConnectSrc = isWithingsRoute
    ? " https://wbsapi.withings.net"
    : "";
  // v1.11.0 — `api.prod.whoop.com` gated to the WHOOP settings surface +
  // `/api/whoop/*`, mirroring the Withings gating shape. The WHOOP data
  // client lives server-side and the OAuth handshake is a browser
  // redirect (not a fetch), so this is belt-and-suspenders parity — no
  // other surface ever needs to reach the WHOOP host from the browser.
  const isWhoopRoute =
    pathname.startsWith("/settings/integrations/whoop") ||
    pathname.startsWith("/api/whoop/");
  const whoopConnectSrc = isWhoopRoute ? " https://api.prod.whoop.com" : "";
  // v1.28.x — `www.strava.com` gated to the Strava settings surface +
  // `/api/strava/*`, mirroring the WHOOP gating shape. The Strava data client
  // lives server-side and the OAuth handshake is a browser redirect (not a
  // fetch), so this is belt-and-suspenders parity — no other surface ever needs
  // to reach the Strava host from the browser.
  const isStravaRoute =
    pathname.startsWith("/settings/integrations/strava") ||
    pathname.startsWith("/api/strava/");
  const stravaConnectSrc = isStravaRoute ? " https://www.strava.com" : "";
  // v1.5.5 — Gravatar host removed from `img-src`. The /me payload
  // used to return `gravatarUrl: https://www.gravatar.com/avatar/<sha256(email)>`,
  // which leaked the email digest to Automattic on every authenticated
  // page-load. Avatars now live on the User row and serve from
  // same-origin `/api/user/avatar/{id}`, so `img-src 'self'` covers
  // them.
  const csp = isServeRoute
    ? // Vault serve route (owner `/original` OR share `/c/<token>/d/<id>`; see
      // the X-Frame-Options note above): the
      // response is a user-uploaded document, not an app page.
      // `default-src 'none'` — a served document may load nothing as if
      // it were a page — and `frame-ancestors 'self'` permits exactly the
      // same-origin preview iframe. Deliberately NO `sandbox` directive:
      // Chromium refuses to render PDFs in sandboxed documents (it
      // force-downloads them), which would kill the inline preview
      // outright. The load-bearing boundaries for user-uploaded bytes
      // stay: magic-byte classification at upload, true Content-Type +
      // `nosniff` at serve (a PDF can never be reinterpreted as HTML),
      // HTML/SVG denied entirely, and attachment-only posture for every
      // non-passive format.
      `default-src 'none'; frame-ancestors 'self';`
    : // v1.37.15 — `frame-src 'self' blob:` + `blob:` in `img-src` (both dev
      // and prod). Since the record fence (v1.37.0) every vault preview loads
      // through `useFencedObjectUrl`, i.e. a `blob:` object URL: without a
      // `frame-src` the PDF preview iframe fell through to `default-src
      // 'self'` and was blocked loudly, and `img-src 'self' data:` degraded
      // every blob thumbnail to its fallback icon silently. Admitting `blob:`
      // is same-origin-tight: a blob: URL can only be minted by script running
      // on this origin (`URL.createObjectURL`), script execution stays
      // nonce-bound (prod), and `object-src 'none'` / `frame-ancestors
      // 'none'` / `default-src 'self'` are unchanged — no foreign origin
      // gains anything. Reverting the previews to direct `/api` src instead
      // is barred by the record-fence guard.
      isDev
      ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; font-src 'self';`
      : `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'${aiConnectSrc}${withingsConnectSrc}${whoopConnectSrc}${stravaConnectSrc}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; report-uri ${cspReportEndpoint}; report-to csp-endpoint;`;
  response.headers.set("Content-Security-Policy", csp);

  // Production-only headers. HSTS carries `preload` so the domain stays
  // eligible for the Chromium preload list — closes the first-visit MITM
  // window on hostile networks (F-5, mobile security audit 2026-05-16).
  if (!isDev) {
    response.headers.set(
      "Reporting-Endpoints",
      `csp-endpoint="${cspReportEndpoint}"`,
    );
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }

  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except static files, Next.js internals, SW, and manifest
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.json|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|txt|xml)$).*)",
  ],
};
