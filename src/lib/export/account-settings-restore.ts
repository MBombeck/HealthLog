/**
 * The restore half of the account-settings domain: write what
 * `admitAccountSettings` admits onto the account row, inside the restore's
 * transaction.
 */
import type { Prisma } from "@/generated/prisma/client";
import {
  admitAccountSettings,
  type AccountSettingsBackupEntry,
} from "@/lib/export/account-settings-backup";

/** The slice of a parsed backup this restore consumes. */
export interface AccountSettingsRestoreInput {
  /** Absent from every file written before the section existed. */
  accountSettings?: AccountSettingsBackupEntry | null;
}

/** Where the copy being restored came from. */
export interface AccountSettingsRestoreSource {
  /**
   * The copy was uploaded into this account from a file another account
   * wrote (`backup-upload-type.ts`), so its settings are that author's word.
   */
  retargeted: boolean;
}

export interface AccountSettingsRestoreResult {
  /** How many setting columns were written. */
  applied: number;
  /** What the file carried and the account did not take, by column. */
  refused: string[];
  /** Whether a unit preference changed, so stored texts quote old units. */
  unitsChanged: boolean;
}

/**
 * Put the account's settings back, inside the caller's transaction.
 *
 * Only the columns `admitAccountSettings` admitted, and only setting columns
 * can be admitted. Identity, credentials and the host's own bookkeeping on
 * the row are never in the write, so they stay exactly as the receiving
 * account has them. A file without the section leaves the row untouched,
 * which is how every backup written before the section existed restores.
 *
 * An admin's own copy is the operator's configuration and is read under the
 * operator's AI endpoint policy. A retargeted copy never is: the admin chose
 * where it went, but the file's author wrote its settings.
 */
export async function restoreAccountSettings(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: AccountSettingsRestoreInput,
  source: AccountSettingsRestoreSource,
): Promise<AccountSettingsRestoreResult> {
  const entry = payload.accountSettings;
  if (!entry) return { applied: 0, refused: [], unitsChanged: false };

  const current = await tx.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: {
      role: true,
      aiProvider: true,
      unitPreference: true,
      glucoseUnit: true,
    },
  });
  const { data, refused } = admitAccountSettings(
    entry,
    { operatorTrusted: !source.retargeted && current.role === "ADMIN" },
    current.aiProvider,
  );

  const columns = Object.keys(data);
  if (columns.length > 0) {
    await tx.user.update({
      where: { id: ownerId },
      data: data as Prisma.UserUpdateInput,
    });
  }

  return {
    applied: columns.length,
    refused,
    unitsChanged:
      ("unitPreference" in data &&
        data.unitPreference !== current.unitPreference) ||
      ("glucoseUnit" in data && data.glucoseUnit !== current.glucoseUnit),
  };
}
