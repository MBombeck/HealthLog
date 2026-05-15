import { NextResponse, type NextRequest } from "next/server";
import { shouldRunWeb } from "@/lib/process-type";

/**
 * Paths that do NOT require a session cookie (public pages + external webhooks).
 *
 * `/api/version` is intentionally public — both the in-app About page and the
 * compose healthcheck rely on it. `/api/health` stays public for the same
 * reason.
 */
const PUBLIC_PATHS = [
  "/auth/",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/registration-status",
  "/api/auth/passkey/login-options",
  "/api/auth/passkey/login-verify",
  "/api/health",
  "/api/version",
  "/api/notifications/vapid",
  "/api/monitoring/",
  "/api/send",
  "/api/withings/webhook",
  "/api/telegram/webhook",
  "/api/integrations/moodlog/webhook",
  "/api/auth/codex/callback",
  "/api/ingest/",
  // v1.4.26 — `/privacy` is a public legal page. iOS App Store Connect
  // requires a publicly reachable Privacy-Policy URL during submission;
  // GDPR Art. 13 expects the same for any visitor before they sign up.
  "/privacy",
  // v1.4.27 B3 — `/about` carries the GeoLite2 CC BY-SA 4.0 attribution
  // alongside the project credits. The CC licence requires the
  // attribution to be reachable without a sign-in.
  "/about",
  // `/onboarding` itself + its subroutes are matched exactly via
  // `isPublicPath()` so we don't admit `/onboarding-export` etc.
  "/robots.txt",
];

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
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

/**
 * API paths that are allowed to accept mutations (POST/PUT/PATCH/DELETE)
 * even when DEMO_MODE is enabled. Everything else is read-only.
 */
const DEMO_MUTATION_ALLOWLIST = [
  "/api/auth/login",
  "/api/auth/passkey/login-options",
  "/api/auth/passkey/login-verify",
];

// Legacy route redirects (German → English)
const LEGACY_REDIRECTS: Record<string, string> = {
  "/stimmung": "/mood",
  "/zielwerte": "/targets",
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
  "/admin/section-admin-bugreport": "/admin/integrations",
  "/admin/section-admin-feedback": "/admin/feedback",
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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Worker-only container: refuse HTTP traffic with a clear hint instead of
  // serving requests that would either crash (no DB pool ready for writes from
  // the worker) or duplicate work that the dedicated web container is doing.
  if (!shouldRunWeb()) {
    return NextResponse.json(
      {
        data: null,
        error:
          "This container runs the worker only — point HTTP at the web service.",
      },
      { status: 503, headers: { "X-HealthLog-Process-Type": "worker" } },
    );
  }

  // 301 redirects for renamed routes
  const redirect = LEGACY_REDIRECTS[pathname];
  if (redirect) {
    return NextResponse.redirect(new URL(redirect, request.url), 301);
  }

  // 301 for the v1.5 admin section-anchor → dynamic-route migration.
  const legacyAdmin = LEGACY_ADMIN_ANCHORS[pathname];
  if (legacyAdmin) {
    return NextResponse.redirect(new URL(legacyAdmin, request.url), 301);
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
      !DEMO_MUTATION_ALLOWLIST.some((p) => pathname === p)
    ) {
      return NextResponse.json(
        {
          data: null,
          error: "Demo mode: modifications are disabled",
          meta: { demo: true },
        },
        { status: 403 },
      );
    }
  }

  // Server-side route protection for pages (not API routes — those have their own getSession checks)
  const isApiRoute = pathname.startsWith("/api/");
  const isStaticFile = /\.\w+$/.test(pathname);
  const isPublic = isPublicPath(pathname);
  if (!isApiRoute && !isStaticFile && !isPublic) {
    const hasSession = request.cookies.has("healthlog_session");
    if (!hasSession) {
      return NextResponse.redirect(new URL("/auth/login", request.url));
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
      return NextResponse.redirect(new URL("/onboarding", request.url));
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

  // Security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  // CSP — permissive in dev, strict in production. AI provider hosts
  // (OpenAI / chatgpt.com) are gated to /settings/ai/** because that is
  // the only surface a browser fetch is needed (V3 audit: blanket
  // chatgpt.com on /auth/login is a DOM-XSS exfil channel).
  const isDev = process.env.NODE_ENV === "development";
  const cspReportEndpoint = "/api/monitoring/csp-report";
  const isAiSettingsRoute = pathname.startsWith("/settings/ai");
  const aiConnectSrc = isAiSettingsRoute
    ? " https://api.openai.com https://chatgpt.com"
    : "";
  const csp = isDev
    ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com; connect-src 'self'; font-src 'self';`
    : `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com; connect-src 'self'${aiConnectSrc} https://wbsapi.withings.net; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; report-uri ${cspReportEndpoint}; report-to csp-endpoint;`;
  response.headers.set("Content-Security-Policy", csp);

  // Production-only headers
  if (!isDev) {
    response.headers.set(
      "Reporting-Endpoints",
      `csp-endpoint="${cspReportEndpoint}"`,
    );
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
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
