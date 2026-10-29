/**
 * Where an uploaded backup goes when the account it names no longer exists.
 *
 * The upload's body is the file itself, so the choice rides in the query:
 *
 *   - `into=existing&userId=<id>&confirm=<username>`: an existing account,
 *     confirmed by typing its username, since the restore writes into it;
 *   - `into=new&username=<name>`: a new account created for the copy.
 *
 * No query at all is the upload as it always was: the copy goes to the
 * account the file names, which has to exist.
 */
import { z } from "zod/v4";

import { accountUsernameSchema } from "@/lib/validations/auth";

/** The upload's refusal when the file's own account is not on this server. */
export const BACKUP_OWNER_MISSING_CODE = "backup.owner.missing";
/** The upload's refusal when a target was chosen for a file whose account exists. */
export const BACKUP_OWNER_EXISTS_CODE = "backup.owner.exists";

export const backupUploadTargetSchema = z.discriminatedUnion("into", [
  z
    .object({
      into: z.literal("existing"),
      userId: z.string().min(1).max(64),
      confirm: z.string().max(64),
    })
    .strict(),
  z
    .object({
      into: z.literal("new"),
      username: accountUsernameSchema,
    })
    .strict(),
]);

export type BackupUploadTarget = z.infer<typeof backupUploadTargetSchema>;

const TARGET_PARAMS = ["into", "userId", "confirm", "username"] as const;

/**
 * Read the target from the upload's query. Null when the query names none of
 * its parameters; a query that names any of them is held to the schema whole.
 */
export function parseBackupUploadTarget(
  params: URLSearchParams,
):
  | { success: true; data: BackupUploadTarget | null }
  | { success: false; error: z.ZodError } {
  if (!TARGET_PARAMS.some((name) => params.has(name))) {
    return { success: true, data: null };
  }
  const parsed = backupUploadTargetSchema.safeParse(
    Object.fromEntries(params.entries()),
  );
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error };
}

/** The query string for a target, as the admin console sends it. */
export function backupUploadTargetQuery(target: BackupUploadTarget): string {
  const params = new URLSearchParams(
    target.into === "existing"
      ? { into: "existing", userId: target.userId, confirm: target.confirm }
      : { into: "new", username: target.username },
  );
  return params.toString();
}
