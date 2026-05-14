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
// Read a property from a request-like value without invoking native
// private-field getters (NextRequest.method / .url / .headers access
// `this.#state` and crash with `Cannot read private member #state from
// an object whose class did not declare it` when the request is a
// Proxy or a synthetic placeholder — Next 16 passes such placeholders
// to `force-static` route handlers during dev). We probe defensively
// and fall back to safe defaults so logging instrumentation never
// crashes the handler.
//
// The catch is narrowed to two well-known shapes: the V8 private-field
// TypeError, and the `Cannot read properties of undefined/null` shape
// raised when the wrapper is invoked without a request (vitest tests
// frequently invoke handlers as `GET()` with no args, mirroring the
// shape Next.js exercises for the static-export pass). Any other
// exception is a real bug in the read callback or in a downstream
// header parser and must surface — swallowing it would hide
// regressions in production instrumentation.
function isTolerableRequestProbeError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message ?? "";
  return (
    // V8 — current
    msg.includes("private member") ||
    // V8 — alternative
    msg.includes("private field") ||
    // Bun / older V8
    msg.includes("private name") ||
    // No request handed in at all (vitest direct-invoke or
    // force-static placeholder reduced to undefined / null).
    // Covers both modern `Cannot read properties of undefined
    // (reading 'X')` and the older `Cannot read property 'X' of
    // undefined` wordings.
    /Cannot read propert(?:y|ies)\b.*\bof (?:undefined|null)\b/.test(
      msg,
    )
  );
}

function safeRequestProp<R>(
  request: unknown,
  read: (req: NextRequest) => R,
  fallback: R,
): R {
  try {
    return read(request as NextRequest);
  } catch (err) {
    if (isTolerableRequestProbeError(err)) return fallback;
    throw err;
  }
}

/** @internal — exposed for unit tests of the narrow-catch contract. */
export const __testables = {
  safeRequestProp,
  isTolerableRequestProbeError,
};

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
    const requestUrl = safeRequestProp(request, (r) => r.url, "");
    const url = (() => {
      try {
        return new URL(requestUrl);
      } catch {
        // No usable URL (e.g. force-static placeholder) — fall back to
        // a synthetic origin so the rest of the pipeline can still
        // attach a pathname.
        return new URL("http://localhost/");
      }
    })();

    const evt = new WideEventBuilder("http");

    // Propagate x-request-id if present
    const incomingRequestId = safeRequestProp(
      request,
      (r) => r.headers.get("x-request-id"),
      null,
    );
    if (incomingRequestId) evt.setRequestId(incomingRequestId);

    evt.setHttp({
      method: safeRequestProp(request, (r) => r.method, "GET"),
      path: url.pathname,
      route: url.pathname,
      status: 200,
      user_agent:
        safeRequestProp(
          request,
          (r) => r.headers.get("user-agent"),
          null,
        ) ?? undefined,
      ip:
        safeRequestProp(
          request,
          (r) => r.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
          null,
        ) ||
        safeRequestProp(request, (r) => r.headers.get("x-real-ip"), null) ||
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

  // `["*"]` is the wildcard scope: granted to the iOS app on login so it
  // can call any authenticated route. Narrow scopes (e.g.
  // `["medication:ingest"]`) gate specific routes.
  //
  // Authorisation contract:
  //   - Route declares no `requiredPermission`: any valid token passes
  //     (both wildcard and narrow-scope). The route does not gate on
  //     scope, so authentication alone is sufficient.
  //   - Route declares a `requiredPermission`: wildcard tokens pass;
  //     narrow-scope tokens must list the required permission.
  //
  // v1.4.25 W10 reconcile (code-review H2): the previous "no
  // requiredPermission ⇒ wildcard only" rule misread the contract.
  // Routes without a declared scope (`/api/measurements/by-external-ids`,
  // `/api/personal-records`, `/api/medications/[id]/glp1`,
  // `/api/dashboard/glp1`) 403'd every narrow-scope token even though
  // those routes did not intend to restrict by scope at all. Allowing
  // any authenticated token through when the route does not declare a
  // scope unblocks the v1.5 iOS endpoints while keeping the scoped-
  // route gating below intact.
  const hasWildcardPermission = apiToken.permissions.includes("*");

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
  const rawUrl = safeRequestProp(request, (r) => r.url, "");
  let scrubbedUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
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
