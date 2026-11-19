/**
 * POST /api/antigravity/disconnect
 *
 * Disconnects the Antigravity CLI provider for the authenticated user:
 * 1. Deletes the profile folder, which holds the CLI's OAuth login
 * 2. Clears the profile ID, the connection status and the stored capabilities
 *
 * The CLI has no logout command. Deleting the folder is the only way to end the
 * login from HealthLog, so it is deleted rather than left on disk. The folder
 * is deleted successfully before clearing the DB pointer to retain a retry path
 * on failures and avoid clobbering a concurrent changed pointer.
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import { cancelAntigravityLogin } from "@/lib/ai/antigravity-auth-session";
import { removeAntigravityProfile } from "@/lib/ai/antigravity-profile-cleanup";

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

  // Cancel any active login flow before deleting the profile folder, so an
  // in-flight login waiting for code cannot attach after or during cleanup.
  cancelAntigravityLogin(userId);
  // Drop the in-process capabilities cache immediately, mirroring forgetCodexSignIn.
  forgetAntigravityCapabilities(userId);

  const profileId = existing?.antigravityProfileId ?? null;
  if (profileId) {
    const ok = await removeAntigravityProfile(profileId);
    if (!ok) {
      await prisma.user.updateMany({
        where: {
          id: userId,
          antigravityProfileId: profileId,
        },
        data: {
          antigravityModel: null,
          antigravityConnectionStatus: "error",
          antigravityConnectedAt: null,
          antigravityCapabilitiesJson: Prisma.DbNull,
        },
      });
      throw new HttpError(
        500,
        "Failed to remove Antigravity profile directory",
      );
    }
  }

  // Clear DB pointer only after directory is deleted successfully.
  // Using updateMany with matching profileId prevents clobbering concurrent changes.
  await prisma.user.updateMany({
    where: {
      id: userId,
      antigravityProfileId: profileId,
    },
    data: {
      antigravityProfileId: null,
      antigravityModel: null,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
      antigravityCapabilitiesJson: Prisma.DbNull,
    },
  });

  const response: AntigravityDisconnectResponse = {
    success: true,
    loginRemoved: true,
  };

  return apiSuccess(response);
});
