"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { Badge } from "@/components/ui/badge";
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
import { Check, SkipForward, Loader2, X } from "lucide-react";
import { formatDateWithWeekday, formatTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface IntakeEvent {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: string;
  createdAt: string;
}

interface IntakeTimelineProps {
  medicationId: string;
  medicationName: string;
}

export function IntakeTimeline({
  medicationId,
  medicationName,
}: IntakeTimelineProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const { data: events, isLoading } = useQuery({
    queryKey: ["medications", medicationId, "intake"],
    queryFn: async () => {
      const res = await fetch(
        `/api/medications/${medicationId}/intake?limit=50`,
      );
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data.events as IntakeEvent[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${eventId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void invalidateKeys(queryClient, medicationDependentKeys);
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!events?.length) {
    return (
      <p className="text-muted-foreground py-4 text-center text-sm">
        {`${t("medications.noIntakesForMedication")} ${medicationName}`}
      </p>
    );
  }

  // Group by day
  const grouped = new Map<string, IntakeEvent[]>();
  for (const event of events) {
    const day = formatDateWithWeekday(event.scheduledFor);
    const list = grouped.get(day) ?? [];
    list.push(event);
    grouped.set(day, list);
  }

  return (
    <div className="space-y-2.5">
      {[...grouped.entries()].map(([day, dayEvents]) => (
        <div key={day} className="space-y-1.5">
          <p className="text-muted-foreground text-xs font-medium">{day}</p>
          <div className="flex flex-wrap gap-1.5">
            {dayEvents.map((event) => (
              <div key={event.id} className="group relative inline-flex">
                <Badge
                  variant={event.skipped ? "outline" : "secondary"}
                  className={
                    event.skipped
                      ? "text-muted-foreground gap-1 pr-6"
                      : "gap-1 bg-green-500/20 pr-6 text-green-400"
                  }
                >
                  {event.skipped ? (
                    <SkipForward className="h-3 w-3" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {formatTime(event.scheduledFor)}
                  {event.source !== "WEB" && (
                    <span className="text-[10px] opacity-60">
                      {event.source}
                    </span>
                  )}
                </Badge>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      className="text-destructive absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label={t("medications.deleteIntakeAriaLabel")}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("medications.intakeDeleteConfirm")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("medications.intakeDeleteDescription")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("common.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => deleteMutation.mutate(event.id)}
                      >
                        {t("common.delete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
