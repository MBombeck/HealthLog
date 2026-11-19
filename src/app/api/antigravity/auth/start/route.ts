/**
 * POST /api/antigravity/auth/start
 *
 * Starts an interactive Google OAuth login session using the Antigravity CLI.
 * Spawns `agy acp --login --gemini-dir <profileDir>` and returns the captured
 * Google OAuth authorization URL so the user can open it in their browser.
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  normalizeAntigravityProfileRoot,
  removeAntigravityProfile,
} from "@/lib/ai/antigravity-profile-cleanup";
import {
  ANTIGRAVITY_LOGIN_FAILURE_MESSAGES,
  AntigravityLoginError,
  cancelAntigravityLogin,
  startAntigravityLogin,
} from "@/lib/ai/antigravity-auth-session";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";

export const dynamic = "force-dynamic";

function generateProfileId(): string {
  return randomBytes(16).toString("hex");
}

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  const rl = await checkRateLimit(
    `antigravity-auth-start:${caller.id}`,
    10,
    60_000,
  );
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const profileRoot = normalizeAntigravityProfileRoot();
  if (!profileRoot) {
    throw new HttpError(
      400,
      "ANTIGRAVITY_PROFILE_ROOT is not configured on this server",
    );
  }

  const existing = await prisma.user.findUnique({
    where: { id: caller.id },
    select: {
      antigravityProfileId: true,
      antigravityConnectionStatus: true,
    },
  });

  // Stop in-flight login sessions and clear memory caches before touch/cleanup
  // so stale background work cannot write into or resurrect credentials.
  cancelAntigravityLogin(caller.id);
  forgetAntigravityCapabilities(caller.id);

  if (existing?.antigravityProfileId) {
    const ok = await removeAntigravityProfile(existing.antigravityProfileId);
    if (!ok) {
      await prisma.user.updateMany({
        where: {
          id: caller.id,
          antigravityProfileId: existing.antigravityProfileId,
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
        "Failed to clean up previous Antigravity profile credentials",
      );
    }
  }

  // Always generate a fresh profile ID for a new login so a retained profile
  // from a previous failed cleanup cannot reconnect by reusing old credentials.
  const profileId = generateProfileId();
  const profileDir = join(profileRoot, profileId);

  // Claim the new profile pointer in DB with CAS before touching disk.
  // This guarantees that any profile directory created on disk has a durable
  // DB reference, preventing orphaned directories without DB pointers.
  const updated = await prisma.user.updateMany({
    where: {
      id: caller.id,
      antigravityProfileId: existing?.antigravityProfileId ?? null,
    },
    data: {
      antigravityProfileId: profileId,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
      antigravityModel: null,
      antigravityCapabilitiesJson: Prisma.DbNull,
    },
  });

  if (updated.count === 0) {
    if (existing?.antigravityProfileId) {
      await prisma.user.updateMany({
        where: {
          id: caller.id,
          antigravityProfileId: existing.antigravityProfileId,
        },
        data: {
          antigravityConnectionStatus: "disconnected",
          antigravityConnectedAt: null,
          antigravityModel: null,
          antigravityCapabilitiesJson: Prisma.DbNull,
        },
      });
    }
    throw new HttpError(409, "Profile was modified concurrently");
  }

  if (!existsSync(profileDir)) {
    try {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error("Failed to create Antigravity profile directory:", error);
      const ok = await removeAntigravityProfile(profileId);
      if (ok) {
        await prisma.user.updateMany({
          where: { id: caller.id, antigravityProfileId: profileId },
          data: {
            antigravityProfileId: null,
            antigravityConnectionStatus: "disconnected",
            antigravityConnectedAt: null,
            antigravityModel: null,
            antigravityCapabilitiesJson: Prisma.DbNull,
          },
        });
      } else {
        await prisma.user.updateMany({
          where: { id: caller.id, antigravityProfileId: profileId },
          data: {
            antigravityConnectionStatus: "error",
            antigravityConnectedAt: null,
            antigravityModel: null,
            antigravityCapabilitiesJson: Prisma.DbNull,
          },
        });
      }
      throw new HttpError(500, "Failed to create profile directory on host");
    }
  }

  const xdgConfigDir = join(profileDir, ".config", "antigravity");
  if (!existsSync(xdgConfigDir)) {
    try {
      mkdirSync(xdgConfigDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error("Failed to create Antigravity XDG directory:", error);
    }
  }

  try {
    const { authUrl } = await startAntigravityLogin(
      caller.id,
      profileId,
      profileDir,
    );
    return apiSuccess({ authUrl, profileId });
  } catch (err) {
    const ok = await removeAntigravityProfile(profileId);
    if (ok) {
      await prisma.user.updateMany({
        where: { id: caller.id, antigravityProfileId: profileId },
        data: {
          antigravityProfileId: null,
          antigravityConnectionStatus: "disconnected",
          antigravityConnectedAt: null,
          antigravityModel: null,
          antigravityCapabilitiesJson: Prisma.DbNull,
        },
      });
    } else {
      await prisma.user.updateMany({
        where: { id: caller.id, antigravityProfileId: profileId },
        data: {
          antigravityConnectionStatus: "error",
          antigravityConnectedAt: null,
          antigravityModel: null,
          antigravityCapabilitiesJson: Prisma.DbNull,
        },
      });
    }
    // The message is fixed. The CLI output that caused it never reaches the client.
    const failure =
      err instanceof AntigravityLoginError ? err.failure : "start_failed";
    throw new HttpError(500, ANTIGRAVITY_LOGIN_FAILURE_MESSAGES[failure]);
  }
});
