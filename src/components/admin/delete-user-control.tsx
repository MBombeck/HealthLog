"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { showErrorToast } from "@/lib/errors/error-toast";
import { apiDelete } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { useAccountDeletionGrace } from "@/lib/queries/use-privacy-summary";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import type { AdminUser } from "./_shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the row offers deleting the account: never the admin's own (that is
 * the account settings' deletion), never a managed profile (its Guardians
 * delete it), and not one already pending deletion (the row offers the undo).
 */
export function canAdminDelete(user: AdminUser, currentUserId: string | null) {
  return (
    user.id !== currentUserId && !user.managedProfile && user.deletion === null
  );
}

/**
 * The day the purge job would erase an account deleted now, or null when the
 * window is 0 and the erasure happens at once. The server stamps the real
 * date; this is the one the dialog names before asking.
 */
export function deletionDateFrom(graceDays: number, now: Date): Date | null {
  return graceDays > 0 ? new Date(now.getTime() + graceDays * DAY_MS) : null;
}

/**
 * "Delete account" on a row of the admin users list
 * (`DELETE /api/admin/users/{id}`), for the rows `canAdminDelete` allows.
 */
export function DeleteUserControl({
  user,
  currentUserId,
}: {
  user: AdminUser;
  currentUserId: string | null;
}) {
  if (!canAdminDelete(user, currentUserId)) return null;
  return <DeleteUserButton user={user} />;
}

/**
 * The dialog names the date the account is erased and that it can be undone
 * here until then, or, with no grace window, that it is erased at once. It
 * waits for the window before it offers anything, so the sentence is never a
 * guess. The fresh proof the route asks for is collected by the shared
 * re-proof dialog.
 */
function DeleteUserButton({ user }: { user: AdminUser }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const grace = useAccountDeletionGrace();
  const recentProof = useRecentProof();

  const remove = useMutation({
    mutationFn: () =>
      recentProof.run(() =>
        apiDelete<{ scheduledPurgeAt: string | null }>(
          `/api/admin/users/${user.id}`,
          { confirm: "DELETE_ACCOUNT" },
        ),
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers() });
      toastWrittenOutcome(
        "success",
        result.scheduledPurgeAt
          ? t("admin.section.users.deleteUserScheduled", {
              name: user.username,
              date: formatDate(result.scheduledPurgeAt),
            })
          : t("admin.section.users.deleteUserDone", { name: user.username }),
      );
    },
    onError: (err) => {
      const message = recentProofErrorMessage(
        err,
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.users.deleteUserFailed"),
      );
      if (message) showErrorToast(message, { cause: err });
    },
  });

  const purgeOn =
    grace.days === null ? null : deletionDateFrom(grace.days, new Date());

  return (
    <>
      {recentProof.dialog}
      <ConfirmButton
        slot="admin-user-delete"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground min-h-11 min-w-11 px-2 text-xs"
        icon={<Trash2 className="h-3 w-3" aria-hidden="true" />}
        label=""
        ariaLabel={t("admin.section.users.deleteUser")}
        disabled={grace.days === null}
        title={t("admin.section.users.deleteUserTitle", {
          name: user.username,
        })}
        body={
          purgeOn
            ? t("admin.section.users.deleteUserBodyGrace", {
                name: user.username,
                date: formatDate(purgeOn),
              })
            : t("admin.section.users.deleteUserBodyNow", {
                name: user.username,
              })
        }
        confirmLabel={t("admin.section.users.deleteUserConfirm")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        destructive
      />
    </>
  );
}
