/**
 * Token endpoint (OAuth 2.1) — `authorization_code` + `refresh_token` grants.
 *
 * Exchanges the bridge AS's self-describing artifacts for a REAL `hlk_`
 * `ApiToken` (the access token) minted through `issue-token.ts` with EXACTLY
 * the scopes the authorization code carried — `health:read`, or
 * `health:read health:write` when the user consented to logging (ADR-006). A
 * `health:write` token is still audience-bound to `/mcp`. The access token is
 * therefore an ordinary
 * Bearer the `/mcp` resolver already understands — bound to `<userId>:<tokenId>`
 * (REQ-SEC-11), revocable, and short-lived. There is no token passthrough: the
 * MCP layer never forwards a client-presented upstream credential.
 *
 * Gates:
 *   - PKCE — the presented `code_verifier` MUST hash (S256) to the
 *     `code_challenge` bound into the authorization code.
 *   - Single use — the code's `jti` is claimed once through the atomic
 *     rate-limit upsert; a replay within the TTL is rejected.
 *   - Audience — the code's bound `resource` MUST equal the canonical `/mcp`
 *     URI (RFC 8707); a `resource` parameter, when sent, must match too.
 *   - Client binding — the `client_id` presented at `/token` MUST equal the one
 *     the code was issued to.
 *
 * Refresh tokens rotate on every use (OAuth 2.1 public-client rotation): a fresh
 * access + refresh pair is returned and the presented refresh `jti` is claimed
 * so it cannot be reused.
 */
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { auditLog } from "@/lib/auth/audit";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import {
  checkRateLimit,
  checkAuthSurfaceRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import {
  ACCESS_TOKEN_TTL_MINUTES,
  audienceMatches,
  isMcpOriginConfigured,
  REFRESH_TOKEN_TTL_DAYS,
  SCOPE_HEALTH_READ,
  SCOPE_HEALTH_WRITE,
} from "@/lib/mcp/oauth/config";
import { signArtifact, verifyArtifact } from "@/lib/mcp/oauth/artifacts";
import { verifyPkceS256 } from "@/lib/mcp/oauth/pkce";
import {
  createConnection,
  rotateConnection,
} from "@/lib/mcp/oauth/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_LIMIT = 120;
const TOKEN_WINDOW_MS = 15 * 60 * 1000;

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

function tokenSuccess(body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

/** Claim a one-time-use jti through the atomic limiter (limit 1 ⇒ single use). */
async function claimJti(
  kind: string,
  jti: string,
  ttlMs: number,
): Promise<boolean> {
  if (typeof jti !== "string" || jti.length === 0) return false;
  const rl = await checkRateLimit(`oauth:jti:${kind}:${jti}`, 1, ttlMs);
  return rl.allowed;
}

interface AuthCodeClaims {
  jti: string;
  sub: string;
  client_id: string;
  client_name?: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
}

interface RefreshClaims {
  jti: string;
  /** Connection id — the persistent, revocable anchor for the chain (H2). */
  cid?: string;
  sub: string;
  client_id: string;
  scope: string;
  resource: string;
}

type TokenPairArgs = {
  userId: string;
  clientId: string;
  scope: string;
  resource: string;
  grant: "authorization_code" | "refresh_token";
  connectionId?: string;
  refreshJti?: string;
};

/**
 * Mint the access token (+ refresh artifact when `offline_access` is granted).
 *
 * `connectionId` is the persistent anchor for the refresh chain (H2): the access
 * token is linked to it (so a connection revoke kills it) and the refresh
 * artifact carries it (`cid`). `refreshJti` is the connection's new
 * `currentJti` — for the `authorization_code` grant the caller has just created
 * the connection seeded with it; for `refresh_token` the caller has just
 * advanced the connection to it.
 */
async function mintTokenPair(args: TokenPairArgs): Promise<Response> {
  const access = await persistAccessToken(args);
  return finalizeTokenPair(args, access);
}

async function persistAccessToken(
  args: TokenPairArgs,
  db?: Pick<Prisma.TransactionClient, "apiToken">,
) {
  // Grant EXACTLY the scopes the authorization code carried (read, or
  // read+write). `health:read` is always present; `health:write` is added
  // only when the user consented to it at the authorize step. The token is
  // never widened beyond the approved grant, and `offline_access` is a
  // refresh-continuity marker, not an API permission.
  const grantedScopes = new Set(args.scope.split(/\s+/).filter(Boolean));
  const permissions = [SCOPE_HEALTH_READ];
  if (grantedScopes.has(SCOPE_HEALTH_WRITE)) {
    permissions.push(SCOPE_HEALTH_WRITE);
  }

  const options = {
    userId: args.userId,
    name: "MCP connector",
    permissions,
    expiresInMinutes: ACCESS_TOKEN_TTL_MINUTES,
    ...(args.connectionId ? { mcpConnectionId: args.connectionId } : {}),
  };
  return db ? issueApiToken(options, db) : issueApiToken(options);
}

async function finalizeTokenPair(
  args: TokenPairArgs,
  access: Awaited<ReturnType<typeof issueApiToken>>,
): Promise<Response> {
  const refresh =
    args.connectionId && args.refreshJti
      ? signArtifact(
          "refreshToken",
          {
            jti: args.refreshJti,
            cid: args.connectionId,
            sub: args.userId,
            client_id: args.clientId,
            scope: args.scope,
            resource: args.resource,
          },
          REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        )
      : undefined;

  await auditLog("mcp.oauth.token.issued", {
    userId: args.userId,
    details: { client_id: args.clientId, grant: args.grant, scope: args.scope },
  });
  annotate({
    action: { name: "mcp.oauth.token.issued" },
    meta: { grant: args.grant },
  });

  return tokenSuccess({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MINUTES * 60,
    scope: args.scope,
    ...(refresh ? { refresh_token: refresh } : {}),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return withBackgroundEvent("mcp.oauth.token", async () => {
    // M1 — fail closed without a pinned origin; M4 — honour the operator's
    // global API kill-switch. Either off and the bridge mints no tokens.
    if (!isMcpOriginConfigured() || !(await isApiGloballyEnabled())) {
      return oauthError(
        "temporarily_unavailable",
        "The MCP OAuth surface is unavailable",
        503,
      );
    }

    const rl = await checkAuthSurfaceRateLimit(
      request,
      "mcp:oauth:token",
      TOKEN_LIMIT,
      TOKEN_WINDOW_MS,
    );
    if (!rl.allowed) {
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 429,
          headers: rateLimitHeaders(rl),
        },
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return oauthError(
        "invalid_request",
        "Expected application/x-www-form-urlencoded body",
      );
    }
    const get = (k: string): string | undefined => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };

    const grantType = get("grant_type");

    if (grantType === "authorization_code") {
      const code = get("code");
      const verifier = get("code_verifier");
      const clientId = get("client_id");
      const redirectUri = get("redirect_uri");

      if (!code || !verifier || !clientId || !redirectUri) {
        return oauthError(
          "invalid_request",
          "Missing code, code_verifier, client_id, or redirect_uri",
        );
      }

      const verified = verifyArtifact<AuthCodeClaims>("authCode", code);
      if (!verified.ok) {
        annotate({ action: { name: "mcp.oauth.token.code_rejected" } });
        return oauthError(
          "invalid_grant",
          "Authorization code is invalid or expired",
        );
      }
      const claims = verified.claims;

      // Client + redirect binding.
      if (
        claims.client_id !== clientId ||
        claims.redirect_uri !== redirectUri
      ) {
        return oauthError(
          "invalid_grant",
          "Authorization code was issued to a different client/redirect",
        );
      }
      // Audience: a resource parameter, if present, must also match.
      const resourceParam = get("resource");
      if (resourceParam && !audienceMatches(resourceParam, request.url)) {
        return oauthError(
          "invalid_target",
          "resource does not match the bound audience",
        );
      }
      if (!audienceMatches(claims.resource, request.url)) {
        return oauthError(
          "invalid_target",
          "Authorization code is bound to a different audience",
        );
      }
      // PKCE.
      if (!verifyPkceS256(verifier, claims.code_challenge)) {
        annotate({ action: { name: "mcp.oauth.token.pkce_failed" } });
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      // Single use — claim the code's jti.
      if (!(await claimJti("code", claims.jti, 5 * 60 * 1000))) {
        annotate({ action: { name: "mcp.oauth.token.code_replayed" } });
        return oauthError(
          "invalid_grant",
          "Authorization code has already been used",
        );
      }

      // H2 — when offline_access is granted, create the persistent, revocable
      // connection anchor seeded with the first refresh jti. Without it the
      // refresh chain would be stateless and un-revocable.
      const offlineGranted = claims.scope
        .split(/\s+/)
        .includes("offline_access");
      let connectionId: string | undefined;
      let refreshJti: string | undefined;
      if (offlineGranted) {
        refreshJti = randomUUID();
        connectionId = await createConnection({
          userId: claims.sub,
          clientId: claims.client_id,
          clientName: claims.client_name ?? "MCP client",
          scope: claims.scope,
          resource: claims.resource,
          jti: refreshJti,
        });
      }

      return mintTokenPair({
        userId: claims.sub,
        clientId: claims.client_id,
        scope: claims.scope,
        resource: claims.resource,
        grant: "authorization_code",
        connectionId,
        refreshJti,
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = get("refresh_token");
      const clientId = get("client_id");
      if (!refreshToken || !clientId) {
        return oauthError(
          "invalid_request",
          "Missing refresh_token or client_id",
        );
      }

      const verified = verifyArtifact<RefreshClaims>(
        "refreshToken",
        refreshToken,
      );
      if (!verified.ok) {
        return oauthError(
          "invalid_grant",
          "Refresh token is invalid or expired",
        );
      }
      const claims = verified.claims;
      if (claims.client_id !== clientId) {
        return oauthError(
          "invalid_grant",
          "Refresh token was issued to a different client",
        );
      }
      if (!audienceMatches(claims.resource, request.url)) {
        return oauthError(
          "invalid_target",
          "Refresh token is bound to a different audience",
        );
      }

      // H2 — rotation against the persistent connection anchor. The connection's
      // `currentJti` is the single valid refresh jti; presenting any other (an
      // already-rotated artifact) is a replay that revokes the whole connection
      // (reuse-detection family revocation). A revoked connection always fails,
      // so the settings "revoke" terminates the chain.
      if (!claims.cid) {
        return oauthError(
          "invalid_grant",
          "Refresh token is not bound to a connection",
        );
      }
      const newJti = randomUUID();
      const rotationArgs = {
        connectionId: claims.cid,
        presentedJti: claims.jti,
        newJti,
        clientId: claims.client_id,
        userId: claims.sub,
      };
      const pairArgs: TokenPairArgs = {
        userId: claims.sub,
        clientId: claims.client_id,
        scope: claims.scope,
        resource: claims.resource,
        grant: "refresh_token",
        connectionId: claims.cid,
        refreshJti: newJti,
      };

      // Rotation and successor insertion are one serialized state transition.
      // A replay transaction commits family revocation; a successful
      // transaction commits both JTI advancement and the successor access row.
      // Any insertion error rejects the callback and PostgreSQL rolls every
      // earlier state change back. No artifact is signed inside this callback.
      const exchange = await prisma.$transaction(
        async (tx) => {
          const rotation = await rotateConnection(rotationArgs, tx);
          if (!rotation.ok) {
            return { ok: false as const, rotation };
          }
          const access = await persistAccessToken(pairArgs, tx);
          return { ok: true as const, access };
        },
        { timeout: 10_000 },
      );

      if (!exchange.ok) {
        const { rotation } = exchange;
        annotate({
          action: {
            name:
              rotation.reason === "reuse_detected"
                ? "mcp.oauth.token.refresh_reuse_detected"
                : "mcp.oauth.token.refresh_rejected",
          },
          meta: { reason: rotation.reason },
        });
        return oauthError(
          "invalid_grant",
          rotation.reason === "reuse_detected"
            ? "Refresh token reuse detected; the connection was revoked"
            : "Refresh token is invalid, revoked, or already used",
        );
      }

      // The transaction has committed. Only now may the stateless successor
      // refresh artifact be signed and returned to the client.
      return finalizeTokenPair(pairArgs, exchange.access);
    }

    return oauthError(
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported",
    );
  });
}
