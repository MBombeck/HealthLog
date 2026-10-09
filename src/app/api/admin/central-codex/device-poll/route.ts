import { NextRequest } from "next/server";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { pollDeviceCode, encryptAdminCodexCreds } from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp, apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

/**
 * Operator-shared central Codex — device-code poll (admin only).
 *
 * Cookie-only `requireAdmin()`. The client polls this every `intervalSeconds`;
 * on the operator finishing the approval on chatgpt.com we exchange the code,
 * then persist the three token pieces (access + refresh + `ChatGPT-Account-ID`),
 * each AES-256-GCM encrypted, on the `AppSettings` singleton. The device cookie
 * is deleted on success. Tokens are never logged and never leave the server.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const rl = await checkRateLimit(
    `central-codex-device-poll:${user.id}`,
    60,
    60_000,
  );
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const cookieStore = await cookies();
  const cookie = cookieStore.get("central_codex_device")?.value;
  if (!cookie) {
    return apiError("No device-auth attempt in progress", 400);
  }

  let deviceAuthId: string;
  let userCode: string;
  try {
    const decoded = JSON.parse(decrypt(cookie)) as {
      deviceAuthId: string;
      userCode: string;
    };
    deviceAuthId = decoded.deviceAuthId;
    userCode = decoded.userCode;
  } catch {
    cookieStore.delete("central_codex_device");
    return apiError("Invalid device-auth state. Restart the flow", 400);
  }

  let result;
  try {
    result = await pollDeviceCode({ deviceAuthId, userCode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    annotate({ meta: { central_codex_device_poll_error: message } });
    return apiError(
      "Central Codex device-poll failed. Please restart the flow",
      502,
    );
  }

  if (result.status === "pending") {
    annotate({
      action: { name: "admin.central-codex.device.poll" },
      meta: { pending: true },
    });
    return apiSuccess({ status: "pending" });
  }

  const enc = encryptAdminCodexCreds(result.creds);
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      adminCodexAccessTokenEncrypted: enc.accessEncrypted,
      adminCodexRefreshTokenEncrypted: enc.refreshEncrypted,
      adminCodexAccountIdEncrypted: enc.accountIdEncrypted,
      adminCodexTokenExpiresAt: enc.expiresAt,
      adminCodexConnectedAt: new Date(),
      adminCodexConnectionStatus: "connected",
    },
    create: {
      id: "singleton",
      adminCodexAccessTokenEncrypted: enc.accessEncrypted,
      adminCodexRefreshTokenEncrypted: enc.refreshEncrypted,
      adminCodexAccountIdEncrypted: enc.accountIdEncrypted,
      adminCodexTokenExpiresAt: enc.expiresAt,
      adminCodexConnectedAt: new Date(),
      adminCodexConnectionStatus: "connected",
    },
  });

  cookieStore.delete("central_codex_device");

  await auditLog("admin.central-codex.connected", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { method: "device_code" },
  });
  annotate({
    action: { name: "admin.central-codex.device.poll" },
    meta: { connected: true },
  });

  return apiSuccess({ status: "connected" });
});
