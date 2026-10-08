"use client";

import { useMemo, useState } from "react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ManualWorkoutSheet } from "@/components/workouts/manual-workout-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useTranslations } from "@/lib/i18n/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { cn } from "@/lib/utils";
import {
  canEditWorkout,
  manualWorkoutOriginalFromRow,
  type StoredManualWorkout,
} from "@/lib/workouts/manual-entry";

/**
 * The detail page's edit control (#1162): a ghost icon beside delete that
 * opens the "Log workout" sheet on the stored values. Renders nothing for a
 * workout it may not edit (a synced one, or somebody else's record).
 *
 * Saving goes through the same `POST /api/workouts/batch` the form always
 * used, re-posting the row's own `manual:` id, which the route applies as an
 * overwrite of that one row. No separate edit route exists.
 */
export function EditWorkoutButton({
  workout,
}: {
  workout: StoredManualWorkout & {
    source: string;
    externalId: string | null;
  };
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const { preference } = useUnitDisplay();
  const capabilities = useRecordCapabilities();
  const [open, setOpen] = useState(false);
  const timezone = user?.timezone || DEFAULT_TIMEZONE;

  const original = useMemo(
    () =>
      manualWorkoutOriginalFromRow(workout, {
        timezone,
        unitPreference: preference,
      }),
    [workout, timezone, preference],
  );

  if (!canEditWorkout(workout, capabilities) || !workout.externalId) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-slot="workout-edit"
        aria-label={t("insights.workouts.manual.editAction")}
        title={t("insights.workouts.manual.editTitle")}
        onClick={() => setOpen(true)}
        className={cn(
          "text-muted-foreground hover:text-foreground relative size-10",
          "before:absolute before:-inset-1.5 before:content-['']",
        )}
      >
        <Pencil className="size-4" aria-hidden="true" />
      </Button>
      {/* The sheet mounts its form only while open, so each opening starts
          from the values the page shows at that moment. */}
      <ManualWorkoutSheet
        open={open}
        onOpenChange={setOpen}
        edit={{ externalId: workout.externalId, original }}
      />
    </>
  );
}
