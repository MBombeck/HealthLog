/**
 * Revoke an MCP connector token. Only the owning user can revoke; the scope
 * filter keeps this endpoint to `health:read` tokens so it can never revoke a
 * differently-scoped credential by id alone.
 */
import { sendSecurityAlert } from "@/lib/auth/security-alert";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { prisma } from "@/lib/db";
import { SCOPE_HEALTH_READ } from "@/lib/mcp/oauth/config";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();
    annotate({ action: { name: "mcp.tokens.revoke" } });

    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    const token = await prisma.apiToken.findUnique({ where: { id } });

    if (
      !token ||
      token.userId !== user.id ||
      !token.permissions.includes(SCOPE_HEALTH_READ)
    ) {
      return apiError("Token not found", 404);
    }

    await prisma.apiToken.update({ where: { id }, data: { revoked: true } });
    await auditLog("mcp.tokens.revoke", {
      userId: user.id,
      details: { tokenId: id },
    });
    void sendSecurityAlert(user.id, "token_revoked");

    return apiSuccess({ revoked: true });
  },
);
