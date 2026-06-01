"use client";

/**
 * v1.5.0 — CourseWindowRow component.
 *
 * Two-field row: `startsOn` (date picker, defaults to today on the
 * parent side) + `endsOn` (date picker with a "No end date" Switch).
 *
 * When `lockEndsToStart` is true (one-shot context), both pickers
 * show the same date and the second is read-only with a "(one-time
 * dose)" caption.
 *
 * Validation: `endsOn >= startsOn`. When violated the component
 * renders an error caption below the row; the form layer enforces
 * submission.
 *
 * i18n keys consumed (namespace `medications.scheduling.courseWindow.*`):
 *
 *   .startsOn.label        — "Starts on"
 *   .endsOn.label          — "Ends on"
 *   .noEndDate             — "No end date"
 *   .oneShotCaption        — "(one-time dose)"
 *   .invalidRange          — "End date must be on or after start"
 */

import { useCallback, useId, useMemo } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";

export interface CourseWindowRowProps {
  startsOn: Date | null;
  endsOn: Date | null;
  onChange: (next: { startsOn: Date | null; endsOn: Date | null }) => void;
  /** When true, endsOn is forced to equal startsOn (one-shot case). */
  lockEndsToStart?: boolean;
  disabled?: boolean;
  /** Translation namespace prefix. */
  i18nPrefix?: string;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit tests
// ────────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Convert a Date to an ISO YYYY-MM-DD wall-clock string (UTC day). */
export function dateToIsoString(d: Date | null): string {
  if (!d) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD → UTC midnight Date, or null. */
export function isoStringToDate(s: string): Date | null {
  if (!ISO_DATE_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/** Validate that endsOn ≥ startsOn (both Date or null). */
export function isRangeValid(
  startsOn: Date | null,
  endsOn: Date | null,
): boolean {
  if (!startsOn || !endsOn) return true;
  return endsOn.getTime() >= startsOn.getTime();
}

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

export function CourseWindowRow({
  startsOn,
  endsOn,
  onChange,
  lockEndsToStart = false,
  disabled = false,
  i18nPrefix = "medications.scheduling.courseWindow",
}: CourseWindowRowProps) {
  const { t } = useTranslations();
  const startId = useId();
  const endId = useId();

  const startsIso = useMemo(() => dateToIsoString(startsOn), [startsOn]);
  const endsIso = useMemo(() => dateToIsoString(endsOn), [endsOn]);
  const noEndDate = endsOn === null && !lockEndsToStart;
  const valid = useMemo(
    () => isRangeValid(startsOn, endsOn),
    [startsOn, endsOn],
  );

  const onStartsChange = useCallback(
    (iso: string) => {
      const next = isoStringToDate(iso);
      if (lockEndsToStart) {
        onChange({ startsOn: next, endsOn: next });
        return;
      }
      onChange({ startsOn: next, endsOn });
    },
    [endsOn, lockEndsToStart, onChange],
  );

  const onEndsChange = useCallback(
    (iso: string) => {
      const next = isoStringToDate(iso);
      onChange({ startsOn, endsOn: next });
    },
    [onChange, startsOn],
  );

  const onNoEndToggle = useCallback(
    (checked: boolean) => {
      // Switch "on" = no end date (endsOn = null). "Off" = require a
      // value; default to startsOn so the date input is editable but
      // doesn't render empty.
      if (checked) onChange({ startsOn, endsOn: null });
      else onChange({ startsOn, endsOn: startsOn });
    },
    [onChange, startsOn],
  );

  return (
    <div className="space-y-3" data-slot="course-window-row">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {/* startsOn */}
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={startId} className="text-sm">
            {t(`${i18nPrefix}.startsOn.label`)}
          </Label>
          <Input
            id={startId}
            type="date"
            value={startsIso}
            disabled={disabled}
            onChange={(e) => onStartsChange(e.target.value)}
            className="h-11 w-full"
            aria-label={t(`${i18nPrefix}.startsOn.label`)}
            data-slot="course-window-starts"
          />
        </div>

        {/* endsOn */}
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={endId} className="text-sm">
            {t(`${i18nPrefix}.endsOn.label`)}
          </Label>
          <Input
            id={endId}
            type="date"
            value={endsIso}
            disabled={
              disabled || noEndDate || lockEndsToStart
            }
            readOnly={lockEndsToStart}
            onChange={(e) => onEndsChange(e.target.value)}
            className="h-11 w-full"
            aria-label={t(`${i18nPrefix}.endsOn.label`)}
            aria-invalid={!valid || undefined}
            data-slot="course-window-ends"
          />
          {lockEndsToStart && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="course-window-oneshot-caption"
            >
              {t(`${i18nPrefix}.oneShotCaption`)}
            </p>
          )}
        </div>

        {/* No end date switch — hidden when locked to start. */}
        {!lockEndsToStart && (
          <div
            className="flex min-h-11 items-center gap-2 pb-1"
            data-slot="course-window-no-end-wrap"
          >
            <Switch
              id={`${endId}-no-end`}
              checked={noEndDate}
              disabled={disabled}
              onCheckedChange={onNoEndToggle}
              aria-label={t(`${i18nPrefix}.noEndDate`)}
              data-slot="course-window-no-end"
            />
            <Label htmlFor={`${endId}-no-end`} className="text-sm">
              {t(`${i18nPrefix}.noEndDate`)}
            </Label>
          </div>
        )}
      </div>

      {!valid && (
        <p
          className="text-destructive text-xs"
          role="alert"
          data-slot="course-window-error"
        >
          {t(`${i18nPrefix}.invalidRange`)}
        </p>
      )}
    </div>
  );
}
