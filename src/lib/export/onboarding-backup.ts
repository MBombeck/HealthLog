/**
 * The needs-based setup answers, with both backup ends in one file.
 *
 * The builder and the restore live together deliberately, the way
 * `health-score-backup.ts` and `src/lib/cycle/backup.ts` do: a reader asking
 * "is this carried at both ends?" answers it here, and a reader who greps only
 * the restore ROUTE gets a false negative, because the route delegates.
 *
 * Why it is `BACKED_UP` rather than `DERIVED`. Nothing recomputes an answer.
 * The module map the answers produced survives on the `User` row, but the map
 * is not the answers: it says what is switched on, not that the person said
 * they take medication daily and have a visit next month. Losing the row would
 * make "Set up again" open a blank questionnaire for someone who already
 * answered it, and would leave the getting-started checklist ordering itself
 * from nothing. It is one small row and it is the only copy.
 *
 * Nothing here is encrypted, so there is no portable / disaster-recovery split
 * on the values: the three JSON columns hold closed enum vocabularies rather
 * than free text. The only difference between the two purposes is identity — a
 * canonical disaster-recovery payload carries the row id and its timestamps so
 * the row comes back as itself.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import {
  parseOnboardingFirstResult,
  parseOnboardingNeeds,
  parseOnboardingSteps,
  type OnboardingFirstResult,
  type OnboardingNeeds,
  type OnboardingStepState,
} from "@/lib/onboarding/needs";

export interface OnboardingBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** The record's setup state, exactly as it was answered. */
export interface OnboardingBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  /**
   * Read through the same fail-soft parsers the account payload uses rather
   * than copied out of the column raw. A blob written by a release that named
   * an answer this one retired therefore reaches the file as the answers this
   * release can honour, and a restore cannot re-import a value its own
   * validation would refuse.
   */
  needs: OnboardingNeeds;
  steps: OnboardingStepState[];
  firstResult: OnboardingFirstResult | null;
  /**
   * When the module map was derived. Carried, and this is the field that makes
   * the row worth carrying rather than defaulting: a restore that dropped it
   * would let the next confirm re-derive the whole map over whatever the
   * account has changed in Settings since.
   */
  modulesDerivedAt: string | null;
  completedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OnboardingBackupSection {
  onboardingRecord: OnboardingBackupEntry | null;
}

export interface OnboardingBackupCounts {
  onboardingRecords: number;
}

/**
 * Build the setup-answers slice of a user's full backup.
 *
 * Takes the delegate it uses rather than a whole `PrismaClient`, matching the
 * other section builders, so the route's global client and the worker's local
 * one share one read.
 */
export async function buildOnboardingBackupSection(
  prisma: Pick<PrismaClient, "onboardingRecord">,
  userId: string,
  options: OnboardingBackupOptions = {},
): Promise<OnboardingBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const row = await prisma.onboardingRecord.findUnique({ where: { userId } });
  if (!row) return { onboardingRecord: null };

  return {
    onboardingRecord: {
      ...(disasterRecovery
        ? {
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }
        : {}),
      needs: parseOnboardingNeeds(row.needsJson),
      steps: parseOnboardingSteps(row.stepsJson),
      firstResult: parseOnboardingFirstResult(row.firstResultJson),
      modulesDerivedAt: row.modulesDerivedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    },
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countOnboardingBackupSection(
  section: OnboardingBackupSection,
): OnboardingBackupCounts {
  return { onboardingRecords: section.onboardingRecord ? 1 : 0 };
}

/** Counts the setup-state restore wiped, for the audit trail. */
export interface OnboardingRestoreCleared {
  onboardingRecords: number;
}

/**
 * One entry as the parsed FILE carries it.
 *
 * The three answer objects arrive as opaque JSON rather than as the typed
 * shapes the builder wrote, and that is deliberate: the file's Zod schema
 * validates them loosely so a value this release retired cannot refuse a whole
 * account's restore, and the narrowing happens below, through the same
 * fail-soft parsers the account payload reads with. A file hand-edited to name
 * an area that no longer exists therefore restores without it, rather than
 * either failing or writing a value nothing can read.
 */
export interface OnboardingRestoreEntry {
  id?: string;
  needs: unknown;
  steps: unknown;
  firstResult: unknown;
  modulesDerivedAt: string | null;
  completedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: `BackupPayload` defaults it, so every caller
 * already satisfies this, and a caller that stops satisfying it fails to
 * compile instead of passing `undefined` into a branch that does nothing and
 * reports success.
 */
export interface OnboardingRestoreInput {
  onboardingRecord: OnboardingRestoreEntry | null;
}

/**
 * Re-create the account's setup state.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. A file carrying no row leaves the account with none, which is the
 * honest state for a record that never entered the flow — and the delete still
 * runs, because the restore replaces the account's data rather than merging
 * into it.
 */
export async function restoreOnboardingData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: OnboardingRestoreInput,
): Promise<OnboardingRestoreCleared> {
  const cleared = await tx.onboardingRecord.deleteMany({
    where: { userId: ownerId },
  });

  const entry = payload.onboardingRecord;
  if (entry) {
    const firstResult = parseOnboardingFirstResult(entry.firstResult);
    await tx.onboardingRecord.create({
      data: {
        ...(entry.id ? { id: entry.id } : {}),
        userId: ownerId,
        needsJson: parseOnboardingNeeds(
          entry.needs,
        ) as unknown as Prisma.InputJsonValue,
        stepsJson: parseOnboardingSteps(
          entry.steps,
        ) as unknown as Prisma.InputJsonValue,
        firstResultJson:
          firstResult === null
            ? undefined
            : (firstResult as unknown as Prisma.InputJsonValue),
        modulesDerivedAt: entry.modulesDerivedAt
          ? new Date(entry.modulesDerivedAt)
          : null,
        completedAt: entry.completedAt ? new Date(entry.completedAt) : null,
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
        ...(entry.updatedAt ? { updatedAt: new Date(entry.updatedAt) } : {}),
      },
    });
  }

  return { onboardingRecords: cleared.count };
}
