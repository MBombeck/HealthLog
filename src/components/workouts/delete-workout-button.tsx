"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiDelete } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

/**
 * Whether a workout can be deleted from its detail page: one entered by hand,
 * in one's own record. A synced workout would come back with the next sync,
 * and `DELETE /api/workouts/{id}` refuses it (409); the route also resolves
 * the caller, so a delegate is never offered it.
 */
export function canDeleteWorkout(
  workout: { source: string },
  caps: { inSharedRecord: boolean },
): boolean {
  return workout.source === "MANUAL" && !caps.inSharedRecord;
}

/**
 * Delete, then drop the deleted detail from the cache and refresh the rest of
 * the workout reads (list, dashboard tile) and the two daily reads the route
 * evicted server-side. The detail is removed rather than invalidated, so
 * nothing refetches a row that no longer exists.
 */
export async function deleteManualWorkout(
  id: string,
  queryClient: QueryClient,
): Promise<void> {
  await apiDelete(`/api/workouts/${encodeURIComponent(id)}`);
  queryClient.removeQueries({ queryKey: queryKeys.workoutDetail(id) });
  await queryClient.invalidateQueries({ queryKey: queryKeys.workouts() });
  await refetchInactiveDailyReads(queryClient);
}

/**
 * The detail page's delete control: a ghost icon in the page header cluster
 * that asks before it deletes. Renders nothing for a workout it may not
 * delete.
 */
export function DeleteWorkoutButton({
  workout,
}: {
  workout: { id: string; source: string };
}) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const capabilities = useRecordCapabilities();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!canDeleteWorkout(workout, capabilities)) return null;

  async function handleDelete(e: React.MouseEvent) {
    // Keep the dialog open while the request runs; it closes on success.
    e.preventDefault();
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteManualWorkout(workout.id, queryClient);
      toastWrittenOutcome("success", t("insights.workouts.manual.deleted"));
      setOpen(false);
      router.replace("/insights/workouts");
    } catch {
      toastWrittenOutcome("failed", t("insights.workouts.manual.deleteError"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-slot="workout-delete"
        aria-label={t("insights.workouts.manual.deleteLabel")}
        title={t("insights.workouts.manual.deleteLabel")}
        onClick={() => setOpen(true)}
        className={cn(
          "text-muted-foreground hover:text-foreground relative size-10",
          "before:absolute before:-inset-1.5 before:content-['']",
        )}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("insights.workouts.manual.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("insights.workouts.manual.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
              data-testid="workout-delete-confirm"
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
