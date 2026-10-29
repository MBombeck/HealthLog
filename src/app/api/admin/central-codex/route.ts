import { NextRequest } from "next/server";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  codexCredentialKey,
  forgetCodexSignIn,
} from "@/lib/ai/codex-slug-cache";

/**
 * Operator-shared central Codex (ChatGPT subscription) — status + disconnect.
 *
 *   GET    /api/admin/central-codex  — connection status + connected-at.
 *   DELETE /api/admin/central-codex  — clear the shared credential.
 *
 * Cookie-only `requireAdmin()`: a Bearer token, even with `["*"]` scope, can
 * never reach this. The encrypted token columns are NEVER returned — only the
 * status string and the connected-at timestamp leave the server.
 */
export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.central-codex.get" } });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      adminCodexConnectionStatus: true,
      adminCodexConnectedAt: true,
    },
  });

  return apiSuccess({
    status: settings?.adminCodexConnectionStatus ?? "disconnected",
    connectedAt: settings?.adminCodexConnectedAt ?? null,
  });
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const rl = await checkRateLimit("admin-central-codex-disconnect", 5, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      adminCodexAccessTokenEncrypted: null,
      adminCodexRefreshTokenEncrypted: null,
      adminCodexAccountIdEncrypted: null,
      adminCodexTokenExpiresAt: null,
      adminCodexConnectedAt: null,
      adminCodexConnectionStatus: "disconnected",
    },
    create: { id: "singleton", adminCodexConnectionStatus: "disconnected" },
  });

  forgetCodexSignIn(codexCredentialKey.central);

  await auditLog("admin.central-codex.disconnected", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });
  annotate({ action: { name: "admin.central-codex.disconnect" } });

  return apiSuccess({ disconnected: true });
});
