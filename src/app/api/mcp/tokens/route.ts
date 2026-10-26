/**
 * MCP connector tokens — list + mint.
 *
 * The MCP settings card mints a DEDICATED `health:read`-scoped Bearer here (NOT
 * one of the write scopes the other token surfaces mint — the per-medication
 * ingest pair `medication:ingest` + `medication:<id>:ingest`,
 * `measurements:write`, `workouts:write`, `documents:write` — and NEVER the
 * `["*"]` wildcard). The raw `hlk_` value is shown once. This is the manual /
 * stdio / power-user path; the OAuth bridge (`/api/mcp/oauth/*`) mints the same
 * `health:read` scope automatically for cloud connectors. Both surface here so
 * the user can see and revoke every credential that can read over MCP.
 *
 * `userId` is always narrowed from the session — never a body field. The
 * caller may choose ONE of exactly two shapes via `scope`: `read` →
 * `["health:read"]` (default) or `read_write` → `["health:read",
 * "health:write"]`. The `permissions` array is built explicitly from that
 * closed choice, so this endpoint can never be coerced into minting a
 * wildcard or any other grant (no mass assignment). A `health:write` token is
 * still audience-bound to `/mcp` (the resource-server guard refuses it on
 * every REST write) — it only admits the confirmed in-process write tools.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecentProof } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { prisma } from "@/lib/db";
import { SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE } from "@/lib/mcp/oauth/config";
// The ONLY two scope shapes this endpoint will mint. `read` (default) is the
// least-privilege read token; `read_write` adds `health:write` so the confirmed
// `/mcp` write tools become available. Anything else is rejected by the enum —
// the endpoint can never mint a wildcard or arbitrary grant.
import { createMcpTokenSchema } from "@/lib/validations/mcp";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "mcp.tokens.list" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  // List only manually-minted connector tokens. OAuth access rows
  // (`mcpConnectionId != null`) are transient 60-minute credentials that would
  // flood this list; they are surfaced (and revoked) as connections instead.
  const tokens = await prisma.apiToken.findMany({
    where: {
      userId: user.id,
      permissions: { has: SCOPE_HEALTH_READ },
      mcpConnectionId: null,
    },
    select: {
      id: true,
      name: true,
      permissions: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      revoked: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(tokens);
});

export const POST = apiHandler(async (request: NextRequest) => {
  // A connector token outlives the session that mints it, so the cookie path
  // needs a fresh proof. The shipped app mints these on its token without an
  // elevation and reads a 401 here as a dead session, so the Bearer arm stays
  // on the token until it sends one (see the iOS note).
  const { user } = await requireRecentProof({ bearer: "token" });
  annotate({ action: { name: "mcp.tokens.create" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const parsed = await parseJsonBody(request, createMcpTokenSchema, {
    maxBytes: 16 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  // Build the permission array explicitly from the closed scope choice —
  // never spread, never wildcard. `read` → read-only; `read_write` → read plus
  // the `/mcp`-audience-bound write scope.
  const permissions =
    parsed.data.scope === "read_write"
      ? [SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE]
      : [SCOPE_HEALTH_READ];

  const issued = await issueApiToken({
    userId: user.id,
    name: parsed.data.name,
    permissions,
    expiresInDays: parsed.data.expiresInDays ?? 90,
  });

  await auditLog("mcp.tokens.create", {
    userId: user.id,
    details: { tokenId: issued.tokenId, scope: permissions.join(" ") },
  });

  // Return the raw token ONCE — it can never be retrieved again.
  return apiSuccess(
    { token: issued.token, name: issued.name, expiresAt: issued.expiresAt },
    201,
  );
});
