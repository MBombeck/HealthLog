import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import type { User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { WideEventBuilder } from "./logging/event-builder";
import { annotate, eventStorage, getEvent } from "./logging/context";
import { emitIfSampled } from "./logging/transports";
import { redactOptional, redactSecrets } from "./logging/redact";
import { getSession } from "./auth/session";
import { auditLog } from "./auth/audit";
import {
  resolveBearerToken,
  BearerAuthError,
  type ScopeRequirement,
} from "./auth/bearer";
import {
  claimStepUpElevation,
  validateStepUpElevation,
  STEP_UP_ELEVATION_TTL_SECONDS,
} from "./auth/step-up";
import { hashToken } from "./auth/hmac";
import { AssistantDisabledError } from "./feature-flags";
import { ConsentRequiredError } from "./ai/consent-guard";
import { SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE } from "./mcp/oauth/config";

/**
 * HTTP methods a read-only credential may use on the REST surface. A request
 * with any other method (POST / PUT / PATCH / DELETE) is a write.
 *
 * The MCP-audience guard below assumes these methods are side-effect-free:
 * an MCP-bound token is admitted on them. A future side-effecting GET (or HEAD)
 * would silently widen that token's reach over REST — do NOT add one without
 * revisiting the MCP audience binding here.
 */
const READ_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a token is MCP-audience-bound (H1). The MCP OAuth bridge and the
 * connector settings card mint tokens whose ONLY grants are `health:read` —
 * and, when the user consents to logging, `health:read health:write`. Either
 * shape is bound to the MCP surface: the `/mcp` resolver accepts it and so do
 * safe (read) REST methods, but it must NEVER reach a REST write/delete. The
 * `health:write` grant admits writes ONLY in-process over `/mcp` (the confirmed
 * write tools), never over REST — so a write-scoped MCP token is exactly as
 * audience-bound on this edge as a read-only one. A token carrying any broader
 * or legacy grant (`*`, `medication:ingest`, …) is NOT MCP-audience-bound and
 * keeps its existing reach.
 */
export function isMcpAudienceToken(permissions: readonly string[]): boolean {
  if (permissions.length === 0) return false;
  return permissions.every(
    (p) => p === SCOPE_HEALTH_READ || p === SCOPE_HEALTH_WRITE,
  );
}

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
    /Cannot read propert(?:y|ies)\b.*\bof (?:undefined|null)\b/.test(msg)
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
    if (isTolerableRequestProbeError(err)) {
      // v1.4.27 B7 / BL-P1-3 — surface every fallback so a real read
      // regression cannot hide behind the tolerated-error narrowing.
      // Vitest direct-invoke and the force-static placeholder path are
      // the two known-quiet shapes; anything else worth a look should
      // show up in the dev console + the run log.
      if (process.env.NODE_ENV !== "test") {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[api-handler] safeRequestProp fallback — tolerable error: ${msg}`,
        );
      }
      return fallback;
    }
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
        safeRequestProp(request, (r) => r.headers.get("user-agent"), null) ??
        undefined,
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
        if (error instanceof AssistantDisabledError) {
          // v1.4.31 — operator has disabled the assistant surface.
          // The 403 + `errorCode: "assistant.disabled.<surface>"`
          // envelope is locked per
          // `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5.
          // Older iOS clients that don't know the errorCode surface
          // this as a generic 403; v1.4.31+ clients can branch on the
          // errorCode to render an inline operator-disabled notice.
          evt.setError(error);
          response = NextResponse.json(
            {
              data: null,
              error: error.message,
              meta: { errorCode: error.errorCode },
            },
            { status: 403 },
          );
        } else if (error instanceof ConsentRequiredError) {
          // v1.12.1 — server-side consent gate before external-LLM PHI
          // egress on the operator's server-managed key. Mirrors the
          // AssistantDisabledError envelope (403 + meta.errorCode) so the
          // iOS client renders an inline "grant consent" notice instead of
          // a generic failure.
          evt.setError(error);
          response = NextResponse.json(
            {
              data: null,
              error: error.message,
              meta: { errorCode: error.errorCode },
            },
            { status: 403 },
          );
        } else if (error instanceof StepUpRequiredError) {
          // v1.23 — step-up gate not satisfied. Same 401 + meta.errorCode
          // envelope shape as the assistant/consent gates so the client can
          // branch on the stable code and launch a re-verification flow.
          // Checked before the generic HttpError branch because
          // StepUpRequiredError extends it.
          evt.setError(error);
          response = NextResponse.json(
            {
              data: null,
              error: error.message,
              meta: { errorCode: error.errorCode },
            },
            { status: error.statusCode },
          );
        } else if (error instanceof HttpError) {
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
 *   auth — cookie sessions always pass (full user access). Omitting it is a
 *   positive declaration: the route accepts cookie sessions and cookie-
 *   equivalent (`["*"]`) tokens ONLY, and refuses a narrow-scope token with
 *   HttpError(403). Naming a scope additionally admits narrow tokens that list
 *   it. A token that lists neither `*` nor the named scope throws
 *   HttpError(403).
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
 *
 * The validation itself lives in the transport-agnostic `resolveBearerToken`
 * (`./auth/bearer`) — the single source of truth shared with the MCP wire. This
 * wrapper adds the HTTP-edge concerns: the `auth.bearer.failure` audit trail
 * (only the failure path writes a durable audit row — the success row was
 * intentionally dropped for perf) and the Wide-Event `auth_method: "bearer"`
 * annotation, then maps the result onto the `AuthContext` contract
 * (`session.id` carries the token id).
 *
 * Authorisation contract (fail-closed): a route that declares no
 * `requiredPermission` accepts cookie sessions and cookie-equivalent (`["*"]`)
 * tokens only — a narrow-scope token is refused 403 with an `undeclared_scope`
 * audit row. A route that declares a scope additionally accepts narrow tokens
 * that list it. The absence of an argument is a positive statement, not an
 * omission, which is what makes the default safe for routes nobody has thought
 * about yet.
 */
async function authenticateBearer(
  rawToken: string,
  requiredPermission: string | undefined,
): Promise<AuthContext> {
  const requirement: ScopeRequirement = requiredPermission
    ? { kind: "scope", scope: requiredPermission }
    : { kind: "wildcard-only" };
  let resolution;
  try {
    resolution = await resolveBearerToken(rawToken, requirement);
  } catch (err) {
    if (err instanceof BearerAuthError) {
      auditLog("auth.bearer.failure", {
        userId: err.userId ?? null,
        details: {
          reason: err.reason,
          ...(err.tokenId ? { tokenId: err.tokenId } : {}),
          ...(err.reason === "insufficient_permissions"
            ? { required: requiredPermission }
            : {}),
        },
      }).catch(() => {});
      const message =
        err.statusCode === 403
          ? "Insufficient permissions"
          : err.reason === "expired"
            ? "Token expired"
            : "Invalid token";
      throw new HttpError(err.statusCode, message);
    }
    throw err;
  }

  const { user, tokenId, expiresAt, permissions } = resolution;

  // H1 — audience binding at the resource server. An MCP-audience token
  // (`health:read`, or `health:read health:write`) is bound to the `/mcp`
  // surface; it may reach `/mcp` (a separate resolver that never runs this
  // edge) and safe REST reads, but a write/delete over REST is outside its
  // audience and is refused — INCLUDING a write-scoped token, whose writes are
  // confined to the in-process `/mcp` tools and never granted over REST. Fail
  // closed when the method is unknown
  // (no event context) since every real REST request runs inside apiHandler,
  // which always sets the method — an unknown method means we cannot prove a
  // read, so we deny. This is RFC 8707 audience binding on the credential the
  // client actually holds, not only during the OAuth exchange.
  //
  // Since the fail-closed scope default landed, this guard is unreachable on
  // the deny path: an MCP-audience token carries no `*`, so `wildcard-only`
  // already refused it in `resolveBearerToken` before we get here (an MCP
  // token's REST reach is now nil, not "safe methods"). It is kept as defence
  // in depth — it still holds the line if a future REST route ever declares
  // `health:read` and so admits the token past the resolver.
  if (isMcpAudienceToken(permissions)) {
    const method = (getEvent()?.getHttpMethod() ?? "").toUpperCase();
    if (!READ_HTTP_METHODS.has(method)) {
      auditLog("auth.bearer.failure", {
        userId: user.id,
        details: {
          reason: "mcp_audience_write_blocked",
          tokenId,
          method: method || "unknown",
        },
      }).catch(() => {});
      throw new HttpError(403, "Insufficient permissions");
    }
  }

  // v1.25 — no per-request success audit row. The polling iOS client drove a
  // constant INSERT + pool checkout on every authenticated Bearer request; the
  // wide event below already records `auth_method: "bearer"` + `user_id`, so the
  // success path stays fully observable without the write churn. The failure
  // path keeps its audit row.
  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: user.id,
      user_role: user.role,
      auth_method: "bearer",
    });
  }

  return {
    session: { id: tokenId, expiresAt },
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
 * v1.23 — require a cookie-backed session, refusing Bearer tokens.
 *
 * Cookie-only by the same structural argument as `requireAdmin`: it resolves
 * the session via `getSession()` (which reads only the session cookie) and
 * never falls through to the Bearer branch. The second-factor management
 * surfaces (TOTP enroll / confirm / disable / recovery-code regenerate) use
 * this so an API token — even a wildcard one — can never enrol or tear down
 * MFA on the account it belongs to. MFA management is a browser-only action.
 */
export async function requireCookieAuth(): Promise<AuthContext> {
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
  return sessionData;
}

/**
 * Error thrown when a step-up gate is not satisfied. Carries `errorCode` so
 * the route can surface a stable machine code (`auth.stepup.required`) the
 * client branches on to launch a re-verification flow rather than parsing
 * prose.
 */
export class StepUpRequiredError extends HttpError {
  constructor(
    public errorCode: string = "auth.stepup.required",
    message = "Recent second-factor verification required",
  ) {
    super(401, message);
    this.name = "StepUpRequiredError";
  }
}

/**
 * Default step-up freshness window (5 minutes) for sensitive mutations.
 * Within the 5–15 min band OWASP recommends; tight end because the gated
 * actions (disable MFA, regenerate codes, and later key rotation / export)
 * are destructive.
 */
export const MFA_STEP_UP_MAX_AGE_SECONDS = 5 * 60;

export type FreshMfaContext = AuthContext & { mfaVerifiedAt: Date };

/**
 * v1.23 — step-up gate. Passes only for a COOKIE session whose
 * `Session.mfaVerifiedAt` is within `maxAgeSeconds` AND whose user has an
 * active second factor (`totpConfirmedAt`). Throws `StepUpRequiredError`
 * (401, `errorCode: "auth.stepup.required"`) otherwise.
 *
 * Bearer tokens can NEVER satisfy this — exactly like `requireAdmin`, the
 * resolution path is `getSession()` (cookie-only) and there is no Bearer
 * fall-through. A token transport carries no `mfaVerifiedAt` and cannot
 * acquire one, so the boundary is structural, not a softenable runtime check.
 *
 * Consumed in Phase M by MFA disable + recovery-code regeneration; later
 * waves gate account deletion, key rotation, and passphrase export on it.
 */
export async function requireFreshMfa(
  maxAgeSeconds: number,
): Promise<FreshMfaContext> {
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

  // The user must actually have a second factor active. A single-factor
  // account cannot produce a fresh-MFA proof, so step-up-gated actions are
  // unreachable for it by design (the management UI gates enrolment first).
  // Either factor counts: a confirmed TOTP secret OR a registered WebAuthn
  // security key — both stamp `Session.mfaVerifiedAt` on a completed login.
  if (!sessionData.user.totpConfirmedAt) {
    const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
      where: { userId: sessionData.user.id },
    });
    if (webauthnKeyCount === 0) {
      throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
    }
  }

  // Read the freshness stamp off the live session row — `getSession`'s
  // projection intentionally omits it.
  const row = await prisma.session.findUnique({
    where: { id: sessionData.session.id },
    select: { mfaVerifiedAt: true },
  });
  const verifiedAt = row?.mfaVerifiedAt ?? null;
  if (!verifiedAt || verifiedAt.getTime() < Date.now() - maxAgeSeconds * 1000) {
    throw new StepUpRequiredError();
  }

  return { ...sessionData, mfaVerifiedAt: verifiedAt };
}

/**
 * v1.23 — conditional step-up for destructive account actions.
 *
 * Resolves the caller with the standard `requireAuth()` (cookie OR Bearer).
 * For an account WITHOUT a confirmed second factor the caller passes straight
 * through — a single-factor user is intentionally unaffected, so account
 * deletion / data reset keeps its existing typed-confirmation-only contract.
 * For an account WITH MFA active (`totpConfirmedAt` set) it additionally runs
 * `requireFreshMfa`, which is cookie-only by construction: an MFA-enrolled
 * account's Bearer transport carries no `mfaVerifiedAt` and therefore cannot
 * satisfy step-up, surfacing `StepUpRequiredError` (401,
 * `errorCode: "auth.stepup.required"`) so the UI launches a re-verification.
 *
 * Gating only the MFA-enrolled cohort keeps the boundary structural: a
 * hijacked live cookie session for an MFA user cannot nuke the record without
 * a fresh factor, while users who never opted into MFA are not forced through
 * a flow they have no way to complete.
 */
export async function requireFreshMfaIfEnrolled(
  maxAgeSeconds: number,
): Promise<AuthContext> {
  const auth = await requireAuth();
  // Either factor enrols the account: a confirmed TOTP secret OR a registered
  // WebAuthn security key. A webauthn-only user must clear step-up too, so the
  // destructive-action boundary tracks `requireFreshMfa`'s either-factor rule.
  let enrolled = Boolean(auth.user.totpConfirmedAt);
  if (!enrolled) {
    const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
      where: { userId: auth.user.id },
    });
    enrolled = webauthnKeyCount > 0;
  }
  if (enrolled) {
    await requireFreshMfa(maxAgeSeconds);
  }
  return auth;
}

/**
 * A Bearer-resolved caller.
 *
 * `apiTokenId` and `accessTokenHash` are named rather than smuggled through
 * `AuthContext.session.id`. That field means "the session row id" on the cookie
 * path and "the ApiToken row id" on the Bearer path, and code that forgot which
 * one it held passed a token id to a session-scoped query — deleting every one
 * of the user's browser sessions and revoking the caller's own refresh token.
 * Naming the fields is what stops that recurring.
 */
export interface BearerAuthContext extends AuthContext {
  /** The `ApiToken` row id — the binding a step-up elevation is tied to. */
  apiTokenId: string;
  /**
   * HMAC of the presented access token, which is what `RefreshToken`
   * cross-references in `accessTokenHash`. Lets a route identify the CALLER's
   * own device login and spare it when revoking every other one.
   */
  accessTokenHash: string;
}

/**
 * v1.30.34 — resolve a caller by Bearer token ONLY, refusing a cookie session.
 *
 * The mirror image of `requireCookieAuth`, and it exists for one surface: the
 * step-up mint endpoints, which are the Bearer transport's own re-authentication
 * flow and have no meaning for a browser (a browser re-proves a factor at login
 * and carries the result on its session row). Refusing the cookie keeps the mint
 * surface entirely outside the cookie's blast radius — no ambient credential can
 * reach it, so the class of attack where a browser is induced to fire a request
 * on the user's behalf simply does not apply.
 *
 * Scope handling is the standard fail-closed default: no declared scope, so only
 * a cookie-equivalent (`["*"]`) token is admitted. A narrow token — an MCP grant,
 * a medication-ingest grant — is refused 403 by the resolver.
 */
export async function requireBearerAuth(): Promise<BearerAuthContext> {
  let authHeader: string | null = null;
  try {
    const headerList = await headers();
    authHeader = headerList.get("authorization");
  } catch {
    authHeader = null;
  }
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Not authenticated");
  }
  const raw = authHeader.slice(7);
  const auth = await authenticateBearer(raw, undefined);
  return {
    ...auth,
    apiTokenId: auth.session.id,
    accessTokenHash: hashToken(raw),
  };
}

/**
 * Header carrying a step-up elevation on the Bearer path. Never logged — the
 * wide event captures no request headers at all, and `redactSecrets` carries an
 * `hle_` rule as a second line of defence.
 */
export const STEP_UP_ELEVATION_HEADER = "x-step-up";

/**
 * What an MFA-management route received, with the transport made explicit.
 *
 * The two arms carry DIFFERENT fields on purpose. A cookie caller has a session
 * row and a Bearer caller does not, so `session` exists only on the cookie arm
 * and the compiler refuses to read it on the other. This is the fix for a real
 * defect: the MFA-disable route passed `session.id` to `destroyOtherSessions`,
 * which on the Bearer path was an ApiToken id — matching no session row, so the
 * "keep the current one" exclusion excluded nothing and the caller revoked its
 * own device login. A comment would not have caught that; a type does.
 */
export type MfaManagementContext = {
  user: User;
  /**
   * Spend the elevation. Call it immediately BEFORE the mutation, once every
   * cheap validation has passed — a 429, a 422, or a wrong factor code must not
   * burn a proof the user then has to mint again against a 5-per-15-minute
   * ceiling.
   *
   * A no-op on the cookie arm (the session stamp is not consumable). On the
   * Bearer arm it is the atomic single-use claim, and it THROWS
   * `StepUpRequiredError` if the claim is lost — so a concurrent redemption
   * still yields exactly one winner even though validation happened earlier.
   */
  commitElevation: () => Promise<void>;
} & (
  | { transport: "cookie"; session: { id: string; expiresAt: Date } }
  | { transport: "bearer"; apiTokenId: string; accessTokenHash: string }
);

/**
 * v1.30.34 — the single gate for second-factor management.
 *
 * Every MFA-management MUTATION goes through here and nothing else does. The set
 * is frozen by `src/__tests__/step-up-elevation-guard.test.ts`, so a future
 * route cannot quietly join it: widening the reach of an elevation has to be a
 * visible edit to that allowlist.
 *
 * Two accepted proofs, and they are equals rather than a primary and a fallback:
 *
 *   COOKIE — unchanged, byte for byte. A cookie session delegates to
 *   `requireCookieAuth` / `requireFreshMfa` exactly as before this function
 *   existed. The web flow cannot regress here because there is no new code on
 *   its path; the elevation branch is only reached when there is no session at
 *   all.
 *
 *   BEARER + ELEVATION — a token that resolves cleanly AND presents a valid,
 *   unconsumed elevation minted for that same token against a re-proved factor
 *   of sufficient strength. The token alone is never enough.
 *
 * FRESH FACTOR IS ABOUT WHICH FACTOR, NOT JUST HOW RECENT. On the cookie path
 * `requireFreshMfa` reads `Session.mfaVerifiedAt`, and only a completed second
 * factor or a primary passkey login ever writes it — a password login does not.
 * The Bearer arm holds the identical line through `FRESH_FACTOR_METHODS`: a
 * password-proved elevation reaches what a plain cookie session reaches and
 * stops there. Without that rule, a stolen token plus the account password could
 * rotate the recovery codes and spend one to disable the second factor.
 *
 * `requireAdmin` is untouched and stays cookie-only. An elevation cannot reach
 * it — not because a check refuses one, but because `requireAdmin` resolves
 * through `getSession()` and never consults this function or the header.
 *
 * @param options.freshFactor mirrors the cookie path's `requireFreshMfa`. Set by
 *   the destructive routes (disable, recovery-code rotation, security-key
 *   removal).
 */
export async function requireMfaManagementAuth(
  options: { freshFactor?: boolean } = {},
): Promise<MfaManagementContext> {
  const freshFactor = options.freshFactor === true;

  // Cookie first, and via the original helpers — the web path runs the same
  // code it always did.
  const sessionData = await getSession();
  if (sessionData) {
    const resolved = freshFactor
      ? await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS)
      : await requireCookieAuth();
    return {
      transport: "cookie",
      user: resolved.user,
      session: resolved.session,
      commitElevation: async () => {},
    };
  }

  // Bearer path. Resolution first: an unknown, revoked, expired, or narrow-scope
  // token is refused here and never gets as far as presenting an elevation.
  const auth = await requireBearerAuth();

  let raw: string | null = null;
  try {
    const headerList = await headers();
    raw = headerList.get(STEP_UP_ELEVATION_HEADER);
  } catch {
    raw = null;
  }

  if (!raw) {
    annotate({
      action: { name: "auth.stepup.elevation.missing" },
      meta: { maxAgeSeconds: STEP_UP_ELEVATION_TTL_SECONDS, freshFactor },
    });
    throw new StepUpRequiredError();
  }

  const refusal = (reason: string): StepUpRequiredError => {
    // One audit row with the machine reason, one generic refusal on the wire.
    // A prober learns only "not accepted" — never whether the elevation was
    // unknown, already spent, expired, minted for a different token, or minted
    // from a factor too weak for this route.
    auditLog("auth.stepup.elevation.rejected", {
      userId: auth.user.id,
      details: { reason, freshFactor },
    }).catch(() => {});
    annotate({
      action: { name: "auth.stepup.elevation.rejected" },
      meta: { reason, freshFactor },
    });
    // Returned rather than thrown so every call site reads `throw refusal(...)`
    // and the compiler narrows the result union afterwards.
    return new StepUpRequiredError();
  };

  // Validate WITHOUT consuming. The route runs its own cheap checks next and
  // spends the elevation only when it is about to act.
  const validated = await validateStepUpElevation({
    rawToken: raw,
    userId: auth.user.id,
    apiTokenId: auth.apiTokenId,
    requireFreshFactor: freshFactor,
  });
  if (!validated.ok) throw refusal(validated.reason);

  // Parity with the cookie path: `requireFreshMfa` refuses an account with no
  // second factor enrolled, because a step-up-gated action is meaningless there.
  // The Bearer path holds the same line rather than becoming the softer route.
  if (freshFactor) {
    let enrolled = Boolean(auth.user.totpConfirmedAt);
    if (!enrolled) {
      const keys = await prisma.webauthnMfaCredential.count({
        where: { userId: auth.user.id },
      });
      enrolled = keys > 0;
    }
    if (!enrolled) {
      throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
    }
  }

  return {
    transport: "bearer",
    user: auth.user,
    apiTokenId: auth.apiTokenId,
    accessTokenHash: auth.accessTokenHash,
    commitElevation: async () => {
      const claimed = await claimStepUpElevation({
        rawToken: raw,
        userId: auth.user.id,
        apiTokenId: auth.apiTokenId,
        requireFreshFactor: freshFactor,
      });
      if (!claimed.ok) throw refusal(claimed.reason);
      annotate({
        action: { name: "auth.stepup.elevation.accepted" },
        meta: { method: claimed.method, freshFactor },
      });
    },
  };
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
      // Query string is already stripped above, but path-segment secrets
      // (e.g. `/api/withings/webhook/<secret>`, `/api/whoop/webhook/<secret>`)
      // survive that strip. Run the same `redactSecrets` pass that guards the
      // message/stack so a `PATH_SECRET_PATHS`-registered secret cannot reach
      // the external incident UI.
      url: redactSecrets(scrubbedUrl),
      sourceTag: "healthlog-api-handler",
      requestId: evt.getRequestId(),
    },
  });
}
