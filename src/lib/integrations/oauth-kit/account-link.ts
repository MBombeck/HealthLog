/**
 * One provider account, one HealthLog record.
 *
 * A guardian finishing a connect for a managed profile is signed in to the
 * provider in the same browser, so the consent screen can hand back the
 * guardian's own provider account. Stored on the profile, that account's data
 * would land on both records, its webhooks would route to whichever row a
 * lookup found first, and a disconnect on one record would unsubscribe the
 * other's notifications. Every callback therefore refuses a provider account
 * that another record already holds (`already_linked`), and a disconnect only
 * touches provider-side state (webhook subscriptions, app authorisation) when
 * no other record holds the same account.
 *
 * Where the provider's account id is not stored there is nothing to compare,
 * and the check passes: an unknown id is not evidence of a second holder.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export type LinkedAccountProvider =
  "withings" | "whoop" | "google-health" | "strava" | "polar" | "oura";

/** The callback reason a refused second holder redirects with. */
export const ALREADY_LINKED_REASON = "already_linked";

/**
 * The records other than `userId` that hold the provider account `accountId`.
 */
export async function otherHoldersOfAccount(
  provider: LinkedAccountProvider,
  accountId: string,
  userId: string,
): Promise<string[]> {
  const notMe = { not: userId };
  switch (provider) {
    case "withings":
      return (
        await prisma.withingsConnection.findMany({
          where: { withingsUserId: accountId, userId: notMe },
          select: { userId: true },
        })
      ).map((r) => r.userId);
    case "whoop":
      return (
        await prisma.whoopConnection.findMany({
          where: { whoopUserId: accountId, userId: notMe },
          select: { userId: true },
        })
      ).map((r) => r.userId);
    case "google-health":
      return (
        await prisma.googleHealthConnection.findMany({
          where: { googleUserId: accountId, userId: notMe },
          select: { userId: true },
        })
      ).map((r) => r.userId);
    case "strava":
      return (
        await prisma.user.findMany({
          where: { stravaAthleteId: accountId, id: notMe },
          select: { id: true },
        })
      ).map((r) => r.id);
    case "oura":
      return (
        await prisma.user.findMany({
          where: { ouraUserId: accountId, id: notMe },
          select: { id: true },
        })
      ).map((r) => r.id);
    case "polar": {
      // The member id is sealed with a random nonce, so it cannot be matched
      // in SQL; the connected rows are few, and each is opened here.
      const rows = await prisma.user.findMany({
        where: { polarUserIdEncrypted: { not: null }, id: notMe },
        select: { id: true, polarUserIdEncrypted: true },
      });
      const holders: string[] = [];
      for (const row of rows) {
        try {
          if (decrypt(row.polarUserIdEncrypted!) === accountId) {
            holders.push(row.id);
          }
        } catch {
          // An unreadable row proves nothing either way.
        }
      }
      return holders;
    }
  }
}

/** Does a record other than `userId` hold the provider account `accountId`? */
export async function accountLinkedElsewhere(
  provider: LinkedAccountProvider,
  accountId: string | null | undefined,
  userId: string,
): Promise<boolean> {
  if (!accountId) return false;
  return (await otherHoldersOfAccount(provider, accountId, userId)).length > 0;
}
