/**
 * POST /api/antigravity/disconnect
 *
 * Disconnects the Antigravity CLI provider for the authenticated user:
 * 1. Clears the profile ID, the connection status and the stored capabilities
 * 2. Deletes the profile folder, which holds the CLI's OAuth login
 *
 * The CLI has no logout command. Deleting the folder is the only way to end the
 * login from HealthLog, so it is deleted rather than left on disk.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import { cancelAntigravityLogin } from "@/lib/ai/antigravity-auth-session";
import { removeAntigravityProfiles } from "@/lib/ai/antigravity-profile-cleanup";

export interface AntigravityDisconnectResponse {
  /** Whether the disconnect was successful */
  success: boolean;
  /** Whether the login was removed from the server */
  loginRemoved: boolean;
}

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();
  const userId = caller.id;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { antigravityProfileId: true },
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      antigravityProfileId: null,
      antigravityModel: null,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
      antigravityCapabilitiesJson: Prisma.DbNull,
    },
  });

  // A login still waiting for its code belongs to the link being removed.
  cancelAntigravityLogin(userId);
  // Drop the in-process capabilities cache immediately, mirroring forgetCodexSignIn.
  forgetAntigravityCapabilities(userId);

  const removed = await removeAntigravityProfiles([
    existing?.antigravityProfileId,
  ]);

  const response: AntigravityDisconnectResponse = {
    success: true,
    loginRemoved: removed > 0 || !existing?.antigravityProfileId,
  };

  return apiSuccess(response);
});
