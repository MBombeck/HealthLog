import { useQuery } from "@tanstack/react-query";
import { Loader2, UserPlus } from "lucide-react";
import { useState } from "react";

import type { AdminUser } from "@/components/admin/_shared";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { ApiError, apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { accountUsernameSchema } from "@/lib/validations/auth";
import type { BackupUploadTarget } from "@/lib/validations/backup-upload-target";

/** What the admin has filled in so far. */
export interface BackupTargetDraft {
  into: "new" | "existing";
  username: string;
  userId: string;
  confirm: string;
}

export const EMPTY_TARGET_DRAFT: BackupTargetDraft = {
  into: "new",
  username: "",
  userId: "",
  confirm: "",
};

/** The server's answer to "may this account take the copy?". */
export interface BackupTargetCheck {
  id: string;
  username: string;
  eligible: boolean;
  reason: string | null;
  models: string[];
}

/**
 * The accounts the picker offers: not a managed profile (its Guardians run
 * it), not pending deletion and not an admin account (the server refuses all
 * three, `restore-target.ts`). Whether one holds records is the server's to
 * say, per account, once it is picked.
 */
export function pickableAccounts(users: readonly AdminUser[]): AdminUser[] {
  return users.filter(
    (user) =>
      !user.managedProfile && user.deletion === null && user.role !== "ADMIN",
  );
}

/**
 * The target the draft describes, or null while it is not one the upload
 * would take: a new account needs a valid username nobody has, an existing
 * one needs the server's yes and its username typed exactly.
 */
export function readyTarget(
  draft: BackupTargetDraft,
  users: readonly AdminUser[],
  check: BackupTargetCheck | undefined,
): BackupUploadTarget | null {
  if (draft.into === "new") {
    const username = draft.username.trim();
    if (!accountUsernameSchema.safeParse(username).success) return null;
    if (users.some((user) => user.username === username)) return null;
    return { into: "new", username };
  }
  const user = users.find((candidate) => candidate.id === draft.userId);
  if (!user || !check || check.id !== user.id || !check.eligible) return null;
  if (draft.confirm.trim() !== user.username) return null;
  return { into: "existing", userId: user.id, confirm: user.username };
}

/** The sentence for a refusal, by the code the server answered with. */
export function targetFailureKey(code: string): string {
  switch (code) {
    case "backup.target.holds_records":
      return "admin.section.backups.target.failureHoldsRecords";
    case "backup.target.managed_profile":
      return "admin.section.backups.target.failureManagedProfile";
    case "backup.target.pending_deletion":
      return "admin.section.backups.target.failurePendingDeletion";
    case "backup.target.admin_account":
      return "admin.section.backups.target.failureAdminAccount";
    case "backup.target.not_found":
      return "admin.section.backups.target.failureNotFound";
    case "backup.target.unconfirmed":
      return "admin.section.backups.target.failureUnconfirmed";
    case "backup.target.username_taken":
      return "admin.section.backups.target.failureUsernameTaken";
    case "backup.owner.exists":
      return "admin.section.backups.target.failureOwnerExists";
    default:
      return "admin.section.backups.uploadFailed";
  }
}

/** The sentence for a failed upload or check. */
export function targetUploadFailureKey(error: unknown): string {
  return targetFailureKey(
    error instanceof ApiError && typeof error.meta?.errorCode === "string"
      ? error.meta.errorCode
      : "",
  );
}

/**
 * The form inside the dialog, apart from it so it renders on its own: where
 * the copy of an account that is no longer on this server goes. A new account
 * by default, since it cannot hold anything yet; an existing one when the
 * person has signed up again, checked by the server as soon as it is picked.
 */
export function BackupTargetForm({
  draft,
  onChange,
  disabled,
  users,
  check,
}: {
  draft: BackupTargetDraft;
  onChange: (next: BackupTargetDraft) => void;
  disabled: boolean;
  /** Every account; null while the list loads. */
  users: readonly AdminUser[] | null;
  /** The server's check of the picked account. */
  check: { data?: BackupTargetCheck; loading: boolean; error: unknown };
}) {
  const { t } = useTranslations();
  const accounts = pickableAccounts(users ?? []);
  const chosen = accounts.find((user) => user.id === draft.userId);
  const username = draft.username.trim();
  const usernameTaken = (users ?? []).some(
    (user) => user.username === username,
  );
  const usernameInvalid =
    username !== "" && !accountUsernameSchema.safeParse(username).success;

  return (
    <div className="space-y-4" data-slot="backup-target-form">
      <Segmented
        label={t("admin.section.backups.target.choiceLabel")}
        slot="backup-target-choice"
        stretch
        disabled={disabled}
        value={draft.into}
        onChange={(into) => onChange({ ...draft, into })}
        options={[
          { value: "new", label: t("admin.section.backups.target.newAccount") },
          {
            value: "existing",
            label: t("admin.section.backups.target.existingAccount"),
          },
        ]}
      />

      {draft.into === "new" ? (
        <div className="space-y-2">
          <Label htmlFor="backup-target-username">
            {t("admin.section.backups.target.usernameLabel")}
          </Label>
          <Input
            id="backup-target-username"
            data-testid="backup-target-username"
            value={draft.username}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, username: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={usernameInvalid || usernameTaken}
          />
          {usernameTaken ? (
            <p role="alert" className="text-destructive text-xs">
              {t("admin.section.backups.target.failureUsernameTaken")}
            </p>
          ) : usernameInvalid ? (
            <p role="alert" className="text-destructive text-xs">
              {t("admin.section.backups.target.usernameInvalid")}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {t("admin.section.backups.target.newAccountHint")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="backup-target-account">
            {t("admin.section.backups.target.accountLabel")}
          </Label>
          <NativeSelect
            id="backup-target-account"
            data-testid="backup-target-account"
            value={draft.userId}
            disabled={disabled || users === null}
            onChange={(e) =>
              onChange({ ...draft, userId: e.target.value, confirm: "" })
            }
          >
            <option value="">
              {t("admin.section.backups.target.accountPlaceholder")}
            </option>
            {accounts.map((user) => (
              <option key={user.id} value={user.id}>
                {user.email
                  ? `${user.username} (${user.email})`
                  : user.username}
              </option>
            ))}
          </NativeSelect>
          {chosen && check.loading ? (
            <p className="text-muted-foreground text-xs">
              {t("admin.section.backups.target.checking")}
            </p>
          ) : null}
          {chosen && check.error ? (
            <p role="alert" className="text-destructive text-xs">
              {t(targetUploadFailureKey(check.error))}
            </p>
          ) : null}
          {chosen && check.data && !check.data.eligible ? (
            <p
              role="alert"
              className="text-destructive text-xs"
              data-slot="backup-target-refused"
            >
              {t(targetFailureKey(`backup.target.${check.data.reason}`))}
            </p>
          ) : null}
          {chosen && check.data?.eligible ? (
            <>
              <p
                className="text-muted-foreground text-xs"
                data-slot="backup-target-eligible"
              >
                {t("admin.section.backups.target.eligible")}
              </p>
              <Label htmlFor="backup-target-confirm">
                {t("admin.section.backups.target.confirmLabel", {
                  username: chosen.username,
                })}
              </Label>
              <Input
                id="backup-target-confirm"
                data-testid="backup-target-confirm"
                value={draft.confirm}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...draft, confirm: e.target.value })
                }
                autoComplete="off"
                spellCheck={false}
                placeholder={chosen.username}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Shown when an upload was refused because the account the file belongs to
 * is not on this server. Choosing a target sends the file again with it; the
 * server rewrites the file's owner to that account as it stores it.
 */
export function BackupTargetDialog({
  file,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  /** The refused file; the dialog is open while there is one. */
  file: File | null;
  pending: boolean;
  /** The last refusal of an upload into a target, shown in the dialog. */
  error: unknown;
  onSubmit: (target: BackupUploadTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const [draft, setDraft] = useState<BackupTargetDraft>(EMPTY_TARGET_DRAFT);
  const users = useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => apiGet<AdminUser[]>("/api/admin/users"),
    enabled: file !== null,
  });
  const check = useQuery({
    queryKey: queryKeys.adminBackupTarget(draft.userId),
    queryFn: () =>
      apiGet<BackupTargetCheck>(
        `/api/admin/backups/targets/${encodeURIComponent(draft.userId)}`,
      ),
    enabled: file !== null && draft.into === "existing" && draft.userId !== "",
    retry: false,
  });
  const target = readyTarget(draft, users.data ?? [], check.data);

  return (
    <AlertDialog
      open={file !== null}
      onOpenChange={(next) => {
        if (next || pending) return;
        onClose();
      }}
    >
      <AlertDialogContent data-slot="backup-target-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("admin.section.backups.target.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin.section.backups.target.description", {
              file: file?.name ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {file ? (
          <BackupTargetForm
            draft={draft}
            onChange={setDraft}
            disabled={pending}
            users={users.isError ? [] : (users.data ?? null)}
            check={{
              data: check.data,
              loading: check.isLoading,
              error: check.error,
            }}
          />
        ) : null}
        {error && !pending ? (
          <p role="alert" className="text-destructive text-sm">
            {t(targetUploadFailureKey(error))}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <Button
            data-testid="backup-target-submit"
            disabled={!target || pending}
            onClick={() => {
              if (target) onSubmit(target);
            }}
            className="min-h-11"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <UserPlus className="h-3.5 w-3.5" />
            )}
            {pending
              ? t("admin.section.backups.target.submitting")
              : t("admin.section.backups.target.submit")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
