/**
 * The authenticated request context every guard returns, and the two
 * predicates over a credential that more than one guard needs.
 *
 * The guards themselves are in the sibling modules; route handlers import
 * all of them through `@/lib/api-handler`.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import { SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE } from "@/lib/mcp/oauth/config";

/**
 * HTTP methods a read-only credential may use on the REST surface. A request
 * with any other method (POST / PUT / PATCH / DELETE) is a write.
 *
 * The MCP-audience guard below assumes these methods are side-effect-free:
 * an MCP-bound token is admitted on them. A future side-effecting GET (or HEAD)
 * would silently widen that token's reach over REST — do NOT add one without
 * revisiting the MCP audience binding here.
 */
export const READ_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
     * The cookie transport's acting-account carrier, straight off
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
     * How many times this session's record selector has moved. The
     * record-session fence compares it against what the request asserted.
     *
     * Optional for the same reason as `actingAsUserId` above, and `undefined`
     * reads as `0` — which is the fence's exemption, so a hand-built test
     * context keeps meaning "a session that never switched". Read only by the
     * fence.
     */
    readonly recordEpoch?: number;
  };
  user: SessionUser;
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
