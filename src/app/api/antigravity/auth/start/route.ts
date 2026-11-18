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
import { envValue } from "@/lib/env";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  ANTIGRAVITY_LOGIN_FAILURE_MESSAGES,
  AntigravityLoginError,
  startAntigravityLogin,
} from "@/lib/ai/antigravity-auth-session";

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

  const profileRoot = envValue("ANTIGRAVITY_PROFILE_ROOT") ?? null;
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

  const profileId = existing?.antigravityProfileId ?? generateProfileId();
  const profileDir = join(profileRoot, profileId);

  if (!existsSync(profileDir)) {
    try {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error("Failed to create Antigravity profile directory:", error);
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

  if (existing?.antigravityProfileId !== profileId) {
    await prisma.user.update({
      where: { id: caller.id },
      data: {
        antigravityProfileId: profileId,
        ...(existing?.antigravityConnectionStatus !== "connected"
          ? {
              antigravityConnectionStatus: "disconnected",
              antigravityConnectedAt: null,
            }
          : {}),
      },
    });
  }

  try {
    const { authUrl } = await startAntigravityLogin(
      caller.id,
      profileId,
      profileDir,
    );
    return apiSuccess({ authUrl, profileId });
  } catch (err) {
    // The message is fixed. The CLI output that caused it never reaches the client.
    const failure =
      err instanceof AntigravityLoginError ? err.failure : "start_failed";
    throw new HttpError(500, ANTIGRAVITY_LOGIN_FAILURE_MESSAGES[failure]);
  }
});
