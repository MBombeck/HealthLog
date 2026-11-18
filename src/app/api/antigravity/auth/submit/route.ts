/**
 * POST /api/antigravity/auth/submit
 *
 * Submits the Google OAuth authorization code (or callback URL) from the user
 * to the active `agy acp --login` session stdin. Upon successful token exchange,
 * probes the Antigravity CLI and marks the profile as connected in the database.
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { antigravityAuthSubmitSchema } from "@/lib/validations/antigravity";
import {
  ANTIGRAVITY_LOGIN_FAILURE_MESSAGES,
  submitAntigravityAuthCode,
} from "@/lib/ai/antigravity-auth-session";
import {
  antigravityProfileLocation,
  probeAntigravity,
} from "@/lib/ai/antigravity-client";
import { antigravityReasonOf } from "@/lib/ai/antigravity-errors";
import { setAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: Request) => {
  const { user: caller } = await requireAuth();

  const rl = await checkRateLimit(
    `antigravity-auth-submit:${caller.id}`,
    10,
    60_000,
  );
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const parsed = await parseJsonBody(request, antigravityAuthSubmitSchema, {
    maxBytes: 8192,
    action: "antigravity.auth.submit.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const { code } = parsed.data;

  const failure = await submitAntigravityAuthCode(caller.id, code);
  if (failure) {
    throw new HttpError(400, ANTIGRAVITY_LOGIN_FAILURE_MESSAGES[failure]);
  }

  const user = await prisma.user.findUnique({
    where: { id: caller.id },
    select: { antigravityProfileId: true },
  });

  if (user?.antigravityProfileId) {
    const profile = antigravityProfileLocation(user.antigravityProfileId);
    if (profile) {
      try {
        const probeResult = await probeAntigravity(profile);
        await prisma.user.update({
          where: { id: caller.id },
          data: {
            antigravityConnectionStatus: "connected",
            antigravityConnectedAt: new Date(),
            antigravityCapabilitiesJson: {
              promptCapabilities: probeResult.capabilities,
            },
          },
        });
        setAntigravityCapabilities(caller.id, {
          promptCapabilities: probeResult.capabilities,
        });
      } catch (err) {
        // The reason only. The probe error can carry CLI output.
        console.warn(
          "Post-login Antigravity probe failed:",
          antigravityReasonOf(err),
        );
        await prisma.user.update({
          where: { id: caller.id },
          data: {
            antigravityConnectionStatus: "connected",
            antigravityConnectedAt: new Date(),
          },
        });
      }
    }
  }

  return apiSuccess({ success: true, status: "connected" });
});
