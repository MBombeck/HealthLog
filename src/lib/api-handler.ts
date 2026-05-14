import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import type { User } from "@/generated/prisma/client";
import { WideEventBuilder } from "./logging/event-builder";
import { eventStorage, getEvent } from "./logging/context";
import { emitIfSampled } from "./logging/transports";
import { redactOptional, redactSecrets } from "./logging/redact";
import { getSession } from "./auth/session";
import { hashToken } from "./auth/hmac";
import { prisma } from "./db";
import { auditLog } from "./auth/audit";

/**
 * Custom error class for HTTP errors with status codes.
 * Throw inside apiHandler-wrapped routes to return a JSON error response.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Wraps an API route handler with Wide Event logging.
 * Creates a WideEventBuilder, runs the handler inside AsyncLocalStorage,
 * catches errors, and emits the event on completion.
 *
 * No CSRF check — HealthLog does not use CSRF tokens.
 * Auth annotation happens in routes via requireAuth().
 */
// Next.js route handlers come in two shapes — `(request)` for static routes
// and `(request, { params })` for dynamic ones. The variadic generic is the
// only signature TS accepts that covers both at the call site. The `any[]`
// here is constrained by the bound (T must return Promise<Response>) so it
// does not loosen handler bodies — only their parameter list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiHandler<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]): Promise<Response> => {
    const request = args[0] as NextRequest;
    const url = new URL(request.url);

    const evt = new WideEventBuilder("http");

    // Propagate x-request-id if present
    const incomingRequestId = request.headers.get("x-request-id");
    if (incomingRequestId) evt.setRequestId(incomingRequestId);

    evt.setHttp({
      method: request.method,
      path: url.pathname,
      route: url.pathname,
      status: 200,
      user_agent: request.headers.get("user-agent") ?? undefined,
      ip:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        undefined,
    });

    return eventStorage.run(evt, async () => {
      let response: Response | undefined;
      try {
        response = await handler(...args);
      } catch (error) {
        if (error instanceof HttpError) {
          evt.setError(error);
          response = NextResponse.json(
            { data: null, error: error.message },
            { status: error.statusCode },
          );
        } else if (error instanceof SyntaxError) {
          evt.setError(error);
          response = NextResponse.json(
            { data: null, error: "Invalid JSON body" },
            { status: 400 },
          );
        } else {
          evt.setError(error);
          // Report to GlitchTip (fire-and-forget)
          reportToGlitchtip(error, request, evt).catch(() => {});
          response = NextResponse.json(
            { data: null, error: "Interner Serverfehler" },
            { status: 500 },
          );
        }
      } finally {
        const status = (response as Response | undefined)?.status ?? 500;
        evt.finish(status);
        try {
          emitIfSampled(evt.toJSON());
        } catch {
          /* logging must never crash the handler */
        }
      }
      const nr = response as NextResponse;
      nr.headers.set("x-request-id", evt.getRequestId());
      return nr;
    });
  };
  return wrapped as T;
}

/**
 * Authenticated request context. Returned by both session-cookie and Bearer-token
 * authentication paths. The `session.id` is the session-record id for cookie auth
 * and the `ApiToken` id for bearer auth — callers must not assume the id refers
 * to a Session row.
 */
export type AuthContext = {
  session: { id: string; expiresAt: Date };
  user: User;
};

/**
 * Require an authenticated request. Throws HttpError(401) / HttpError(403) on failure.
 *
 * Auth precedence (cookie-first, never both):
 *   1. Valid session cookie → cookie path (existing behaviour, requiredPermission ignored).
 *   2. No cookie + `Authorization: Bearer hlk_<...>` → API token path.
 *   3. Neither → 401.
 *
 * @param requiredPermission Optional permission scope. Only enforced for Bearer
 *   auth — cookie sessions always pass (full user access). When set and missing
 *   from `ApiToken.permissions`, throws HttpError(403).
 */
export async function requireAuth(
  requiredPermission?: string,
): Promise<AuthContext> {
  // 1. Session cookie path — unchanged.
  const sessionData = await getSession();
  if (sessionData) {
    const evt = getEvent();
    if (evt) {
      evt.setAuth({
        user_id: sessionData.user.id,
        user_role: sessionData.user.role,
        auth_method: "session",
      });
    }
    return sessionData;
  }

  // 2. Bearer-token path.
  // `headers()` is only valid inside a Next.js request scope. Outside one
  // (e.g. during direct unit tests of legacy routes that pre-date Bearer auth)
  // we treat the absence of a header context as "no Bearer present" and fall
  // through to the unauthenticated case below.
  let authHeader: string | null = null;
  try {
    const headerList = await headers();
    authHeader = headerList.get("authorization");
  } catch {
    authHeader = null;
  }
  if (authHeader?.startsWith("Bearer ")) {
    return await authenticateBearer(authHeader.slice(7), requiredPermission);
  }

  // 3. No credentials.
  throw new HttpError(401, "Not authenticated");
}

/**
 * Authenticate a raw Bearer token against `ApiToken`.
 * Annotates the Wide Event with `auth_method: "api_key"` and writes audit-log
 * entries for both success and failure.
 */
async function authenticateBearer(
  rawToken: string,
  requiredPermission: string | undefined,
): Promise<AuthContext> {
  const tokenHashValue = hashToken(rawToken);

  const apiToken = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    select: {
      id: true,
      userId: true,
      permissions: true,
      revoked: true,
      expiresAt: true,
    },
  });

  if (!apiToken) {
    auditLog("auth.bearer.failure", {
      details: { reason: "unknown_token" },
    }).catch(() => {});
    throw new HttpError(401, "Invalid token");
  }

  if (apiToken.revoked) {
    auditLog("auth.bearer.failure", {
      userId: apiToken.userId,
      details: { reason: "revoked", tokenId: apiToken.id },
    }).catch(() => {});
    throw new HttpError(401, "Invalid token");
  }

  if (apiToken.expiresAt && apiToken.expiresAt <= new Date()) {
    auditLog("auth.bearer.failure", {
      userId: apiToken.userId,
      details: { reason: "expired", tokenId: apiToken.id },
    }).catch(() => {});
    throw new HttpError(401, "Token expired");
  }

  // Audit V3 NEW-V3-1 fix: `["*"]` is a real wildcard — it grants the
  // session-equivalent scope (the iOS app receives this on login). Without
  // the wildcard branch, EVERY future requireAuth("scope:name") call would
  // 403 every iOS-issued token because string-literal `.includes("*"...)`
  // never matches.  Worse: today many sensitive routes call requireAuth()
  // *without* a requiredPermission, so a leaked iOS token can act as a
  // full-scope token (account delete, settings wipe). Once those routes
  // adopt requireAuth("scope:name"), the wildcard handling here keeps
  // the iOS app working while narrower-scoped tokens (e.g. ["medication:
  // ingest"]) get correctly 403'd.
  const hasWildcardPermission = apiToken.permissions.includes("*");

  if (!requiredPermission && !hasWildcardPermission) {
    auditLog("auth.bearer.failure", {
      userId: apiToken.userId,
      details: {
        reason: "scope_required",
        tokenId: apiToken.id,
      },
    }).catch(() => {});
    throw new HttpError(403, "Insufficient permissions");
  }

  if (
    requiredPermission &&
    !hasWildcardPermission &&
    !apiToken.permissions.includes(requiredPermission)
  ) {
    auditLog("auth.bearer.failure", {
      userId: apiToken.userId,
      details: {
        reason: "insufficient_permissions",
        tokenId: apiToken.id,
        required: requiredPermission,
      },
    }).catch(() => {});
    throw new HttpError(403, "Insufficient permissions");
  }

  const user = await prisma.user.findUnique({
    where: { id: apiToken.userId },
  });

  if (!user) {
    auditLog("auth.bearer.failure", {
      userId: apiToken.userId,
      details: { reason: "user_missing", tokenId: apiToken.id },
    }).catch(() => {});
    throw new HttpError(401, "Invalid token");
  }

  // Fire-and-forget: refresh lastUsedAt without blocking the request.
  prisma.apiToken
    .update({
      where: { id: apiToken.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  auditLog("auth.bearer.success", {
    userId: user.id,
    details: { tokenId: apiToken.id },
  }).catch(() => {});

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: user.id,
      user_role: user.role,
      auth_method: "bearer",
    });
  }

  // Use the token expiry as the session expiry; fall back to a 30-day window if
  // the token has no fixed expiry so the contract `{ expiresAt: Date }` holds.
  const expiresAt =
    apiToken.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  return {
    session: { id: apiToken.id, expiresAt },
    user,
  };
}

/**
 * Require an authenticated admin user. Throws HttpError(401) or HttpError(403).
 * Cookie-only — Bearer tokens never elevate to admin (security boundary).
 * Automatically annotates the Wide Event with auth context.
 */
export async function requireAdmin(): Promise<AuthContext> {
  const sessionData = await getSession();
  if (!sessionData) throw new HttpError(401, "Not authenticated");

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  if (sessionData.user.role !== "ADMIN") {
    throw new HttpError(403, "Admin access required");
  }
  return sessionData;
}

/**
 * Report unhandled errors to GlitchTip (fire-and-forget).
 * Uses dynamic import to avoid circular dependencies and startup cost.
 */
async function reportToGlitchtip(
  error: unknown,
  request: NextRequest,
  evt: WideEventBuilder,
): Promise<void> {
  const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] = await Promise.all([
    import("@/lib/monitoring-settings"),
    import("@/lib/monitoring/glitchtip"),
  ]);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown error");

  // Skip expected errors from bot scanners (malformed JSON bodies)
  if (err instanceof SyntaxError) return;

  // Audit H-B7 / phase P2: strip the query string before forwarding to
  // GlitchTip. Withings legacy callbacks ship `?secret=…` (see C-3) and
  // OAuth callbacks ship `?code=…&state=…`; if any of those error we
  // don't want their secrets in someone's incident UI.
  let scrubbedUrl = request.url;
  try {
    const u = new URL(request.url);
    u.search = "";
    scrubbedUrl = u.toString();
  } catch {
    // Invalid URL — fall through with the raw value (only happens in
    // degenerate test fixtures).
  }

  await sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: settings.glitchtipEnvironment || "production",
      // Defence in depth: even though the WideEventBuilder already
      // redacts on `setError()`, the GlitchTip path imports `err`
      // directly. Apply the same redaction here so a Telegram bot
      // token or external Bearer cannot leak via the incident UI.
      message: redactSecrets(err.message),
      level: "error",
      type: err.name || "Error",
      stack: redactOptional(err.stack),
      url: scrubbedUrl,
      sourceTag: "healthlog-api-handler",
      requestId: evt.getRequestId(),
    },
  });
}
