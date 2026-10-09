import { NextRequest } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { pollDeviceCode, encryptCodexCreds } from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp, apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

/**
 * v1.4.7.1: Device-code flow polling endpoint.
 *
 * The client polls this every `intervalSeconds` (returned from
 * `device-start`). While the user has not approved on chatgpt.com,
 * we return `status: "pending"` and the client retries. Once Hydra
 * issues an authorization code we exchange it server-side, swap the
 * id_token for an OpenAI API key (RFC 8693), and persist both the
 * key and the OAuth refresh token encrypted on the user record.
 *
 * The cookie that holds the `device_auth_id` + `user_code` lives 15
 * minutes — same window Hydra gives the device code. After success
 * we delete the cookie immediately so a refresh of the page does not
 * try to re-poll a stale device id.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`codex-device-poll:${user.id}`, 60, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const cookieStore = await cookies();
  const cookie = cookieStore.get("codex_device")?.value;
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
    cookieStore.delete("codex_device");
    return apiError("Invalid device-auth state. Restart the flow", 400);
  }

  let result;
  try {
    result = await pollDeviceCode({ deviceAuthId, userCode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    annotate({ meta: { codex_device_poll_error: message } });
    return apiError("Codex device-poll failed. Please restart the flow", 502);
  }

  if (result.status === "pending") {
    annotate({
      action: { name: "codex.device.poll" },
      meta: { pending: true },
    });
    return apiSuccess({ status: "pending" });
  }

  // status === "connected" → persist the full credential blob
  // (access token + chatgpt_account_id + refresh token), encrypted.
  // The account id is mandatory for the `ChatGPT-Account-ID` header
  // on every Codex backend request.
  const enc = encryptCodexCreds(result.creds);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      codexAccessTokenEncrypted: enc.accessEncrypted,
      codexRefreshTokenEncrypted: enc.refreshEncrypted,
      codexTokenExpiresAt: result.creds.expiresAt,
      codexConnectedAt: new Date(),
      codexConnectionStatus: "connected",
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsCachedLocale: null,
    },
  });

  cookieStore.delete("codex_device");

  await auditLog("codex.oauth.connected", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { method: "device_code" },
  });
  annotate({
    action: { name: "codex.device.poll" },
    meta: { connected: true },
  });

  return apiSuccess({ status: "connected" });
});
