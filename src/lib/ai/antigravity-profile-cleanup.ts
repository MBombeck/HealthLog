/**
 * Removes the Antigravity login from the server. The login is the CLI's OAuth
 * token, which sits in the user's profile folder under
 * ANTIGRAVITY_PROFILE_ROOT. Disconnecting, wiping the data and deleting the
 * account all call this, so the token does not outlive the link to it.
 */
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { envValue } from "@/lib/env";

/** Profile IDs the app generates: 32 hex characters. Anything else is not removed. */
const PROFILE_ID_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Delete the profile folders for these IDs. Missing folders and IDs that are
 * not in the expected form are skipped. A folder that cannot be removed is
 * logged by ID, and the rest still go.
 *
 * Returns how many folders were removed.
 */
export async function removeAntigravityProfiles(
  profileIds: ReadonlyArray<string | null | undefined>,
): Promise<number> {
  const root = envValue("ANTIGRAVITY_PROFILE_ROOT");
  if (!root || !isAbsolute(root)) return 0;

  let removed = 0;
  for (const id of new Set(profileIds)) {
    if (!id || !PROFILE_ID_PATTERN.test(id)) continue;
    try {
      await rm(join(root, id), { recursive: true, force: true });
      removed += 1;
    } catch {
      console.error(
        `Antigravity profile folder ${id} could not be removed. Delete it on the host.`,
      );
    }
  }
  return removed;
}
