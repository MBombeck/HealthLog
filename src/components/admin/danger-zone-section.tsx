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

export function DangerZoneSection({ id }: { id: string }) {
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
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setWipeMsg(
        t("admin.deletedResult", {
          measurements: data.measurements,
          medications: data.medications,
          intakeEvents: data.intakeEvents,
        }),
      );
    },
    onError: (err: Error) => {
      setWipeMsg(err.message);
    },
  });

  return (
    <div
      id={id}
      className="bg-destructive/5 border-destructive/30 scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-5 w-5" />
        <h2 className="text-destructive text-lg font-semibold">
          {t("admin.dangerZone")}
        </h2>
      </div>
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
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
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
            className={`mt-2 text-sm ${wipeMsg.startsWith(t("admin.deletedResult", { measurements: "", medications: "", intakeEvents: "" }).split(":")[0]) ? "text-dracula-green" : "text-destructive"}`}
          >
            {wipeMsg}
          </p>
        )}
      </div>
    </div>
  );
}
