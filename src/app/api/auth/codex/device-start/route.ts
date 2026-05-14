import { NextRequest } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestDeviceCode } from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { apiSuccess } from "@/lib/api-response";

/**
 * v1.4.7.1: Device-code flow for ChatGPT-OAuth.
 *
 * The previous redirect-based authorization-code flow fails on hosted
 * deployments because OpenAI's Hydra only allow-lists localhost
 * callbacks for the public Codex CLI client ID. Device-code is the
 * documented alternative — the user goes to chatgpt.com on any device,
 * types a short code, approves there. No redirect to our domain.
 *
 * This endpoint kicks the flow off: it asks Hydra for a `user_code` /
 * `device_auth_id` pair and returns the user-facing pieces. The
 * `device_auth_id` is the secret the poll endpoint needs and is
 * persisted server-side via an encrypted httpOnly cookie scoped to a
 * 15-minute lifetime — the same window Hydra gives the code.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`codex-device-start:${user.id}`, 5, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const code = await requestDeviceCode();

  const cookieStore = await cookies();
  cookieStore.set(
    "codex_device",
    encrypt(
      JSON.stringify({
        deviceAuthId: code.deviceAuthId,
        userCode: code.userCode,
      }),
    ),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60,
    },
  );

  annotate({
    action: { name: "codex.device.start" },
    meta: { interval_seconds: code.intervalSeconds },
  });

  return apiSuccess({
    userCode: code.userCode,
    verificationUrl: code.verificationUrl,
    intervalSeconds: code.intervalSeconds,
  });
});
