/**
 * Revoke an MCP OAuth connection (H2).
 *
 * Revoking a connection terminates its whole refresh chain: it stamps
 * `revokedAt` (so every future refresh fails) and revokes every access token
 * the connection ever issued. Ownership is enforced inside
 * `revokeConnectionForUser`, so a connection id alone cannot revoke another
 * user's connection.
 */
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { revokeConnectionForUser } from "@/lib/mcp/oauth/connections";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireSelfAuth();
    annotate({ action: { name: "mcp.connections.revoke" } });

    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    const revoked = await revokeConnectionForUser(user.id, id);
    if (!revoked) {
      return apiError("Connection not found", 404);
    }

    await auditLog("mcp.connections.revoke", {
      userId: user.id,
      details: { connectionId: id },
    });

    return apiSuccess({ revoked: true });
  },
);
