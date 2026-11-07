/**
 * The backup verdict for one schema model, read off the lists in
 * `./backup-plan.ts`. Kept beside it rather than in it so the plan stays the
 * lists and their reasons, and the one question asked of them lives here.
 */
import {
  AUTH_MODELS_OUT_OF_SCOPE,
  BACKED_UP_MODELS,
  DERIVED_MODELS,
  NOT_IN_BACKUP_MODELS,
} from "./backup-plan";

export type BackupVerdict = "BACKED_UP" | "DERIVED" | "NOT_IN_BACKUP" | "AUTH";

/**
 * The verdict for a model, or `null` when the schema carries a model this file
 * has never ruled on. The guard turns that `null` into a failing test, which
 * is the whole point: a new model gets a decision, not a default.
 */
export function backupVerdict(model: string): BackupVerdict | null {
  if ((BACKED_UP_MODELS as readonly string[]).includes(model)) {
    return "BACKED_UP";
  }
  if (model in DERIVED_MODELS) return "DERIVED";
  if (model in NOT_IN_BACKUP_MODELS) return "NOT_IN_BACKUP";
  if (AUTH_MODELS_OUT_OF_SCOPE.includes(model)) return "AUTH";
  return null;
}
