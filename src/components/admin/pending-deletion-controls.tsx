"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { showErrorToast } from "@/lib/errors/error-toast";
import { apiPost } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { AdminUser } from "./_shared";

/** The undo dialog's sentence, by who asked for the deletion. */
const UNDO_BODY_KEYS = {
  self: "admin.section.users.undoDeletionBody",
  guardian: "admin.section.users.undoDeletionBodyGuardian",
  admin: "admin.section.users.undoDeletionBodyAdmin",
} as const;

/**
 * An account pending deletion, in the admin users list: the date the purge
 * job erases it, and the one action that stops it.
 *
 * The account, its stored copies and its off-host objects are untouched
 * until that date, so "Undo deletion" (`POST /api/admin/users/{id}/undo-deletion`)
 * gives it back exactly as it was. Renders nothing for any other account.
 */
export function PendingDeletionControls({ user }: { user: AdminUser }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const undo = useMutation({
    mutationFn: () => apiPost(`/api/admin/users/${user.id}/undo-deletion`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers() });
      toast.success(
        t("admin.section.users.undoDeletionDone", { name: user.username }),
      );
    },
    onError: (err) => {
      showErrorToast(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.users.undoDeletionFailed"),
        { cause: err },
      );
    },
  });

  if (!user.deletion) return null;
  return (
    <span
      className="flex flex-wrap items-center gap-1"
      data-slot="admin-user-deletion-pending"
    >
      <Badge variant="destructive" className="text-xs">
        {user.deletion.purgeAt
          ? t("admin.section.users.deletionPending", {
              date: formatDate(user.deletion.purgeAt),
            })
          : t("admin.section.users.deletionPendingNoDate")}
      </Badge>
      <ConfirmButton
        slot="admin-user-undo-deletion"
        size="sm"
        className="min-h-11 text-xs"
        icon={<Undo2 className="h-3 w-3" aria-hidden="true" />}
        label={t("admin.section.users.undoDeletion")}
        title={t("admin.section.users.undoDeletionTitle", {
          name: user.username,
        })}
        body={t(UNDO_BODY_KEYS[user.deletion.requestedBy], {
          name: user.username,
        })}
        confirmLabel={t("admin.section.users.undoDeletion")}
        pending={undo.isPending}
        onConfirm={() => undo.mutate()}
      />
    </span>
  );
}
