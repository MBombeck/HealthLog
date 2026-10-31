import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { accountLinkedElsewhere } from "@/lib/integrations/oauth-kit/account-link";
import { accountIdFor, fetchProfile } from "./client";
import { getValidToken, runWithGoogleHealthSyncCycle } from "./sync-core";

/** How a cycle's look at a connection without an account id ended. */
export type GoogleHealthAccountIdHeal =
  "healed" | "unreadable" | "linked_elsewhere" | "failed";

/**
 * Fill in the Google account id of a connection that has none.
 *
 * Until v1.46.4 every connection stored the constant `profile` as its id, and
 * migration 0491 cleared it to null. Such a connection syncs normally, but the
 * one-account-per-record check (`accountLinkedElsewhere`) cannot see it, so the
 * same Google account could be connected to a second record. This reads the
 * id with the connection's own token the way the callback does and stores it,
 * which closes that gap without asking anyone to reconnect.
 *
 * Best-effort and never in the sync's way: a failed read leaves the id null
 * for the next cycle, and an id another record already holds is not written
 * (two records would then claim one account; the sync itself carries on, and
 * the next connect on either record meets the check). The write is guarded on
 * the id still being null, so a reconnect landing meanwhile wins.
 */
export async function healGoogleHealthAccountId(
  userId: string,
  accessToken: string,
): Promise<GoogleHealthAccountIdHeal> {
  let outcome: GoogleHealthAccountIdHeal;
  try {
    const profile = await fetchProfile(accessToken);
    const googleUserId = await accountIdFor(profile, accessToken);
    if (!googleUserId) {
      outcome = "unreadable";
    } else if (
      await accountLinkedElsewhere("google-health", googleUserId, userId)
    ) {
      outcome = "linked_elsewhere";
    } else {
      await prisma.googleHealthConnection.updateMany({
        where: { userId, googleUserId: null },
        data: { googleUserId },
      });
      outcome = "healed";
    }
  } catch (err) {
    getEvent()?.addWarning(
      `google-health: account id read failed for ${userId}: ${err}`,
    );
    outcome = "failed";
  }
  annotate({ meta: { "googleHealth.accountId.heal": outcome } });
  return outcome;
}

/**
 * The sync cycle's hook: after a clean cycle, a connection that migration
 * 0491 left without an account id reads it back. A connection that has one
 * is left alone, so the profile is read once.
 */
export async function healUnknownGoogleHealthAccountId(
  userId: string,
  googleUserId: string | null,
): Promise<void> {
  if (googleUserId !== null) return;
  const token = await runWithGoogleHealthSyncCycle(() => getValidToken(userId));
  if (token.result) {
    await healGoogleHealthAccountId(userId, token.result.accessToken);
  }
}
