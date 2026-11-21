"use client";

/**
 * v1.15.18 — per-dose configurable on-time WINDOW editor (the maintainer's headline
 * lever). Shared verbatim by the Zeitplan tab (everyday inline edit) and
 * the wizard's Step 7 (structural create / edit) so the window semantics
 * are identical wherever a dose time is set.
 *
 * Per dose time the user expresses EITHER a point time (e.g. 19:00 →
 * implies the ±1h default band) OR an explicit RANGE (e.g. 07:00–09:00).
 * The editor shows the resulting on-time band plus a cadence-aware
 * "verspätet bis …" hint derived from the engine's late tail. It is a
 * controlled component over the persisted `DoseWindowEntry[]` contract
 * (`{ timeOfDay, start, end }`), validated client-side to match the W7
 * zod: HH:mm, `start <= end`, `timeOfDay ∈ timesOfDay`.
 *
 * Calm, inset-grouped, AA. No card tint — the surface follows the muted
 * section chrome the other Zeitplan / Erinnerung rows use.
 */

import { useCallback, useId, useMemo, useState } from "react";

import { TimeField } from "@/components/ui/time-field";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  buildRows,
  isOrderedRange,
  isValidHhmm,
  lateTailDays,
  lateTailEndHhmm,
  rowsToEntries,
  type DoseWindowEntry,
  type DoseWindowRow,
  type DoseWindowScale,
} from "./dose-window";

export interface DoseWindowEditorProps {
  /** The schedule's dose times (HH:mm) — one editor row per time. */
  timesOfDay: string[];
  /** The persisted explicit windows for this schedule. */
  value: DoseWindowEntry[];
  /** Emits the next explicit-window set (point-equivalent rows dropped). */
  onChange: (next: DoseWindowEntry[]) => void;
  /**
   * Cadence scale — drives the late-tail hint. `intraday` (daily /
   * multi-daily) shows a wall-clock late end; `dayScale` (weekly /
   * rolling) shows the day-count tail. Defaults to `intraday`.
   */
  scale?: DoseWindowScale;
  /** Disables every control (e.g. while a save is in flight). */
  disabled?: boolean;
  /** Stable id-prefix for the rendered inputs (defaults to a generated id). */
  idPrefix?: string;
}

export function DoseWindowEditor({
  timesOfDay,
  value,
  onChange,
  scale = "intraday",
  disabled = false,
  idPrefix,
}: DoseWindowEditorProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const generatedId = useId();
  const prefix = idPrefix ?? generatedId;

  // v1.25.13 — the switch reflects the user's INTENT to customise, held in
  // local state, because it cannot be reconstructed from `value` alone: the
  // persisted contract stores ONLY ranges that differ from the default band
  // (`rowsToEntries` drops a default-equal range so the column stays minimal).
  // The former editor seeded the range from the default band on toggle-ON and
  // emitted immediately, so serialisation dropped it right back to `[]`, the
  // controlled `checked={row.custom}` recomputed `false`, and the switch
  // snapped off — the toggle could never turn on without first editing a range
  // the editor wouldn't reveal until the toggle was on (a deadlock). Tracking
  // the opened set here decouples the toggle from serialisation: the row shows
  // its default band, and an explicit range only persists once it differs.
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const rows = useMemo(() => {
    const base = buildRows(timesOfDay, value);
    if (opened.size === 0) return base;
    // A row the user opened reads as custom even while its range still equals
    // the default band (nothing persisted yet); a row already carrying a
    // stored explicit range is custom via `value` regardless.
    return base.map((r) =>
      opened.has(r.timeOfDay) ? { ...r, custom: true } : r,
    );
  }, [timesOfDay, value, opened]);

  // Rebuild the persisted set from the next row state and bubble it up.
  const emit = useCallback(
    (nextRows: DoseWindowRow[]) => {
      onChange(rowsToEntries(nextRows));
    },
    [onChange],
  );

  const setRow = useCallback(
    (timeOfDay: string, patch: Partial<DoseWindowRow>) => {
      emit(
        rows.map((r) => (r.timeOfDay === timeOfDay ? { ...r, ...patch } : r)),
      );
    },
    [emit, rows],
  );

  const toggleCustom = useCallback(
    (row: DoseWindowRow, custom: boolean) => {
      setOpened((prev) => {
        const next = new Set(prev);
        if (custom) next.add(row.timeOfDay);
        else next.delete(row.timeOfDay);
        return next;
      });
      // Switching OFF drops any persisted explicit range for the slot (back to
      // the default derivation). Switching ON needs no emit — the row already
      // renders the default band and the opened set keeps the switch on; a
      // range only persists once the user edits it away from the default.
      if (!custom) {
        setRow(row.timeOfDay, { custom: false });
      }
    },
    [setRow],
  );

  if (rows.length === 0) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-slot="dose-window-editor-empty"
      >
        {t("medications.detail.zeitplan.window.noTimes")}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-slot="dose-window-editor">
      <p className="text-muted-foreground text-xs">
        {t("medications.detail.zeitplan.window.intro")}
      </p>
      <ul className="divide-border divide-y rounded-md border" role="list">
        {rows.map((row) => {
          const ordered = isOrderedRange(row.start, row.end);
          const lateEnd = lateTailEndHhmm(row.end, scale);
          const switchId = `${prefix}-custom-${row.timeOfDay}`;
          const startId = `${prefix}-start-${row.timeOfDay}`;
          const endId = `${prefix}-end-${row.timeOfDay}`;
          return (
            <li
              key={row.timeOfDay}
              className="space-y-2 p-3"
              data-slot="dose-window-row"
              data-time={row.timeOfDay}
              data-custom={row.custom ? "true" : "false"}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-foreground text-sm font-medium tabular-nums">
                  {fmt.wallTime(row.timeOfDay)}
                </span>
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor={switchId}
                    className="text-muted-foreground text-xs"
                  >
                    {t("medications.detail.zeitplan.window.explicitToggle")}
                  </Label>
                  <Switch
                    id={switchId}
                    checked={row.custom}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggleCustom(row, checked)}
                    data-slot="dose-window-explicit-switch"
                  />
                </div>
              </div>

              {row.custom ? (
                <div className="space-y-2" data-slot="dose-window-range">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={startId} className="sr-only">
                      {t("medications.detail.zeitplan.window.startLabel")}
                    </Label>
                    <TimeField
                      id={startId}
                      value={row.start}
                      disabled={disabled}
                      onChange={(v) => setRow(row.timeOfDay, { start: v })}
                      className="h-11 w-32 sm:h-9 sm:min-h-9"
                      aria-label={t(
                        "medications.detail.zeitplan.window.startLabel",
                      )}
                      data-testid="dose-window-start"
                    />
                    <span className="text-muted-foreground text-sm">–</span>
                    <Label htmlFor={endId} className="sr-only">
                      {t("medications.detail.zeitplan.window.endLabel")}
                    </Label>
                    <TimeField
                      id={endId}
                      value={row.end}
                      disabled={disabled}
                      onChange={(v) => setRow(row.timeOfDay, { end: v })}
                      className="h-11 w-32 sm:h-9 sm:min-h-9"
                      aria-label={t(
                        "medications.detail.zeitplan.window.endLabel",
                      )}
                      data-testid="dose-window-end"
                    />
                  </div>
                  {isValidHhmm(row.start) &&
                  isValidHhmm(row.end) &&
                  !ordered ? (
                    <p
                      className="text-destructive text-sm"
                      role="alert"
                      data-slot="dose-window-error"
                    >
                      {t("medications.detail.zeitplan.window.orderError")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* The resulting on-time band + the late tail. Always shown so
                  the point case still communicates its implied ±1h band. */}
              <p
                className="text-muted-foreground text-xs"
                data-slot="dose-window-band"
              >
                {t("medications.detail.zeitplan.window.onTimeBand", {
                  start: fmt.wallTime(row.start),
                  end: fmt.wallTime(row.end),
                })}
                {scale === "dayScale"
                  ? ` · ${t("medications.detail.zeitplan.window.lateDays", {
                      days: lateTailDays(),
                    })}`
                  : lateEnd
                    ? ` · ${t("medications.detail.zeitplan.window.lateUntil", {
                        time: fmt.wallTime(lateEnd),
                      })}`
                    : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
