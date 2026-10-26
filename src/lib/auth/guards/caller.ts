import { headers } from "next/headers";

import { getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  resolveBearerToken,
  BearerAuthError,
  type ScopeRequirement,
} from "@/lib/auth/bearer";
import { hashToken } from "@/lib/auth/hmac";
import {
  meterAccountWrite,
  type WriteMeterOptions,
} from "@/lib/auth/write-meter";
import { getSession } from "@/lib/auth/session";
import { AUTH_ERROR_CODES, HttpError } from "@/lib/api-errors";

import { readActingCarrier, refuseUndeclaredMode } from "./acting";
import {
  READ_HTTP_METHODS,
  isMcpAudienceToken,
  type AuthContext,
} from "./context";

/**
 * Require an authenticated request. Throws HttpError(401) / HttpError(403) on failure.
 *
 * Auth precedence (cookie-first, never both):
 *   1. Valid session cookie → cookie path (existing behaviour, requiredPermission ignored).
 *   2. No cookie + `Authorization: Bearer hlk_<...>` → API token path.
 *   3. Neither → 401.
 *
 * And it REFUSES to run while the request is acting on another
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
  options?: WriteMeterOptions,
): Promise<AuthContext> {
  const auth = await authenticateCaller(requiredPermission);
  const carrier = await readActingCarrier(auth);
  if (carrier.kind !== "none") {
    throw refuseUndeclaredMode(auth, carrier);
  }
  // The shared write ceiling, for every write this resolver admits — see
  // `meterAccountWrite`.
  await meterAccountWrite(auth.user.id, options);
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
export async function authenticateCaller(
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
export async function authenticateBearer(
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

  // No per-request success audit row. The polling iOS client drove a
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
 * Resolve a caller by Bearer token ONLY, refusing a cookie session.
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
  await meterAccountWrite(auth.user.id);
  return {
    ...auth,
    apiTokenId: auth.session.id,
    accessTokenHash: hashToken(raw),
  };
}
