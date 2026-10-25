/**
 * Daily cleanup for the MCP OAuth surface (M2).
 *
 * Every `authorization_code` exchange and every hourly refresh mints a fresh
 * 60-minute `hlk_` access-token row through the bridge. Nothing deleted the
 * expired/revoked rows, so a single connection refreshing hourly left ~720 dead
 * rows per month, forever — unbounded table growth, and (before the connection
 * model) a flooded connector list.
 *
 * This sweep hard-deletes MCP-connector access tokens that are past a short
 * grace window after expiry, or revoked. It is scoped to `health:read`-only
 * connector rows so it never touches native-client or wildcard tokens. Long-
 * revoked connection anchors are pruned too once no access token references
 * them, keeping the `mcp_oauth_connections` table bounded.
 */
// account-deletion(file): removes revoked or expired connector tokens; acts for no account.
import type { PrismaClient } from "@/generated/prisma/client";
import { SCOPE_HEALTH_READ } from "@/lib/mcp/oauth/config";

/** Grace window kept after expiry before a dead access row is deleted. */
const ACCESS_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;
/** Revoked connections older than this are pruned (kept briefly for audit). */
const CONNECTION_PRUNE_MS = 30 * 24 * 60 * 60 * 1000;

export interface McpTokenCleanupResult {
  accessTokensDeleted: number;
  connectionsDeleted: number;
}

export async function cleanupExpiredMcpTokens(
  prisma: PrismaClient,
): Promise<McpTokenCleanupResult> {
  const now = Date.now();
  const expiryCutoff = new Date(now - ACCESS_TOKEN_GRACE_MS);
  const connectionCutoff = new Date(now - CONNECTION_PRUNE_MS);

  // Connector access tokens only: permissions is exactly `["health:read"]`.
  const access = await prisma.apiToken.deleteMany({
    where: {
      permissions: { equals: [SCOPE_HEALTH_READ] },
      OR: [{ revoked: true }, { expiresAt: { lt: expiryCutoff } }],
    },
  });

  // Prune long-revoked connection anchors. SetNull on the access-token FK means
  // any lingering linked rows simply lose the pointer; the predicate keeps the
  // window generous so an in-flight rotation never races a delete.
  const connections = await prisma.mcpOAuthConnection.deleteMany({
    where: { revokedAt: { lt: connectionCutoff } },
  });

  return {
    accessTokensDeleted: access.count,
    connectionsDeleted: connections.count,
  };
}
