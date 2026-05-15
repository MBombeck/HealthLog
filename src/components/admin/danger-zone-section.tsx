"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

export function DangerZoneSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);

  const wipeAllData = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE ALL" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("common.error"));
      return json.data as {
        measurements: number;
        intakeEvents: number;
        medications: number;
        apiTokens: number;
        withingsConnections: number;
        authChallenges: number;
        notificationChannels: number;
        pushSubscriptions: number;
        telegramScheduledDeletions: number;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setWipeMsg(
        t("admin.deletedResult", {
          measurements: data.measurements,
          medications: data.medications,
          intakeEvents: data.intakeEvents,
          apiTokens: data.apiTokens,
          withingsConnections: data.withingsConnections,
          authChallenges: data.authChallenges,
          notificationChannels: data.notificationChannels,
          pushSubscriptions: data.pushSubscriptions,
          telegramScheduledDeletions: data.telegramScheduledDeletions,
        }),
      );
    },
    onError: (err: Error) => {
      setWipeMsg(err.message);
    },
  });

  return (
    <div className="bg-destructive/5 border-destructive/30 rounded-xl border p-6">
      {/* v1.4.19 A8 / F-08: page header `admin.section.danger-zone.*`
          already names the section, so the card-level title was a
          duplicate of the page title. The destructive icon stays so
          the card still flags itself as dangerous at a glance. */}
      <AlertTriangle className="text-destructive h-5 w-5" aria-hidden="true" />
      <div className="mt-4">
        <p className="text-sm font-medium">{t("admin.deleteAllData")}</p>
        <p className="text-muted-foreground text-xs">
          {t("admin.deleteAllDescription")}
        </p>
        <div className="mt-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={wipeAllData.isPending}
              >
                {wipeAllData.isPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                {t("admin.deleteButton")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("admin.deleteAllConfirm")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("admin.deleteAllConfirmDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => wipeAllData.mutate()}
                >
                  {t("admin.finalDelete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {wipeMsg && (
          <p
            className={`mt-2 text-sm ${
              wipeAllData.isError ? "text-destructive" : "text-dracula-green"
            }`}
          >
            {wipeMsg}
          </p>
        )}
      </div>
    </div>
  );
}
