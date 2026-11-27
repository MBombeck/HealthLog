/**
 * MCP OAuth connections — list (H2).
 *
 * A connection is the revocable unit for a remote connector authorized through
 * the OAuth bridge (Claude.ai / ChatGPT / a third-party client). Unlike the
 * transient 60-minute access-token rows, the connection persists across
 * refreshes, so revoking it terminates the whole refresh chain. `userId` is
 * always narrowed from the session — never a body field.
 */
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { listConnectionsForUser } from "@/lib/mcp/oauth/connections";

export const GET = apiHandler(async () => {
  const { user } = await requireSelfAuth();
  annotate({ action: { name: "mcp.connections.list" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const connections = await listConnectionsForUser(user.id);
  return apiSuccess(connections);
});
