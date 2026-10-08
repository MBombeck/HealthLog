"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldError } from "@/components/forms/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { getQuantityTransform } from "@/lib/measurements/display-transform";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  buildManualWorkoutEntry,
  emptyManualWorkoutDraft,
  newManualWorkoutExternalId,
  wallClockNow,
  type ManualWorkoutDraft,
  type ManualWorkoutEntry,
  type ManualWorkoutField,
  type ManualWorkoutOriginal,
} from "@/lib/workouts/manual-entry";
import {
  workoutSportTypeEnum,
  type WorkoutSportType,
} from "@/lib/validations/workout";

/**
 * Log a workout by hand: sport, start, duration, and optionally distance and
 * active energy. Nothing else on purpose; see `manual-entry.ts`.
 *
 * Same contract as the other capture forms (`MoodForm`,
 * `MedicationIntakeQuickAdd`): mounted inside a `ResponsiveSheet`, the action
 * row portalled into the sheet's sticky footer through `footerSlot`, and
 * `onSuccess` / `onCancel` close the sheet.
 */

/**
 * Edit mode (#1162): the stored workout's own `manual:` id and the values it
 * opens with. Saving re-posts that id, which the batch route applies as an
 * overwrite of that one row.
 */
export interface ManualWorkoutEdit {
  externalId: string;
  original: ManualWorkoutOriginal;
}

interface ManualWorkoutFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  footerSlot?: HTMLElement | null;
  edit?: ManualWorkoutEdit;
  /** Whether the fields differ from what the form opened with. */
  onDirtyChange?: (dirty: boolean) => void;
}

interface BatchResult {
  entries?: Array<{ status: string }>;
}

export type ManualWorkoutSaveOutcome = "inserted" | "duplicate" | "updated";

/**
 * Post the entry and refresh what shows workouts. A `duplicate` is a success:
 * the same form already landed this session (a second tap, a retry), so the
 * row exists exactly once. A `skipped` entry was refused and throws.
 */
export async function saveManualWorkout(
  entry: ManualWorkoutEntry,
  queryClient: QueryClient,
): Promise<ManualWorkoutSaveOutcome> {
  const result = await apiPost<BatchResult>("/api/workouts/batch", {
    workouts: [entry],
  });
  const status = result?.entries?.[0]?.status;
  if (status !== "inserted" && status !== "duplicate" && status !== "updated") {
    throw new Error(`workout entry not stored: ${status ?? "unknown"}`);
  }
  // The list, the dashboard tile and every detail read sit under this
  // prefix. The form also opens from the capture picker on any page, where
  // the Today hero (which names a workout that just landed) and the dashboard
  // snapshot are unmounted, so those two are refetched outright.
  await queryClient.invalidateQueries({ queryKey: queryKeys.workouts() });
  await refetchInactiveDailyReads(queryClient);
  return status;
}

/** The sports, by their label in the reader's language, "Other" last. */
export function sportOptions(
  label: (sport: WorkoutSportType) => string,
): Array<{ value: WorkoutSportType; label: string }> {
  const named = workoutSportTypeEnum.options
    .filter((sport) => sport !== "other")
    .map((value): { value: WorkoutSportType; label: string } => ({
      value,
      label: label(value),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...named, { value: "other", label: label("other") }];
}

export function ManualWorkoutForm({
  onSuccess,
  onCancel,
  footerSlot,
  edit,
  onDirtyChange,
}: ManualWorkoutFormProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { preference } = useUnitDisplay();
  const timezone = user?.timezone || DEFAULT_TIMEZONE;

  // Minted once per opened form and sent with every submit, so a second tap
  // or a retried request lands as a duplicate rather than a second row, and
  // a submit after an edit updates the row the first submit stored.
  // An edit sends the stored row's own id instead.
  const [externalId] = useState(
    () => edit?.externalId ?? newManualWorkoutExternalId(),
  );
  const [initialDraft] = useState<ManualWorkoutDraft>(
    () => edit?.original.draft ?? emptyManualWorkoutDraft(),
  );
  const [draft, setDraft] = useState<ManualWorkoutDraft>(initialDraft);
  const dirty = (
    Object.keys(initialDraft) as Array<keyof ManualWorkoutDraft>
  ).some((key) => draft[key] !== initialDraft[key]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const [errors, setErrors] = useState<
    Partial<Record<ManualWorkoutField, string>>
  >({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const formId = useId();
  const ids = {
    sport: `${formId}-sport`,
    start: `${formId}-start`,
    hours: `${formId}-hours`,
    minutes: `${formId}-minutes`,
    distance: `${formId}-distance`,
    energy: `${formId}-energy`,
    durationError: `${formId}-duration-error`,
    saveError: `${formId}-save-error`,
  };

  const distanceUnit = getQuantityTransform("distance", preference).displayUnit;
  const options = useMemo(
    () => sportOptions((sport) => t(`insights.workouts.sport.${sport}`)),
    [t],
  );

  function update<K extends keyof ManualWorkoutDraft>(
    key: K,
    value: ManualWorkoutDraft[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaveError(null);
    const built = buildManualWorkoutEntry(draft, {
      timezone,
      unitPreference: preference,
      externalId,
      now: new Date(),
      original: edit?.original,
    });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const outcome = await saveManualWorkout(built.entry, queryClient);
      // A duplicate wrote nothing new: the same form already landed this
      // session. That is reported as such, not as a fresh save.
      if (outcome === "duplicate") {
        toastWrittenOutcome(
          "empty",
          t("insights.workouts.manual.alreadySaved"),
        );
      } else if (outcome === "updated") {
        toastWrittenOutcome("success", t("insights.workouts.manual.updated"));
      } else {
        toastWrittenOutcome("success", t("common.saved"));
      }
      onSuccess?.();
    } catch (err) {
      setSaveError(
        err instanceof ApiError && err.message
          ? err.message
          : t("insights.workouts.manual.saveError"),
      );
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (field: ManualWorkoutField) =>
    errors[field] ? t(errors[field]) : undefined;
  const describedBy = (field: ManualWorkoutField, id: string) =>
    errors[field] ? id : undefined;

  const footerNode = (
    <div className="flex w-full items-center justify-end gap-2">
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 sm:min-h-9"
        >
          {t("common.cancel")}
        </Button>
      )}
      <Button
        type="submit"
        form={formId}
        disabled={saving}
        className="min-h-11 sm:min-h-9"
        data-testid="manual-workout-save"
      >
        {saving ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : edit ? (
          <Check className="size-4" />
        ) : (
          <Plus className="size-4" />
        )}
        {t("common.save")}
      </Button>
    </div>
  );

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      noValidate
      className="space-y-4"
      data-testid="manual-workout-form"
    >
      <div className="space-y-2">
        <Label htmlFor={ids.sport}>
          {t("insights.workouts.manual.sportLabel")}
        </Label>
        <Select
          value={draft.sportType}
          onValueChange={(value) =>
            update("sportType", value as WorkoutSportType)
          }
        >
          <SelectTrigger
            id={ids.sport}
            className="w-full"
            aria-invalid={!!errors.sportType || undefined}
            aria-describedby={describedBy("sportType", `${ids.sport}-error`)}
            data-testid="manual-workout-sport"
          >
            <SelectValue
              placeholder={t("insights.workouts.manual.sportPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError
          id={`${ids.sport}-error`}
          message={fieldError("sportType")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.start}>
          {t("insights.workouts.manual.startLabel")}
        </Label>
        <DateTimeField
          id={ids.start}
          value={draft.start}
          onChange={(value) => update("start", value)}
          max={wallClockNow(new Date(), timezone)}
          aria-invalid={!!errors.start || undefined}
          aria-describedby={[
            edit ? undefined : `${ids.start}-hint`,
            describedBy("start", `${ids.start}-error`),
          ]
            .filter(Boolean)
            .join(" ")}
          data-testid="manual-workout-start"
        />
        {/* "Leave empty if you just finished" is about logging; an edit
            opens with the stored start in place. */}
        {edit ? null : (
          <p id={`${ids.start}-hint`} className="text-muted-foreground text-xs">
            {t("insights.workouts.manual.startHint")}
          </p>
        )}
        <FieldError id={`${ids.start}-error`} message={fieldError("start")} />
      </div>

      <fieldset
        className="space-y-2"
        aria-describedby={describedBy("duration", ids.durationError)}
      >
        <legend className="mb-2 text-sm leading-none font-medium">
          {t("insights.workouts.manual.durationLabel")}
        </legend>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label
              htmlFor={ids.hours}
              className="text-muted-foreground text-xs font-normal"
            >
              {t("common.hours")}
            </Label>
            <Input
              id={ids.hours}
              inputMode="numeric"
              autoComplete="off"
              value={draft.hours}
              onChange={(e) => update("hours", e.target.value)}
              aria-invalid={!!errors.duration || undefined}
              data-testid="manual-workout-hours"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor={ids.minutes}
              className="text-muted-foreground text-xs font-normal"
            >
              {t("common.minutes")}
            </Label>
            <Input
              id={ids.minutes}
              inputMode="numeric"
              autoComplete="off"
              value={draft.minutes}
              onChange={(e) => update("minutes", e.target.value)}
              aria-invalid={!!errors.duration || undefined}
              data-testid="manual-workout-minutes"
            />
          </div>
        </div>
        <FieldError id={ids.durationError} message={fieldError("duration")} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={ids.distance}>
            {t("insights.workouts.manual.distanceLabel", {
              unit: distanceUnit,
            })}
          </Label>
          <Input
            id={ids.distance}
            inputMode="decimal"
            autoComplete="off"
            placeholder={t("common.optional")}
            value={draft.distance}
            onChange={(e) => update("distance", e.target.value)}
            aria-invalid={!!errors.distance || undefined}
            aria-describedby={describedBy("distance", `${ids.distance}-error`)}
            data-testid="manual-workout-distance"
          />
          <FieldError
            id={`${ids.distance}-error`}
            message={fieldError("distance")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.energy}>
            {t("insights.workouts.manual.energyLabel")}
          </Label>
          <Input
            id={ids.energy}
            inputMode="decimal"
            autoComplete="off"
            placeholder={t("common.optional")}
            value={draft.energyKcal}
            onChange={(e) => update("energyKcal", e.target.value)}
            aria-invalid={!!errors.energyKcal || undefined}
            aria-describedby={describedBy("energyKcal", `${ids.energy}-error`)}
            data-testid="manual-workout-energy"
          />
          <FieldError
            id={`${ids.energy}-error`}
            message={fieldError("energyKcal")}
          />
        </div>
      </div>

      {saveError && (
        <div
          id={ids.saveError}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {saveError}
        </div>
      )}

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
    </form>
  );
}
