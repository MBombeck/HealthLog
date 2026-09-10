import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import type { AccountGrant, User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { WideEventBuilder } from "./logging/event-builder";
import { annotate, eventStorage, getEvent } from "./logging/context";
import { emitIfSampled } from "./logging/transports";
import { redactOptional, redactSecrets } from "./logging/redact";
import { getSession } from "./auth/session";
import { auditLog, recordDelegatedAccess } from "./auth/audit";
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
import {
  carrierTarget,
  decideActingCarrier,
  readSelectorHeader,
  selectorNamesAnAccount,
  type ActingCarrier,
} from "./auth/acting-carrier";
import { AssistantDisabledError } from "./feature-flags";
import { ConsentRequiredError } from "./ai/consent-guard";
import { SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE } from "./mcp/oauth/config";
import {
  findActiveGrant,
  grantAllows,
  grantCoversDomain,
  touchGrantUsage,
  type GrantNeed,
} from "./sharing/grants";
import type { ShareScope } from "./sharing/scope";
import {
  assertRecordSessionFence,
  attachRecordContextEcho,
} from "./sharing/record-session-fence";
import {
  capturedRateLimit,
  rateLimitResponseHeaders,
  runWithRateLimitCapture,
} from "./rate-limit-context";

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

// The error classes live in the LEAF module `api-errors.ts` (moved to break
// the api-handler ↔ record-session-fence import cycle) and are re-exported
// here so the hundreds of existing importers read exactly as before.
import {
  AUTH_ERROR_CODES,
  HttpError,
  SharingAuthError,
  SharingAccessDeniedError,
  SharingNotPermittedError,
  RecordSessionChangedError,
  StepUpRequiredError,
} from "./api-errors";

export {
  AUTH_ERROR_CODES,
  HttpError,
  SharingAuthError,
  SharingAccessDeniedError,
  SharingNotPermittedError,
  RecordSessionChangedError,
  StepUpRequiredError,
};

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

    return runWithRateLimitCapture(() =>
      eventStorage.run(evt, async () => {
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
          } else if (error instanceof SharingAuthError) {
            // v1.36.0 — the acting-account resolver refused. Same
            // 403 + meta.errorCode envelope as the gates above, so a client
            // distinguishes "you may not act as that account" from "this
            // endpoint does not support acting on one" without parsing prose.
            // Checked before the generic HttpError branch because it extends it.
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
            // `meta.errorCode` only when the throw site named one, so every
            // HttpError without a code serialises byte-identically to before.
            evt.setError(error);
            response = NextResponse.json(
              {
                data: null,
                error: error.message,
                ...(error.errorCode
                  ? { meta: { errorCode: error.errorCode } }
                  : {}),
              },
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
        // v1.37.0 — echo the record context this response was actually served
        // under, when one was decided. The value comes from the wide event and
        // from nowhere else: the fence stamps it on every call it makes, so
        // exactly the responses that resolved a record scope carry it and
        // everything else — public routes, actor surfaces, admin, `/me`, static —
        // carries nothing.
        //
        // Deliberately NOT derived here with a `getSession()`. That would put a
        // session read on every public route, and it would make the echo a second
        // derivation of the context rather than a report of the one that was
        // used, which is the difference between "what this response served" and
        // "what a later read thinks is true".
        //
        // Absence is therefore meaningful and safe: the client discards a
        // response whose echo CONTRADICTS its adopted context, and serves one
        // that carries no echo normally. A discard-on-absence rule would throw
        // away the `/api/version` poll on every cycle.
        //
        // The two header names stay inside the fence module, which is what keeps
        // them to four files overall (declared, read, attached client-side,
        // published) — see `src/__tests__/record-session-fence-guard.test.ts`.
        attachRecordContextEcho(nr.headers, evt.getRecordContext());
        attachRateLimitHeaders(nr);
        return nr;
      }),
    );
  };
  return wrapped as T;
}

/**
 * Put the rate-limit headers on a refusal that left the handler without them.
 *
 * Only ~70 of the 199 route files that consult a limiter attach
 * `rateLimitHeaders(rl)` by hand; the rest answer 429 with a bare prose
 * envelope, so an offline replay queue that trips the batch ceiling has
 * nothing to back off against but a guess. The limiter records its verdict in
 * the request-scoped cell, so the headers can be derived here for every one of
 * them at once instead of being threaded through each call site — and a route
 * added tomorrow gets them without knowing this exists.
 *
 * `Retry-After` is the presence test rather than a flag: a handler that built
 * its own headers already carries it (they come from the same builder), so
 * this leaves that response exactly as it was written.
 */
function attachRateLimitHeaders(response: NextResponse): void {
  if (response.status !== 429) return;
  if (response.headers.has("Retry-After")) return;
  const snapshot = capturedRateLimit();
  if (!snapshot) return;
  for (const [name, value] of Object.entries(
    rateLimitResponseHeaders(snapshot),
  )) {
    response.headers.set(name, value);
  }
}

/**
 * Authenticated request context. Returned by both session-cookie and Bearer-token
 * authentication paths. The `session.id` is the session-record id for cookie auth
 * and the `ApiToken` id for bearer auth — callers must not assume the id refers
 * to a Session row.
 */
export type AuthContext = {
  session: {
    id: string;
    expiresAt: Date;
    /**
     * v1.36.0 — the cookie transport's acting-account carrier, straight off
     * the session row. Absent on the Bearer path, which has no session row and
     * carries its selector in a per-request header instead.
     *
     * Optional so that the ~180 test files which hand `requireAuth` a
     * hand-built session context keep compiling; an absent field means the
     * same thing as a null one — no switch. Only the acting-account resolver
     * below reads it.
     */
    readonly actingAsUserId?: string | null;
    /**
     * v1.37.0 — how many times this session's record selector has moved. The
     * record-session fence compares it against what the request asserted.
     *
     * Optional for the same reason as `actingAsUserId` above, and `undefined`
     * reads as `0` — which is the fence's exemption, so a hand-built test
     * context keeps meaning "a session that never switched". Read only by the
     * fence.
     */
    readonly recordEpoch?: number;
  };
  user: User;
  /**
   * Transport the caller authenticated with, derived from the SAME branch that
   * sets the wide event's `auth_method`: the cookie-session path resolves
   * `"cookie"`, the Bearer-token path resolves `"bearer"`. Read-only and never
   * client-asserted — it is the transport fact, not a request field. A route
   * that must record write provenance (e.g. the medication-intake `source`)
   * maps it server-side, the same posture as `userId` being narrowed from auth.
   */
  readonly authMethod: "cookie" | "bearer";
  /**
   * The named scope that admitted this Bearer, or null when the credential is
   * cookie-equivalent — a session, or a `["*"]` token. A non-null value marks a
   * NARROW, single-purpose credential: one minted for one job, by its own
   * holder, from their own settings page.
   *
   * A single nullable string rather than the token's permission array, and that
   * is the point: nothing downstream can re-derive an authorisation decision
   * from it. The decision was made once, in `resolveBearerToken`; this only
   * reports which arm ran, so a route can refuse a narrow credential something
   * a cookie session may still do.
   *
   * Optional for the reason `actingAsUserId` and `recordEpoch` above are: the
   * test files that hand-build this object keep compiling, and an absent field
   * reads as null — "cookie-equivalent", which is what a hand-built context has
   * always meant.
   */
  readonly bearerScope?: string | null;
};

/**
 * Was this request authenticated by a narrow, single-purpose Bearer scope?
 *
 * The one reader of `bearerScope`, exported so no handler re-derives the test
 * and they cannot drift on what "narrow" means.
 */
export function isScopedCredential(auth: AuthContext): boolean {
  return (auth.bearerScope ?? null) !== null;
}

/**
 * Require an authenticated request. Throws HttpError(401) / HttpError(403) on failure.
 *
 * Auth precedence (cookie-first, never both):
 *   1. Valid session cookie → cookie path (existing behaviour, requiredPermission ignored).
 *   2. No cookie + `Authorization: Bearer hlk_<...>` → API token path.
 *   3. Neither → 401.
 *
 * v1.36.0 — and it REFUSES to run while the request is acting on another
 * account. A bare `requireAuth()` is an undeclared route: nobody has decided
 * whether it is safe under a switch, and the routes that call it include the
 * password change, the MFA management surface, the token mint, and the
 * integration connect. So a request carrying an acting-account carrier gets a
 * 403 `sharing.not_permitted` here, and never a silent fall-back to the
 * caller's own record.
 *
 * The fall-back is the tempting wrong answer and is worth naming: it looks
 * harmless, it keeps every un-migrated route working, and it is the reverse
 * data-mixing failure. A delegate reading what they believe is the owner's
 * record would be shown their own; a delegate writing what they believe is the
 * owner's measurement would write it into theirs. An inaccessible route is an
 * inconvenience. A route that answers with the wrong person's health record is
 * the product being wrong about the only thing it does.
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
  const auth = await authenticateCaller(requiredPermission);
  const carrier = await readActingCarrier(auth);
  if (carrier.kind !== "none") {
    throw refuseUndeclaredMode(auth, carrier);
  }
  return auth;
}

/**
 * Resolve the caller as themselves. The pre-v1.36.0 `requireAuth` body,
 * unchanged, split out so the three declared modes above it can share it.
 *
 * This function knows nothing about acting accounts and must not learn: it is
 * the thing every mode agrees on before they disagree about what the request
 * is allowed to reach.
 */
async function authenticateCaller(
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
    return { ...sessionData, authMethod: "cookie" };
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
  throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);
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
      // Sentence and code are decided together, so a future rewording of the
      // prose cannot silently change what a client does with the refusal.
      const [message, errorCode] =
        err.statusCode === 403
          ? (["Insufficient permissions", AUTH_ERROR_CODES.scope] as const)
          : err.reason === "expired"
            ? (["Token expired", AUTH_ERROR_CODES.expired] as const)
            : (["Invalid token", AUTH_ERROR_CODES.invalid] as const);
      throw new HttpError(err.statusCode, message, errorCode);
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
      throw new HttpError(
        403,
        "Insufficient permissions",
        AUTH_ERROR_CODES.scope,
      );
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
    authMethod: "bearer",
    // Non-null exactly when a NAMED scope admitted a narrow token. A `["*"]`
    // token is cookie-equivalent and reads null however the route was declared;
    // a narrow token on a route that named no scope never reaches this line,
    // because `wildcard-only` already refused it in `resolveBearerToken`.
    //
    // Derived here rather than in the resolver so `bearer.ts` keeps its single
    // authorisation arm: this is a report of the decision that already ran, not
    // a second one.
    bearerScope: permissions.includes("*")
      ? null
      : (requiredPermission ?? null),
  };
}

// ── The acting-account resolver ─────────────────────────────────────────────
//
// One function decides, for every transport, whether this request acts on
// somebody else's record — the same argument that put `resolveBearerToken` in
// one file for two wires. Two carriers converge on one decision because they
// are two answers to one question, and two answers that live apart drift.
//
// That decision now lives in `./auth/acting-carrier`, because a second caller
// needs it: the idempotency wrapper files its replay cell under the record a
// request claims, and it runs before any auth context exists. What stays here
// is what only this file may do — turning a claim into a data scope after a
// live grant says so.

/**
 * The selector header's name, re-exported.
 *
 * It is declared beside the carrier reader it belongs to; every route-facing
 * helper is imported from this module, and the OpenAPI table and the suites
 * that drive a switched request were written against that path.
 */
export { ACCOUNT_SELECTOR_HEADER } from "./auth/acting-carrier";

/**
 * The acting-account carrier for this request.
 *
 * The session value rides out of `getSession()` on the row that call already
 * loaded — a second query for a column we have just read would be waste on
 * every cookie request in the app. What does NOT ride out of `getSession()` is
 * a substituted user: it keeps answering "who is calling" and nothing else,
 * which is exactly why `requireAdmin`, `requireCookieAuth` and
 * `requireFreshMfa` are unreachable by a switch. The carrier is an id to be
 * checked, not a decision that has been made.
 *
 * Fresh on every request, by construction: `getSession()` reads the row from
 * Postgres each time, so a switch cleared by a revocation is gone from the very
 * next request rather than from the next login.
 */
async function readActingCarrier(auth: AuthContext): Promise<ActingCarrier> {
  return decideActingCarrier({
    transport: auth.authMethod === "bearer" ? "bearer" : "cookie",
    stamped: auth.session.actingAsUserId ?? null,
    header: await readSelectorHeader(),
  });
}

/**
 * Record a refused delegation.
 *
 * The row is filed under the CALLER, with no actor, and it is the operator's
 * trail rather than the owner's. It names who called, the account they claimed,
 * and why the claim was refused — none of which reaches the response.
 *
 * It is deliberately not filed under the claimed account, and that decision is
 * worth stating because the opposite reads as the obvious one. A row is only
 * written for a HEADER refusal, and a header is an unverified per-request
 * assertion: the value is whatever the caller typed. Filing under it would let
 * any authenticated caller write rows into any account's activity feed by
 * naming it, which is a spam vector aimed at exactly the panel that exists to
 * be trustworthy. Verifying the claim first would mean a grant lookup on a path
 * whose whole job is to refuse without touching the record.
 *
 * What the owner does see is the other half: `recordDelegatedAccess` files a
 * per-day row under the OWNER, naming the actor, for every delegated read that
 * succeeded. "Who reached my record" is answered there. "Whose client sent a
 * malformed claim" is an operator question and stays here.
 *
 * Fire-and-forget: an audit write that fails must not convert a 403 into a 500,
 * because the 403 is the part that protects the record.
 */
function auditRefusal(
  auth: AuthContext,
  carrier: ActingCarrier,
  reason: string,
): void {
  auditLog("sharing.access.denied", {
    userId: auth.user.id,
    details: {
      reason,
      carrier: carrier.kind,
      target: carrierTarget(carrier),
      method: getEvent()?.getHttpMethod() ?? null,
    },
  }).catch(() => {});
}

/**
 * This request says it is acting on another account and this route will not.
 *
 * Three ways to arrive: a route that never declared a mode (`undeclared_mode`),
 * a selector sent over the transport that does not carry one
 * (`misplaced_selector`), and a narrow single-purpose Bearer naming a record
 * that is not its owner's (`narrow_scope_selector`). One response every way —
 * the caller learns that the request will not be served, and nothing about
 * grants.
 *
 * The audit rule, stated once because it is a judgement call: a HEADER refusal
 * always writes a row, a SESSION refusal never does. The header is a per-request
 * assertion by a client — a bug or a probe, and both are worth a durable record.
 * The session field is ambient browser state: while a switch is on, every
 * navigation, prefetch and poll that touches a non-delegable route lands here,
 * and a row per such request would bury the header rows that matter under noise
 * from the feature working as designed. Both are on the wide event either way.
 */
function refuseUndeclaredMode(
  auth: AuthContext,
  carrier: ActingCarrier,
  reason:
    | "undeclared_mode"
    | "misplaced_selector"
    | "narrow_scope_selector" = "undeclared_mode",
): SharingNotPermittedError {
  annotate({ meta: { sharing_refusal: reason } });
  if (carrier.kind !== "session") {
    auditRefusal(auth, carrier, reason);
  }
  return new SharingNotPermittedError();
}

/**
 * v1.36.0 — an actor surface: this route always serves the CALLER's own rows.
 *
 * It works under a switch. That is the whole reason the mode exists: the
 * switcher itself, the banner, and the "which records may I open" list all have
 * to keep answering while the browser is acting as someone else, and every one
 * of them is about the delegate. So the session carrier is read and
 * deliberately ignored — no query, because there is nothing the answer could
 * change.
 *
 * A selector HEADER is refused, loudly. An actor surface is DEFINED as serving
 * the caller's own rows, so a client that attaches a selector to one has a bug,
 * and the bug is invisible until somebody files a support ticket about data
 * that looks wrong. Ignoring the header would serve exactly the right response
 * to exactly the wrong expectation.
 */
export async function requireActorAuth(): Promise<AuthContext> {
  const auth = await authenticateCaller();
  const header = await readSelectorHeader();
  if (header !== null) {
    annotate({ meta: { sharing_refusal: "actor_surface" } });
    auditRefusal(auth, { kind: "header", accountId: header }, "actor_surface");
    throw new SharingNotPermittedError();
  }
  return auth;
}

/**
 * A request resolved against a record that may not be the caller's own.
 *
 * `user` is the account whose rows the handler must read and write — so an
 * existing `where: { userId: user.id }` is correct without being touched, which
 * is what keeps a route migration a one-line change instead of an audit.
 * `actor` is who is actually here. They are the same object when no switch is
 * active.
 */
export interface RecordAuthContext extends AuthContext {
  /** The authenticated caller. Equals `user` when the caller acts as themselves. */
  readonly actor: User;
  /** The grant being exercised, or null when the caller acts as themselves. */
  readonly grantId: string | null;
}

/** What a delegable route may additionally declare about the credentials it takes. */
export interface RecordAuthOptions {
  /**
   * A Bearer scope this route accepts in place of the cookie-equivalent
   * default. Naming one is a WIDENING — it admits a credential class the route
   * refused before — and is frozen by `bearer-scope-enforcement-guard.test.ts`
   * exactly like a `requireAuth` scope, so it lands in a reviewed diff.
   *
   * What the option does NOT do is relax anything below it. A credential
   * admitted this way is single-purpose: it reaches this route on its OWN
   * record and is refused the moment the request names another, before any
   * grant is read. The `need` and `domain` checks run unchanged for everyone
   * else.
   */
  readonly scope?: string;
}

/**
 * v1.36.0 — a delegable surface: this route may act on a shared record.
 *
 * Calling it is a DECLARATION, reviewed and frozen by a structural guard, that
 * the route reads or writes health data and nothing else — no credential, no
 * integration, no notification channel, no grant management, nothing that would
 * let a delegate extend their own reach. The declaration is the security
 * property; this function only enforces what was declared.
 *
 * @param need what the route does to the record. `"read"` still refuses a
 *   non-safe HTTP method under a read-only grant: the declaration and the
 *   method must BOTH be satisfiable, so a delegable GET handler that grows a
 *   POST export cannot quietly inherit the read grant's permission. An unknown
 *   method (no event context) counts as a write and is refused, the same
 *   fail-closed posture as the MCP audience guard above. A route declaring
 *   `"manage"` refuses everything below it regardless of method: the method
 *   can only escalate what the declaration asked for, never satisfy it.
 * @param domain v1.37.0 — which section of the record the route touches, or
 *   `"record"` when it reads across sections. Required, and the requirement is
 *   the fail-closed lever: a delegable route without a classification does not
 *   typecheck, so the set of routes carrying one cannot fall behind the set of
 *   routes that are delegable. The value is frozen per module by
 *   `src/__tests__/sharing-surface-guard.test.ts` and reviewed against the
 *   design's clustering table; this function only enforces what was declared.
 * @param options v1.38.x — optional extra declarations. Today that is `scope`,
 *   naming a narrow Bearer this route admits alongside cookie sessions and
 *   cookie-equivalent tokens. A route that passes none keeps the fail-closed
 *   default and refuses every narrow token, which is what makes adding one a
 *   visible decision rather than an omission.
 */
export async function requireRecordAuth(
  need: GrantNeed,
  domain: ShareScope,
  options?: RecordAuthOptions,
): Promise<RecordAuthContext> {
  const auth = await authenticateCaller(options?.scope);
  // v1.37.0 — before any carrier is read, any grant is looked up, or any record
  // row is touched: does this request still believe what its session believes?
  //
  // The atomicity that makes this a tautology rather than a race: the epoch the
  // fence compares and the `actingAsUserId` the carrier below is built from are
  // BOTH projected off the one session row `authenticateCaller()` already
  // loaded. The scope this handler serves under and the epoch it validated are
  // therefore the same fact read at the same instant, not two reads a commit
  // can land between. Do not add a second session read here to "refresh" it —
  // that would reintroduce exactly the window this ordering removes.
  //
  // `authenticateCaller` necessarily runs first because it supplies the row the
  // fence reads, so the invariant is "before the carrier", not "before the
  // first database await".
  await assertRecordSessionFence(auth);
  const carrier = await readActingCarrier(auth);

  // A narrow, single-purpose Bearer never acts on another record.
  //
  // Its holder mints it themselves, for one job, and pastes it into something
  // that is not this app — a scale bridge, a home-automation rule. Admitting it
  // under a selector would exercise somebody else's grant through a credential
  // nobody reviewed for that purpose, and the blast radius of the paste would
  // stop being "my own record" without anyone deciding it should.
  //
  // Placed above the `none` arm and below the carrier read, which is the only
  // position that is both correct and cheap: no grant is looked up on the way
  // to the refusal, and a scoped credential on its own record still falls
  // through to the untouched `none` path below. A `["*"]` token and a cookie
  // session read `bearerScope: null` here and keep exactly the delegation
  // behaviour they had.
  if (carrier.kind !== "none" && isScopedCredential(auth)) {
    throw refuseUndeclaredMode(auth, carrier, "narrow_scope_selector");
  }

  if (carrier.kind === "none") {
    // Do no harm: without a carrier this is byte-for-byte the pre-v1.36.0
    // request, resolved by the same `authenticateCaller` every other mode uses.
    getEvent()?.setProviderWorkAuthority({
      origin: "owner",
      recordUserId: auth.user.id,
      actorUserId: auth.user.id,
      grantId: null,
    });
    return { ...auth, actor: auth.user, grantId: null };
  }
  if (carrier.kind === "misplaced-header") {
    // The route DID declare a mode; the client sent the selector over the
    // cookie transport, where the carrier is the session row.
    throw refuseUndeclaredMode(auth, carrier, "misplaced_selector");
  }

  const method = (getEvent()?.getHttpMethod() ?? "").toUpperCase();
  const effectiveNeed: GrantNeed =
    need !== "read" || !READ_HTTP_METHODS.has(method) ? escalate(need) : "read";

  return resolveSwitchedRecord(auth, carrier, (grant) => {
    if (!grantAllows(grant, effectiveNeed)) return "insufficient_access";
    // Level first, then scope, and the order is visible on the wire in exactly
    // one way: not at all. Both refusals are the same error with the same
    // bytes, and only the audit reason differs — so the ordering is a choice
    // about what the operator's trail says happened, not about what the caller
    // learns. It says the bigger thing: a delegate who was never given this
    // level is a different story from one whose sections do not reach here.
    if (!grantCoversDomain(grant, domain)) return "out_of_scope";
    return null;
  });
}

/**
 * The need a non-safe method implies, for a route that declared `need`.
 *
 * A PUT on a route declaring `"read"` needs a write grant, which is what this
 * has always done. A PUT on a route declaring `"manage"` needs a MANAGE grant
 * and must not be reduced to a write — so the escalation raises the floor to
 * `"write"` and never lowers a declaration that already sits above it.
 */
function escalate(need: GrantNeed): GrantNeed {
  return need === "manage" ? "manage" : "write";
}

/**
 * v1.37.0 — a guardian surface: this route administers a managed profile.
 *
 * The other declaration, and a separate function rather than a flag on the one
 * above, for the reason `requireActorAuth` is also separate: the guard freezes
 * each declaration as its own list, so a route moving between them is a diff a
 * human reviews rather than an argument about a parameter.
 *
 * What it admits is narrower than it looks. An active MANAGE grant is
 * necessary and NOT sufficient — the record must also carry the managed-profile
 * marker. That second condition is the identity fence, and it is the line
 * between "manage my data" and "own my account": an adult who granted
 * management of their own record reaches none of this, at any level, by any
 * argument, because their record has no marker and never will while they hold
 * it. A managed profile has no self to reserve these surfaces for, so its
 * guardian holds them.
 *
 * The fence is gated on the marker rather than on the grant precisely so that
 * no future change to what MANAGE means can reach through it. Widening MANAGE
 * would widen `requireRecordAuth`; it would not touch this function.
 */
export async function requireGuardianAuth(): Promise<RecordAuthContext> {
  const auth = await authenticateCaller();
  // Same placement and the same reason as `requireRecordAuth` above: the
  // guardian surfaces administer a managed profile, so a request arriving under
  // a context that has since moved must be refused before the marker is read,
  // not after.
  await assertRecordSessionFence(auth);
  const carrier = await readActingCarrier(auth);

  if (carrier.kind === "none") {
    // The owner of an ordinary record, reaching their own settings. Same
    // do-no-harm posture as the record resolver: without a carrier this is the
    // request it always was.
    return { ...auth, actor: auth.user, grantId: null };
  }
  if (carrier.kind === "misplaced-header") {
    throw refuseUndeclaredMode(auth, carrier, "misplaced_selector");
  }

  return resolveSwitchedRecord(auth, carrier, (grant, owner) => {
    if (!grantAllows(grant, "manage")) return "insufficient_access";
    if (owner.managedProfileAt === null) return "guardian_only";
    return null;
  });
}

/**
 * The shared body of both record resolvers: turn a selector into an owner, or
 * refuse.
 *
 * Everything either resolver does with a carrier lives here except the
 * admission rule itself, which arrives as `admit` — a function of the grant
 * and the owner returning an audit reason to refuse with, or null to proceed.
 * The split is where it is because the two resolvers differ in exactly that
 * one decision and in nothing else, and two copies of the grant lookup, the
 * refusal shape, the usage stamp and the owner's access row would be two
 * copies to keep in step.
 *
 * The owner row is loaded BEFORE the admission runs, which is a change from
 * v1.36.0's ordering and a deliberate one: the guardian rule is a fact about
 * the owner, so it cannot be decided before the owner is known. Nothing about
 * the refusal moved — every arm below is the same error with the same bytes,
 * and an admission that refuses after the load costs one query it does not use
 * and tells the caller nothing extra.
 */
async function resolveSwitchedRecord(
  auth: AuthContext,
  carrier: Extract<ActingCarrier, { accountId: string }>,
  admit: (grant: AccountGrant, owner: User) => string | null,
): Promise<RecordAuthContext> {
  /** Every refusal below is this one error, with the reason kept off the wire. */
  const denied = (reason: string): SharingAccessDeniedError => {
    annotate({ meta: { sharing_refusal: reason } });
    auditRefusal(auth, carrier, reason);
    return new SharingAccessDeniedError();
  };

  if (!selectorNamesAnAccount(carrier.accountId)) {
    throw denied("malformed_selector");
  }

  // Loaded here, on this request, every request. Not memoised on the session,
  // not cached in the process, not carried on the token: a revocation has to
  // land on the delegate's NEXT request, not on their next login. That is the
  // one property the owner is actually promised when they press revoke.
  //
  // Note what is NOT looked up: the account named by the carrier. An account
  // that does not exist and an account that granted nothing produce the same
  // empty row from the same query, which is what makes the two refusals
  // identical in bytes and in timing rather than identical by careful wording.
  const grant = await findActiveGrant({
    grantorId: carrier.accountId,
    granteeId: auth.user.id,
  });
  if (!grant) throw denied("no_active_grant");

  const owner = await prisma.user.findUnique({
    where: { id: grant.grantorId },
  });
  // Unreachable while the FK cascade holds — a grant naming a deleted account
  // is deleted with it. Fail closed anyway: an authorization we cannot resolve
  // to a person is not one to act on.
  if (!owner) throw denied("owner_missing");

  const refusal = admit(grant, owner);
  if (refusal !== null) throw denied(refusal);

  getEvent()?.setActingAs(owner.id);
  // v1.37.0 — and whether this request may spend the owner's provider budget.
  // MANAGE opens the generated reads; it does not open the generation behind
  // them, because the owner would pay for and consent to an egress they did
  // not cause. A managed profile is the exception and the reason the marker is
  // read here rather than the grant: it has no self to protect from its own
  // guardian. Stamped where the owner row is already loaded, so no generator
  // has to be told; see `src/lib/sharing/delegated-generation.ts`.
  if (owner.id !== auth.user.id && owner.managedProfileAt === null) {
    getEvent()?.setDelegatedGenerationSuppressed();
  }
  getEvent()?.setProviderWorkAuthority({
    origin: owner.managedProfileAt === null ? "delegate" : "guardian",
    recordUserId: owner.id,
    actorUserId: auth.user.id,
    grantId: grant.id,
  });
  // Fire-and-forget, the `ApiToken.lastUsedAt` posture: the read must not wait
  // on the bookkeeping, and the bookkeeping failing must not fail the read.
  void touchGrantUsage(grant.id);
  // The owner's copy of the same fact, and the one they can read: a day-
  // coalesced row on their own record saying who opened it. It lands here
  // rather than in the handlers because a route cannot forget what it never
  // had to remember — every delegated request in the product passes through
  // this line, and only requests that got past the grant check reach it.
  void recordDelegatedAccess(owner.id, auth.user.id);

  return {
    session: auth.session,
    user: owner,
    authMethod: auth.authMethod,
    actor: auth.user,
    grantId: grant.id,
  };
}

/**
 * Require an authenticated admin user. Throws HttpError(401) or HttpError(403).
 * Cookie-only — Bearer tokens never elevate to admin (security boundary).
 * Automatically annotates the Wide Event with auth context.
 *
 * v1.36.0 — unreachable by a switch, structurally: it resolves through
 * `getSession()`, which knows only who is calling, and the role is read off
 * that row. Switching into an ADMIN's record therefore confers nothing, and
 * making it confer something would take a deliberate edit here rather than an
 * oversight elsewhere.
 */
export async function requireAdmin(): Promise<AuthContext> {
  const sessionData = await getSession();
  if (!sessionData)
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  if (sessionData.user.role !== "ADMIN") {
    throw new HttpError(403, "Admin access required", AUTH_ERROR_CODES.admin);
  }
  return { ...sessionData, authMethod: "cookie" };
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
  if (!sessionData)
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }
  return { ...sessionData, authMethod: "cookie" };
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
 * Which credentials count when asking "can this account produce a fresh-factor
 * proof at all".
 *
 * The gate is the same either way — a `Session.mfaVerifiedAt` inside the window
 * on the cookie path, an elevation minted from a `FRESH_FACTOR_METHODS` proof on
 * the Bearer path. What differs is the pre-check that decides whether refusing
 * would be a gate or a dead end, and the honest answer to that depends on what
 * the route is protecting.
 *
 *   `second-factor` — a confirmed TOTP secret or a registered second-factor
 *   security key. The default, and the right question for the routes that MANAGE
 *   a second factor: there is nothing there to protect if nothing is enrolled.
 *
 *   `any-possession` — the above, OR a registered PRIMARY passkey. The right
 *   question for a route protecting the passkey itself, because a passkey is a
 *   possession factor in its own right and this codebase already treats it as
 *   one in three places: `/api/auth/passkey/login-verify` stamps `mfaVerifiedAt`
 *   on a passkey login (v1.23, M-review M1), `passkey` is in
 *   `FRESH_FACTOR_METHODS` so a passkey-proved elevation reaches the fresh-factor
 *   routes, and `resolveMfaEnrollmentRequired` counts a primary passkey as
 *   satisfying the enforcement policy outright. A passkey-only account can
 *   therefore clear the gate on both transports, and asking the narrower
 *   question would have thrown `mfa_not_enrolled` at an account that was holding
 *   the proof all along.
 */
export type FreshFactorProofSource = "second-factor" | "any-possession";

/**
 * v1.23 — step-up gate. Passes only for a COOKIE session whose
 * `Session.mfaVerifiedAt` is within `maxAgeSeconds` AND whose user holds a
 * credential that can produce such a stamp. Throws `StepUpRequiredError`
 * (401, `errorCode: "auth.stepup.required"`) otherwise.
 *
 * Bearer tokens can NEVER satisfy this — exactly like `requireAdmin`, the
 * resolution path is `getSession()` (cookie-only) and there is no Bearer
 * fall-through. A token transport carries no `mfaVerifiedAt` and cannot
 * acquire one, so the boundary is structural, not a softenable runtime check.
 *
 * Consumed in Phase M by MFA disable + recovery-code regeneration; later
 * waves gate account deletion, key rotation, and passphrase export on it.
 *
 * @param proofSource which credentials count as "can prove a factor". Defaults
 *   to the second-factor set every existing caller means; see
 *   {@link FreshFactorProofSource}.
 */
export async function requireFreshMfa(
  maxAgeSeconds: number,
  proofSource: FreshFactorProofSource = "second-factor",
): Promise<FreshMfaContext> {
  const sessionData = await getSession();
  if (!sessionData)
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  // The account must hold a credential that can stamp `mfaVerifiedAt` in the
  // first place. Without one a step-up-gated action is unreachable by design
  // rather than merely refused, so the refusal is named differently
  // (`mfa_not_enrolled`) and the management UI gates enrolment ahead of it.
  if (!(await canProveFreshFactor(sessionData.user, proofSource))) {
    throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
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

  return { ...sessionData, authMethod: "cookie", mfaVerifiedAt: verifiedAt };
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
  if (await hasSecondFactorEnrolled(auth.user)) {
    await requireFreshMfa(maxAgeSeconds);
  }
  return auth;
}

/**
 * What an erasure route received: the caller, plus the hook that spends a
 * Bearer elevation. See `MfaManagementContext.commitElevation` for the
 * contract — call it immediately before the mutation, after every cheap
 * refusal (a bad confirmation, the last-admin check) has passed, so a 422
 * does not burn a proof the user then has to mint again.
 */
export type ErasureAuthContext = AuthContext & {
  commitElevation: () => Promise<void>;
};

/**
 * The sibling of `requireFreshMfaIfEnrolled` for the two erasure routes —
 * account deletion and the record wipe — and only those.
 *
 * WHY IT EXISTS. App Store guideline 5.1.1(v) requires that an account created
 * in the app can be deleted from the app. `requireFreshMfaIfEnrolled` gates an
 * MFA-enrolled account on `requireFreshMfa`, which is cookie-only by
 * construction, so a native-app user with a second factor could not delete
 * their account from the app at all: the Bearer transport had no way to
 * present a fresh factor and the route answered 401 "Not authenticated" to a
 * perfectly valid token. This helper adds the Bearer arm without touching
 * `requireFreshMfa`, which stays cookie-only.
 *
 * THE THREE ARMS.
 *
 *   No second factor enrolled — pass through on either transport, exactly as
 *   the sibling does. A user who never enrolled has no ceremony to complete.
 *
 *   Cookie + enrolled — `requireFreshMfa`, unchanged: `Session.mfaVerifiedAt`
 *   within the window. A browser session cannot tell the two helpers apart.
 *
 *   Bearer + enrolled — a step-up elevation in the `X-Step-Up` header, minted
 *   by `POST /api/auth/step-up` against a re-proved factor, validated by the
 *   same code the MFA-management routes use and with `freshFactor` pinned ON:
 *   a `totp`, `webauthn`, or `passkey` proof passes; a password proof is
 *   refused with the same generic 401, because a password login has never
 *   satisfied step-up on the web and must not start here. The elevation is
 *   token-bound, single-use, and five minutes wide — the cookie window.
 *
 * WHAT IT DOES NOT DO. Scope is `requireAuth()`'s fail-closed default, so a
 * narrow token is refused 403 before the header is read. A recovery code is
 * not accepted on Bearer — the mint does not take one, and `FRESH_FACTOR_METHODS`
 * says why; an account that has lost its authenticator erases itself on the
 * web, where `/api/auth/mfa/verify` accepts the code and stamps the session.
 * And the gate takes no factor in the BODY: there is one mint surface and one
 * redemption path, which is what `step-up-elevation-guard.test.ts` freezes.
 */
export async function requireFreshMfaOrElevationIfEnrolled(
  maxAgeSeconds: number,
): Promise<ErasureAuthContext> {
  const auth = await requireAuth();
  const noop = async () => {};

  if (!(await hasSecondFactorEnrolled(auth.user))) {
    return { ...auth, commitElevation: noop };
  }

  if (auth.authMethod === "cookie") {
    await requireFreshMfa(maxAgeSeconds);
    return { ...auth, commitElevation: noop };
  }

  // On the Bearer path `requireAuth` puts the resolved `ApiToken` row id in
  // `session.id` — the binding the elevation was minted against.
  const commitElevation = await resolveBearerElevation(
    { user: auth.user, apiTokenId: auth.session.id },
    { freshFactor: true, proofSource: "second-factor" },
  );
  return { ...auth, commitElevation };
}

/**
 * Does this account have a SECOND FACTOR at all?
 *
 * Either factor enrols it: a confirmed TOTP secret OR a registered WebAuthn
 * security key. A webauthn-only account must clear step-up too, so every
 * boundary that asks this question tracks `requireFreshMfa`'s either-factor
 * rule rather than reading `totpConfirmedAt` alone. It was written out three
 * times before it was a function, which is two more places for the second arm
 * to be forgotten.
 *
 * DELIBERATELY DOES NOT COUNT A PRIMARY PASSKEY, even though a passkey login
 * stamps `mfaVerifiedAt` and could therefore satisfy the gate. This predicate
 * answers "is there a second factor", and that is the question
 * `requireFreshMfaIfEnrolled` asks before deciding whether account deletion, the
 * data reset, the password change, the encrypted export and key rotation demand
 * a step-up at all. Counting a passkey here would silently pull every
 * passkey-holding account into a gate those routes have never applied to them —
 * a behaviour change to five destructive actions, made in passing, for the
 * benefit of a sixth. {@link canProveFreshFactor} is where the wider question
 * lives.
 */
async function hasSecondFactorEnrolled(user: {
  id: string;
  totpConfirmedAt: Date | null;
}): Promise<boolean> {
  if (user.totpConfirmedAt) return true;
  const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
    where: { userId: user.id },
  });
  return webauthnKeyCount > 0;
}

/**
 * Can this account produce a fresh-factor proof at all?
 *
 * The wider question, asked by the routes that gate on possession rather than
 * on second-factor management. See {@link FreshFactorProofSource} for why a
 * primary passkey answers yes and where the codebase already says so; see
 * {@link hasSecondFactorEnrolled} for why the narrower predicate must not be
 * widened into this one.
 */
async function canProveFreshFactor(
  user: { id: string; totpConfirmedAt: Date | null },
  proofSource: FreshFactorProofSource,
): Promise<boolean> {
  if (await hasSecondFactorEnrolled(user)) return true;
  if (proofSource === "second-factor") return false;
  const passkeyCount = await prisma.passkey.count({
    where: { userId: user.id },
  });
  return passkeyCount > 0;
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
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);
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
 *   removal, passkey removal).
 * @param options.proofSource which credentials count as "can prove a factor"
 *   when deciding whether the gate is reachable. Defaults to the second-factor
 *   set. Passkey removal passes `"any-possession"` because a primary passkey IS
 *   the proof there — see {@link FreshFactorProofSource}. It changes only the
 *   reachability pre-check; the gate itself is identical either way.
 */
export async function requireMfaManagementAuth(
  options: {
    freshFactor?: boolean;
    proofSource?: FreshFactorProofSource;
  } = {},
): Promise<MfaManagementContext> {
  const freshFactor = options.freshFactor === true;
  const proofSource = options.proofSource ?? "second-factor";

  // Cookie first, and via the original helpers — the web path runs the same
  // code it always did.
  const sessionData = await getSession();
  if (sessionData) {
    const resolved = freshFactor
      ? await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS, proofSource)
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
  const commitElevation = await resolveBearerElevation(
    { user: auth.user, apiTokenId: auth.apiTokenId },
    { freshFactor, proofSource },
  );

  return {
    transport: "bearer",
    user: auth.user,
    apiTokenId: auth.apiTokenId,
    accessTokenHash: auth.accessTokenHash,
    commitElevation,
  };
}

/**
 * The Bearer elevation arm, shared by `requireMfaManagementAuth` and
 * `requireFreshMfaOrElevationIfEnrolled` so there is exactly one place that
 * reads the header, validates, refuses, and claims.
 *
 * Takes an ALREADY-RESOLVED Bearer caller: the token's own validity and scope
 * were decided before this runs, and nothing here can widen that decision. It
 * returns the commit closure — the atomic single-use claim — and throws
 * `StepUpRequiredError` for a missing, unknown, foreign, spent, expired, or
 * too-weak elevation, with the real reason in the audit row and none of it on
 * the wire.
 */
async function resolveBearerElevation(
  auth: { user: User; apiTokenId: string },
  options: { freshFactor: boolean; proofSource: FreshFactorProofSource },
): Promise<() => Promise<void>> {
  const { freshFactor, proofSource } = options;

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
  const rawToken = raw;

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
    rawToken,
    userId: auth.user.id,
    apiTokenId: auth.apiTokenId,
    requireFreshFactor: freshFactor,
  });
  if (!validated.ok) throw refusal(validated.reason);

  // Parity with the cookie path: `requireFreshMfa` refuses an account that holds
  // no credential able to produce the proof, because a step-up-gated action is
  // unreachable rather than merely refused there. The Bearer path asks the same
  // question, with the same `proofSource`, rather than becoming the softer or
  // the stricter route.
  if (freshFactor && !(await canProveFreshFactor(auth.user, proofSource))) {
    throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
  }

  return async () => {
    const claimed = await claimStepUpElevation({
      rawToken,
      userId: auth.user.id,
      apiTokenId: auth.apiTokenId,
      requireFreshFactor: freshFactor,
    });
    if (!claimed.ok) throw refusal(claimed.reason);
    annotate({
      action: { name: "auth.stepup.elevation.accepted" },
      meta: { method: claimed.method, freshFactor },
    });
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
