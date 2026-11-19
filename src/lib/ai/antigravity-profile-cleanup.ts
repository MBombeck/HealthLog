/**
 * Removes the Antigravity login from the server. The login is the CLI's OAuth
 * token, which sits in the user's profile folder under
 * ANTIGRAVITY_PROFILE_ROOT. Disconnecting, wiping the data and deleting the
 * account all call this, so the token does not outlive the link to it.
 */
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { envValue } from "@/lib/env";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { cancelAntigravityLogin } from "@/lib/ai/antigravity-auth-session";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";

/**
 * Valid profile ID pattern: accepts current 32-hex format as well as safe legacy
 * alphanumeric identifiers (1-64 chars, containing [A-Za-z0-9_-] with no path traversal).
 */
export const ANTIGRAVITY_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate that profileId is in the expected 32-hex or safe legacy format. */
export function isValidAntigravityProfileId(
  profileId: unknown,
): profileId is string {
  return (
    typeof profileId === "string" &&
    ANTIGRAVITY_PROFILE_ID_PATTERN.test(profileId)
  );
}

/**
 * Returns the normalized, absolute Antigravity profile root path, or null if unset/invalid.
 */
export function normalizeAntigravityProfileRoot(
  root?: string | null,
): string | null {
  const raw =
    root !== undefined
      ? root
      : (envValue("ANTIGRAVITY_PROFILE_ROOT") ??
        process.env.ANTIGRAVITY_PROFILE_ROOT);
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return resolve(trimmed);
}

/**
 * Remove one profile folder for `profileId`.
 * Returns true if the folder was removed, or did not exist under a valid root.
 * Returns false if the folder could not be removed due to an error, if the
 * profile root is unset/invalid while a profile ID was provided, or if the
 * profile ID itself is invalid.
 */
export async function removeAntigravityProfile(
  profileId: string | null | undefined,
): Promise<boolean> {
  if (!profileId) return true;
  if (!isValidAntigravityProfileId(profileId)) {
    console.warn(
      `Invalid Antigravity profile ID format: "${profileId}"; cannot safely remove directory`,
    );
    return false;
  }
  const root = normalizeAntigravityProfileRoot();
  if (!root) {
    console.warn(
      `Antigravity profile root is unset or not absolute; cannot verify or remove profile folder for "${profileId}". Set a valid absolute ANTIGRAVITY_PROFILE_ROOT on the host.`,
    );
    return false;
  }

  try {
    await rm(join(root, profileId), { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(
      `Antigravity profile folder ${profileId} could not be removed. Delete it on the host.`,
      error,
    );
    return false;
  }
}

/**
 * Delete the profile folders for these IDs. Missing folders are skipped idempotently.
 * Returns how many folders were successfully removed.
 */
export async function removeAntigravityProfiles(
  profileIds: ReadonlyArray<string | null | undefined>,
): Promise<number> {
  const root = normalizeAntigravityProfileRoot();
  if (!root) {
    console.warn(
      `Antigravity profile root is unset or not absolute; cannot remove profile folder(s)`,
    );
    return 0;
  }

  const validIds = new Set(
    profileIds.filter((id): id is string => isValidAntigravityProfileId(id)),
  );
  if (validIds.size === 0) return 0;

  let removed = 0;
  for (const id of validIds) {
    const ok = await removeAntigravityProfile(id);
    if (ok) removed += 1;
  }
  return removed;
}

/**
 * Clean up Antigravity profile after account locking commits.
 * If removal succeeds, clear DB pointer.
 * If removal fails, preserve profile ID in DB for retry and disable profile use.
 */
export async function cleanAntigravityProfileOnLock(
  userId: string,
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { antigravityProfileId: true },
    });
    const profileId = user?.antigravityProfileId;
    if (!profileId) return true;

    cancelAntigravityLogin(userId);
    forgetAntigravityCapabilities(userId);

    const ok = await removeAntigravityProfile(profileId);
    if (ok) {
      await prisma.user.updateMany({
        where: { id: userId, antigravityProfileId: profileId },
        data: {
          antigravityProfileId: null,
          antigravityModel: null,
          antigravityConnectionStatus: "disconnected",
          antigravityConnectedAt: null,
          antigravityCapabilitiesJson: Prisma.DbNull,
        },
      });
      return true;
    }

    // On cleanup failure: disable profile use while preserving antigravityProfileId for durable retry
    await prisma.user.updateMany({
      where: { id: userId, antigravityProfileId: profileId },
      data: {
        antigravityModel: null,
        antigravityConnectionStatus: "error",
        antigravityConnectedAt: null,
        antigravityCapabilitiesJson: Prisma.DbNull,
      },
    });
    console.warn(
      `Failed to clean Antigravity profile ${profileId} on account lock for user ${userId}; preserving ID for retry at purge time`,
    );
    return false;
  } catch (error) {
    console.error(
      `Error cleaning Antigravity profile on lock for user ${userId}:`,
      error,
    );
    return false;
  }
}
