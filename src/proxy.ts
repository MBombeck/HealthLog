import { NextResponse, type NextRequest } from "next/server";

/**
 * Paths that do NOT require a session cookie (public pages + external webhooks).
 */
const PUBLIC_PATHS = [
  "/auth/",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/registration-status",
  "/api/auth/passkey/login-options",
  "/api/auth/passkey/login-verify",
  "/api/health",
  "/api/notifications/vapid",
  "/api/monitoring/",
  "/api/send",
  "/api/withings/webhook",
  "/api/telegram/webhook",
  "/api/integrations/moodlog/webhook",
  "/api/auth/codex/callback",
  "/api/ingest/",
  "/onboarding",
  "/robots.txt",
];

function isPublicPath(pathname: string): boolean {
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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 301 redirects for renamed routes
  const redirect = LEGACY_REDIRECTS[pathname];
  if (redirect) {
    return NextResponse.redirect(new URL(redirect, request.url), 301);
  }

  // Demo mode: block all mutations except login
  if (process.env.DEMO_MODE === "true") {
    const method = request.method.toUpperCase();
    const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const isApi = pathname.startsWith("/api/");
    if (isApi && isMutation && !DEMO_MUTATION_ALLOWLIST.some((p) => pathname === p)) {
      return NextResponse.json(
        { data: null, error: "Demo mode: modifications are disabled", meta: { demo: true } },
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
  }

  // Generate or propagate x-request-id for request correlation
  const requestId =
    request.headers.get("x-request-id") || crypto.randomUUID();

  // 128 bits of random, base64-encoded. randomUUID().toString() only carries
  // ~122 bits and has a predictable structure that base64-encodes to a
  // partially guessable pattern.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64",
  );
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

  // CSP — permissive in dev, strict in production
  const isDev = process.env.NODE_ENV === "development";
  const cspReportEndpoint = "/api/monitoring/csp-report";
  const csp = isDev
    ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com; connect-src 'self'; font-src 'self';`
    : `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com; connect-src 'self' https://api.openai.com https://chatgpt.com https://wbsapi.withings.net; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; report-uri ${cspReportEndpoint}; report-to csp-endpoint;`;
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
