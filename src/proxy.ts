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
  "/api/ingest/",
  "/onboarding",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Server-side route protection for pages (not API routes — those have their own getSession checks)
  const isApiRoute = pathname.startsWith("/api/");
  const isPublic = isPublicPath(pathname);
  if (!isApiRoute && !isPublic) {
    const hasSession = request.cookies.has("healthlog_session");
    if (!hasSession) {
      return NextResponse.redirect(new URL("/auth/login", request.url));
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

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
  const csp = isDev
    ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com; connect-src 'self'; font-src 'self';`
    : `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com; connect-src 'self' https://api.openai.com https://wbsapi.withings.net; font-src 'self';`;
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-nonce", nonce);

  // HSTS in production
  if (!isDev) {
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
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
