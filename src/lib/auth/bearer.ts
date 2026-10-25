/**
 * Canonical Bearer-token validation — the single source of truth for resolving
 * a raw `hlk_<hex>` token to a user.
 *
 * Extracted from `api-handler.ts` so it can be reused outside a Next.js request
 * scope (the local MCP stdio transport runs in a plain Node process and must not
 * drag `next/server` / `next/headers` / the Wide-Event machinery into its import
 * graph). The HTTP edge (`requireAuth` → `authenticateBearer`) and the MCP edge
 * both call this one function, so the revoked / expired / scope / `lastUsedAt`
 * semantics can never drift between the two wires.
 *
 * This module is deliberately lean: it depends only on the HMAC hasher and
 * Prisma. Audit-log emission + Wide-Event annotation stay with each caller (the
 * HTTP path keeps its existing `auth.bearer.*` audit trail), so this layer adds
 * no I/O beyond the two reads the validation needs.
 */
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { SESSION_USER_SELECT, type SessionUser } from "@/lib/auth/session-user";

/** Why a Bearer token was rejected. Stable handles for audit details. */
export type BearerAuthReason =
  | "unknown_token"
  | "revoked"
  | "expired"
  | "insufficient_permissions"
  | "undeclared_scope"
  | "user_missing"
  | "account_deletion_pending";

/**
 * What a caller demands of a token's scope set. Required on every
 * `resolveBearerToken` call — there is deliberately no default, so a new wire
 * cannot re-open the fail-open hole by simply omitting the argument.
 *
 * - `scope` — the route names a grant; a non-wildcard token must list it.
 * - `wildcard-only` — the REST default. A route that declares no scope accepts
 *   cookie sessions and cookie-equivalent (`["*"]`) tokens only. A narrow token
 *   is refused, so adding a route can never silently widen an existing token's
 *   reach.
 * - `any-valid-token` — authentication only; authorisation is decided by the
 *   caller's own wire. This is the single deliberate fail-open posture in the
 *   tree (the `/mcp` transport, which gates on audience + `tokenAllowsWrite`
 *   downstream) and a structural test freezes it to exactly one call site.
 */
export type ScopeRequirement =
  | { kind: "scope"; scope: string }
  | { kind: "wildcard-only" }
  | { kind: "any-valid-token" };

/**
 * Thrown when a token fails validation. Carries the HTTP status the HTTP edge
 * should surface plus the machine `reason` (and, when known, the owning
 * `userId` / `tokenId`) so a caller can write a faithful audit entry without
 * re-deriving them.
 */
export class BearerAuthError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    public readonly reason: BearerAuthReason,
    public readonly userId?: string,
    public readonly tokenId?: string,
  ) {
    super(reason);
    this.name = "BearerAuthError";
  }
}

/** The validated identity behind a Bearer token. */
export interface BearerResolution {
  user: SessionUser;
  /** The `ApiToken` row id (the token-id half of the `<user>:<token>` binding). */
  tokenId: string;
  /** The token's granted scopes (`["*"]` = wildcard). */
  permissions: string[];
  /** Token expiry, or a 30-day fallback window when the token has no fixed expiry. */
  expiresAt: Date;
}

/**
 * Resolve a raw `hlk_<hex>` token to its user, or throw `BearerAuthError`.
 *
 * Lookups are by HMAC hash only — the plaintext token is never compared against
 * a stored value. Authorisation is fail-closed: `requirement` is mandatory and
 * a token carrying no `*` grant is admitted only when the caller names a scope
 * the token lists, or explicitly opts into `any-valid-token`.
 *
 * `lastUsedAt` is refreshed fire-and-forget on success.
 */
export async function resolveBearerToken(
  rawToken: string,
  requirement: ScopeRequirement,
): Promise<BearerResolution> {
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
    throw new BearerAuthError(401, "unknown_token");
  }

  if (apiToken.revoked) {
    throw new BearerAuthError(401, "revoked", apiToken.userId, apiToken.id);
  }

  if (apiToken.expiresAt && apiToken.expiresAt <= new Date()) {
    throw new BearerAuthError(401, "expired", apiToken.userId, apiToken.id);
  }

  // `["*"]` is the wildcard scope — cookie-equivalent, and the only shape the
  // login / passkey / refresh paths mint. It clears every requirement.
  //
  // A narrow token has to be named. `wildcard-only` (the REST default, reached
  // by every route that passes no scope) refuses it outright; `scope` admits it
  // only when the token lists exactly that grant. The deny arm is what a route
  // gets by doing nothing, so a newly added route cannot widen an existing
  // token's reach without a visible diff.
  if (!apiToken.permissions.includes("*")) {
    if (requirement.kind === "wildcard-only") {
      throw new BearerAuthError(
        403,
        "undeclared_scope",
        apiToken.userId,
        apiToken.id,
      );
    }
    if (
      requirement.kind === "scope" &&
      !apiToken.permissions.includes(requirement.scope)
    ) {
      throw new BearerAuthError(
        403,
        "insufficient_permissions",
        apiToken.userId,
        apiToken.id,
      );
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: apiToken.userId },
    select: SESSION_USER_SELECT,
  });

  if (!user) {
    throw new BearerAuthError(
      401,
      "user_missing",
      apiToken.userId,
      apiToken.id,
    );
  }

  // Deleting an account revokes its tokens in the same transaction; this
  // refuses one minted in the moment before that commit.
  if (user.deletionRequestedAt != null) {
    throw new BearerAuthError(
      401,
      "account_deletion_pending",
      apiToken.userId,
      apiToken.id,
    );
  }

  // Fire-and-forget: refresh lastUsedAt without blocking the caller.
  prisma.apiToken
    .update({
      where: { id: apiToken.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  const expiresAt =
    apiToken.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  return {
    user,
    tokenId: apiToken.id,
    permissions: apiToken.permissions,
    expiresAt,
  };
}
