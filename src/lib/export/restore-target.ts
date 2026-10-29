/**
 * Which account the copy of an erased account may be restored into.
 *
 * A restore replaces: every row of the account in a section the copy carries
 * is deleted and the copy's rows are written in their place
 * (`docs/ops/backup-restore.md`). There is no merge. So putting the record of
 * an account that no longer exists into another account is only safe when
 * that account holds none of those rows, and the check is exactly that: a row
 * of any model the backup carries ({@link BACKED_UP_MODELS}) under the
 * account refuses it. Everything a restore leaves alone (credentials,
 * sessions, devices, grants) does not count, and neither does the setup state
 * signing up leaves behind ({@link RESTORE_TARGET_SETUP_MODELS}): the person
 * did not enter it as a record, and the restore replaces it with the copy's.
 * A reading or a medication entered during setup is a record like any other
 * and still refuses, because the restore would delete it.
 *
 * The other two refusals keep the account rules intact. A managed profile is
 * its Guardians' record, which an admin does not write into (the users list
 * offers no admin deletion on one for the same reason). An account pending
 * deletion is locked and will be erased, with whatever was restored into it.
 * Neither the restore nor this check touches the role, so the last-admin rule
 * is not in play.
 */
import type { Prisma } from "@/generated/prisma/client";
import { BACKED_UP_MODELS } from "@/lib/export/backup-plan";

/**
 * The backed-up models with no owner column of their own, each with the owned
 * model it hangs off through a required cascade. A row of one cannot exist
 * without a row of its parent, so checking the parent checks it.
 * `restore-target-models.test.ts` holds this list to the schema.
 */
export const BACKED_UP_CHILD_MODELS: Readonly<Record<string, string>> = {
  MedicationSchedule: "Medication",
  MedicationScheduleRevision: "Medication",
  MedicationDoseChange: "Medication",
  MedicationEfficacyTarget: "Medication",
  MedicationInventoryEvent: "Medication",
  MedicationCategoryAssignment: "Medication",
  ReminderPhaseConfig: "Medication",
  MoodEntryTagLink: "MoodEntry",
  IllnessSymptomLink: "IllnessDayLog",
  CycleSymptomLink: "CycleDayLog",
  WorkoutRoute: "Workout",
  WorkoutSamples: "Workout",
  CoachMessage: "CoachConversation",
  CoachConversationDocument: "CoachConversation",
};

/** Every backed-up model that carries `userId`, in the plan's order. */
export const RESTORE_TARGET_OWNED_MODELS: readonly string[] =
  BACKED_UP_MODELS.filter((model) => !(model in BACKED_UP_CHILD_MODELS));

/**
 * The backed-up models an account holds a row of after signing up and going
 * through setup, before anything has been recorded, each with the writer.
 * One row per account, settings-shaped, and deleted and re-created from the
 * copy by every restore, so the copy's state replaces it and nothing the
 * person entered is lost. Without this list the account of someone who has
 * signed up again was always refused, which is the case the target exists
 * for. `restore-target-models.test.ts` holds each to that shape.
 */
export const RESTORE_TARGET_SETUP_MODELS: Readonly<Record<string, string>> = {
  // `PATCH /api/onboarding/answers` and `POST /api/onboarding/complete`.
  OnboardingRecord: "the setup answers",
  // Created by the setup confirm when the cycle area is chosen, and by the
  // first read of the cycle settings.
  CycleProfile: "the cycle settings",
};

/** The models whose rows make an account a refused restore target. */
const RESTORE_TARGET_CHECKED_MODELS: readonly string[] =
  RESTORE_TARGET_OWNED_MODELS.filter(
    (model) => !(model in RESTORE_TARGET_SETUP_MODELS),
  );

interface OwnedDelegate {
  findFirst(args: {
    where: { userId: string };
    select: { userId: true };
  }): Promise<unknown>;
}

function ownedDelegate(db: object, model: string): OwnedDelegate {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (db as Record<string, OwnedDelegate | undefined>)[key];
  if (!delegate || typeof delegate.findFirst !== "function") {
    // Never narrower than the plan: a model this cannot read is a model it
    // would otherwise call empty.
    throw new Error(`No Prisma delegate for backed-up model "${model}"`);
  }
  return delegate;
}

/**
 * The backed-up models under which `userId` holds at least one row, setup
 * state left out.
 */
export async function modelsHoldingRecords(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<string[]> {
  const held: string[] = [];
  for (const model of RESTORE_TARGET_CHECKED_MODELS) {
    const row = await ownedDelegate(db, model).findFirst({
      where: { userId },
      select: { userId: true },
    });
    if (row) held.push(model);
  }
  return held;
}

export type RestoreTargetRefusal =
  "not_found" | "managed_profile" | "pending_deletion" | "holds_records";

export type RestoreTargetVerdict =
  | { ok: true; target: { id: string; username: string } }
  | {
      ok: false;
      reason: RestoreTargetRefusal;
      target: { id: string; username: string } | null;
      /** For `holds_records`: the models that hold rows, in plan order. */
      models: string[];
    };

/** Whether the copy of an erased account may go into `userId`. */
export async function checkRestoreTarget(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<RestoreTargetVerdict> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      managedProfileAt: true,
      deletionRequestedAt: true,
    },
  });
  if (!row) {
    return { ok: false, reason: "not_found", target: null, models: [] };
  }
  const target = { id: row.id, username: row.username };
  if (row.managedProfileAt) {
    return { ok: false, reason: "managed_profile", target, models: [] };
  }
  if (row.deletionRequestedAt) {
    return { ok: false, reason: "pending_deletion", target, models: [] };
  }
  const models = await modelsHoldingRecords(db, row.id);
  if (models.length > 0) {
    return { ok: false, reason: "holds_records", target, models };
  }
  return { ok: true, target };
}

/** The wire code of each refusal. */
export const BACKUP_TARGET_REFUSAL_CODES = {
  not_found: "backup.target.not_found",
  managed_profile: "backup.target.managed_profile",
  pending_deletion: "backup.target.pending_deletion",
  holds_records: "backup.target.holds_records",
} as const satisfies Record<RestoreTargetRefusal, string>;

/** The status and stable code each refusal answers with. */
export const RESTORE_TARGET_REFUSALS: Readonly<
  Record<
    RestoreTargetRefusal,
    { status: number; code: string; message: string }
  >
> = {
  not_found: {
    status: 404,
    code: BACKUP_TARGET_REFUSAL_CODES.not_found,
    message: "The chosen account does not exist.",
  },
  managed_profile: {
    status: 409,
    code: BACKUP_TARGET_REFUSAL_CODES.managed_profile,
    message:
      "The chosen account is a managed profile. Its Guardians run it, so a copy cannot be restored into it.",
  },
  pending_deletion: {
    status: 409,
    code: BACKUP_TARGET_REFUSAL_CODES.pending_deletion,
    message:
      "The chosen account is pending deletion. Undo the deletion first, or choose another account.",
  },
  holds_records: {
    status: 409,
    code: BACKUP_TARGET_REFUSAL_CODES.holds_records,
    message:
      "The chosen account already holds records, and a restore replaces them rather than adding to them. Choose an empty account or create a new one.",
  },
};
