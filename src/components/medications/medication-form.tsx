"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  BellOff,
  Clock,
  Eraser,
  Loader2,
  MoreHorizontal,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { toast } from "sonner";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { PhaseConfigDialog } from "@/components/medications/phase-config-dialog";

// DOSE_UNITS built dynamically via t() in the component

type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function getDayLabelsShort(t: TranslateFn): string[] {
  return [
    t("medications.daysSun"),
    t("medications.daysMon"),
    t("medications.daysTue"),
    t("medications.daysWed"),
    t("medications.daysThu"),
    t("medications.daysFri"),
    t("medications.daysSat"),
  ];
}

function getDayLabelsLong(t: TranslateFn): string[] {
  return [
    t("medications.weekdaySundayPlural"),
    t("medications.weekdayMondayPlural"),
    t("medications.weekdayTuesdayPlural"),
    t("medications.weekdayWednesdayPlural"),
    t("medications.weekdayThursdayPlural"),
    t("medications.weekdayFridayPlural"),
    t("medications.weekdaySaturdayPlural"),
  ];
}

function getNextRecurrenceDate(schedule: Schedule): Date | null {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const startWeekIndex = Math.floor(start.getTime() / weekMs);

  for (let offset = 0; offset <= 400; offset++) {
    const candidate = new Date(start);
    candidate.setDate(start.getDate() + offset);

    const candidateWeekIndex = Math.floor(candidate.getTime() / weekMs);
    const isIntervalWeek =
      schedule.intervalWeeks <= 1 ||
      candidateWeekIndex % schedule.intervalWeeks ===
        startWeekIndex % schedule.intervalWeeks;
    if (!isIntervalWeek) continue;

    if (
      schedule.daysOfWeek.length === 0 ||
      schedule.daysOfWeek.includes(candidate.getDay())
    ) {
      return candidate;
    }
  }

  return null;
}

function formatRecurrenceSummary(schedule: Schedule, t: TranslateFn): string {
  const dayLabelsShort = getDayLabelsShort(t);
  const dayLabelsLong = getDayLabelsLong(t);
  const dayText =
    schedule.daysOfWeek.length === 0
      ? t("medications.scheduleDaily")
      : schedule.daysOfWeek.length === 1
        ? dayLabelsLong[schedule.daysOfWeek[0]]
        : schedule.daysOfWeek.map((day) => dayLabelsShort[day]).join(", ");
  const intervalText =
    schedule.intervalWeeks === 1
      ? t("medications.scheduleEveryWeek")
      : `${t("medications.scheduleEveryNWeeks").replace("{n}", String(schedule.intervalWeeks))}`;
  return `${t("medications.scheduleIntervalPrefix")} ${dayText} - ${intervalText}`;
}

function formatNextWindowSummary(
  schedule: Schedule,
  t: TranslateFn,
  formatShortDate: (date: Date) => string,
  locale: Locale,
): string {
  const isSimpleDaily =
    schedule.daysOfWeek.length === 0 && schedule.intervalWeeks === 1;
  if (isSimpleDaily) {
    return `${t("medications.nextSchedulePrefix")} ${t("medications.nextScheduleDaily")}, ${formatTimeWindowRange(schedule.windowStart, schedule.windowEnd, locale)}`;
  }

  const nextDate = getNextRecurrenceDate(schedule);
  const nextText = nextDate
    ? `${formatShortDate(nextDate)}, ${formatTimeWindowRange(schedule.windowStart, schedule.windowEnd, locale)}`
    : "—";
  return `${t("medications.nextSchedulePrefix")} ${nextText}`;
}

interface Schedule {
  windowStart: string;
  windowEnd: string;
  label: string;
  dose: string;
  daysOfWeek: number[];
  intervalWeeks: number;
  showAdvanced: boolean;
}

interface MedicationFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  /**
   * v1.4.27 R4 RC2 — when the form is mounted inside a
   * `<ResponsiveSheet>` the caller passes the sheet's footer slot
   * element here. The kebab + Cancel + Save row portals into that slot
   * so the bottom-sheet branch can sticky-pin it; the Save button keeps
   * its `<form>` association via the HTML `form` attribute.
   */
  footerSlot?: HTMLElement | null;
  editActions?: {
    onImportIntakes: () => void;
    onApiAccess: () => void;
  };
  initial?: {
    id: string;
    name: string;
    dose: string;
    category: string;
    /** v1.4.25 W4d — Prisma treatment class. Defaults to GENERIC. */
    treatmentClass?: string;
    /** v1.4.25 W4d — only relevant for inventory-tracked meds. */
    dosesPerUnit?: number | null;
    active: boolean;
    notificationsEnabled?: boolean;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string;
      dose: string;
      daysOfWeek?: number[];
      intervalWeeks?: number;
    }>;
  };
}

const DEFAULT_SCHEDULE: Schedule = {
  windowStart: "08:00",
  windowEnd: "09:00",
  label: "",
  dose: "",
  daysOfWeek: [],
  intervalWeeks: 1,
  showAdvanced: false,
};

/** Try to split "400mg" into ["400", "mg"] */
function parseDose(dose: string): { amount: string; unit: string } {
  const match = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(dose.trim());
  if (match) return { amount: match[1], unit: match[2] };
  return { amount: "", unit: dose };
}

function parseTimeToMinutes(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function sortSchedules(list: Schedule[]): Schedule[] {
  return [...list]
    .map((schedule, index) => ({ schedule, index }))
    .sort((a, b) => {
      const aStart = parseTimeToMinutes(a.schedule.windowStart);
      const bStart = parseTimeToMinutes(b.schedule.windowStart);

      if (aStart === null && bStart === null) return a.index - b.index;
      if (aStart === null) return 1;
      if (bStart === null) return -1;
      if (aStart !== bStart) return aStart - bStart;

      const aEnd = parseTimeToMinutes(a.schedule.windowEnd);
      const bEnd = parseTimeToMinutes(b.schedule.windowEnd);
      if (aEnd === null && bEnd === null) return a.index - b.index;
      if (aEnd === null) return 1;
      if (bEnd === null) return -1;
      if (aEnd !== bEnd) return aEnd - bEnd;

      return a.index - b.index;
    })
    .map((item) => item.schedule);
}

export function MedicationForm({
  onSuccess,
  onCancel,
  footerSlot,
  editActions,
  initial,
}: MedicationFormProps) {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();

  // v1.4.27 R4 RC2 — stable form id so the portalled Save button keeps
  // its `<form>` association via the HTML `form` attribute even when
  // DOM-mounted in the `<ResponsiveSheet>` footer slot.
  const formId = useId();

  const doseUnits = [
    "mg",
    "g",
    "ml",
    t("medications.unitDrops"),
    t("medications.unitTablets"),
    t("medications.unitCapsules"),
    t("medications.unitPieces"),
    "IE",
    "µg",
  ];

  const [name, setName] = useState(initial?.name ?? "");

  const initialDose = parseDose(initial?.dose ?? "");
  const [doseAmount, setDoseAmount] = useState(initialDose.amount);
  const [doseUnit, setDoseUnit] = useState(initialDose.unit);

  const [category, setCategory] = useState(initial?.category ?? "OTHER");
  // v1.4.25 W4d — treatment class. GLP1 unlocks the weekly-cadence
  // preset below and the GLP-1 medication-card variant on the medications
  // page. The default GENERIC keeps every existing medication rendering
  // exactly as before.
  const [treatmentClass, setTreatmentClass] = useState(
    initial?.treatmentClass ?? "GENERIC",
  );
  const [dosesPerUnit, setDosesPerUnit] = useState<string>(
    initial?.dosesPerUnit ? String(initial.dosesPerUnit) : "",
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    initial?.notificationsEnabled ?? true,
  );
  const [schedules, setSchedules] = useState<Schedule[]>(
    sortSchedules(
      initial?.schedules?.length
        ? initial.schedules.map((s) => {
            const recurrence = {
              daysOfWeek: s.daysOfWeek ?? [],
              intervalWeeks: s.intervalWeeks ?? 1,
            };
            const hasCustomRecurrence =
              recurrence.daysOfWeek.length > 0 || recurrence.intervalWeeks > 1;
            return {
              ...s,
              daysOfWeek: recurrence.daysOfWeek,
              intervalWeeks: recurrence.intervalWeeks,
              showAdvanced: hasCustomRecurrence,
            };
          })
        : [{ ...DEFAULT_SCHEDULE }],
    ),
  );
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [phaseConfigOpen, setPhaseConfigOpen] = useState(false);

  // v1.4.27 MB3 — link the form-level error banner to every required
  // input via `aria-describedby` so screen readers announce the
  // validation failure on save.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  const isEdit = !!initial;
  const dose = doseAmount
    ? `${doseAmount}${doseUnit ? ` ${doseUnit}` : ""}`
    : doseUnit;

  function updateSchedule(
    index: number,
    field: keyof Schedule,
    value: string | number[] | number | boolean,
  ) {
    setSchedules((prev) =>
      sortSchedules(
        prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
      ),
    );
  }

  function toggleDay(scheduleIndex: number, day: number) {
    setSchedules((prev) =>
      prev.map((s, i) => {
        if (i !== scheduleIndex) return s;
        const days = s.daysOfWeek.includes(day)
          ? s.daysOfWeek.filter((d) => d !== day)
          : [...s.daysOfWeek, day].sort();
        return { ...s, daysOfWeek: days };
      }),
    );
  }

  function addSchedule() {
    setSchedules((prev) => sortSchedules([...prev, { ...DEFAULT_SCHEDULE }]));
  }

  function toggleAdvanced(scheduleIndex: number) {
    setSchedules((prev) =>
      prev.map((s, i) =>
        i === scheduleIndex ? { ...s, showAdvanced: !s.showAdvanced } : s,
      ),
    );
  }

  function removeSchedule(index: number) {
    if (schedules.length <= 1) return;
    setSchedules((prev) => prev.filter((_, i) => i !== index));
  }

  function resetCreateForm() {
    if (isEdit) return;
    setName("");
    setDoseAmount("");
    setDoseUnit("");
    setCategory("OTHER");
    setTreatmentClass("GENERIC");
    setDosesPerUnit("");
    setActive(true);
    setNotificationsEnabled(true);
    setSchedules([{ ...DEFAULT_SCHEDULE }]);
    setError(null);
  }

  /**
   * v1.4.25 W4d — "Once weekly on …" preset. Marc directive
   * 2026-05-14: GLP-1 receptor agonists are weekly meds, and the
   * existing form buries that behind two advanced toggles. The preset
   * collapses the picker to a single weekday button row that writes
   * MedicationSchedule.daysOfWeek correctly and remembers the choice
   * locally so the next weekly med starts on the same weekday.
   *
   * Persisted to localStorage as a one-row preference so the convenience
   * survives across sessions — non-invasive (key is namespaced) and
   * web-only (the iOS surface uses its own picker).
   */
  function applyWeeklyPreset(weekday: number) {
    try {
      localStorage.setItem(
        "medication-form:last-weekly-weekday",
        String(weekday),
      );
    } catch {
      /* private mode — silent */
    }
    setSchedules((prev) =>
      sortSchedules(
        prev.map((s, i) =>
          i === 0
            ? {
                ...s,
                daysOfWeek: [weekday],
                intervalWeeks: 1,
                showAdvanced: true,
              }
            : s,
        ),
      ),
    );
  }

  function readLastWeeklyWeekday(): number {
    try {
      const raw = localStorage.getItem("medication-form:last-weekly-weekday");
      const n = raw === null ? NaN : Number(raw);
      return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 3; // Wednesday default
    } catch {
      return 3;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const url = isEdit ? `/api/medications/${initial.id}` : "/api/medications";
    const method = isEdit ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          dose,
          category,
          treatmentClass,
          ...(dosesPerUnit
            ? { dosesPerUnit: Number(dosesPerUnit) }
            : isEdit
              ? { dosesPerUnit: null }
              : {}),
          ...(isEdit
            ? {
                active,
                ...(notificationsEnabled !==
                  (initial?.notificationsEnabled ?? true) && {
                  notificationsEnabled,
                }),
              }
            : {}),
          schedules: sortSchedules(schedules).map((s) => ({
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            label: s.label || undefined,
            dose: s.dose || undefined,
            daysOfWeek: s.daysOfWeek.length > 0 ? s.daysOfWeek : undefined,
            intervalWeeks: s.intervalWeeks,
          })),
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("common.saved"));
      onSuccess?.();
    } catch {
      setError(t("medications.saveError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!initial) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/medications/${initial.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? t("medications.deleteError"));
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      onSuccess?.();
    } catch {
      setError(t("medications.deleteError"));
    } finally {
      setDeleting(false);
    }
  }

  async function handlePurge() {
    if (!initial) return;
    setError(null);
    setPurging(true);
    try {
      const res = await fetch(`/api/medications/${initial.id}/intake/purge`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? t("medications.purgeError"));
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      setPurgeDialogOpen(false);
    } catch {
      setError(t("medications.purgeError"));
    } finally {
      setPurging(false);
    }
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="med-name">{t("medications.name")}</Label>
        <Input
          id="med-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("medications.namePlaceholder")}
          required
          maxLength={100}
          enterKeyHint="next"
          autoCapitalize="words"
          autoComplete="off"
          aria-required="true"
          aria-invalid={!!error || undefined}
          aria-describedby={errorDescriptor}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="med-category">{t("medications.formType")}</Label>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger id="med-category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="BLOOD_PRESSURE">
              {t("medications.categoryBloodPressure")}
            </SelectItem>
            <SelectItem value="VITAMIN">
              {t("medications.categoryVitamin")}
            </SelectItem>
            <SelectItem value="SUPPLEMENT">
              {t("medications.categorySupplement")}
            </SelectItem>
            <SelectItem value="PAIN_RELIEF">
              {t("medications.categoryPainRelief")}
            </SelectItem>
            <SelectItem value="ALLERGY">
              {t("medications.categoryAllergy")}
            </SelectItem>
            <SelectItem value="DIGESTIVE">
              {t("medications.categoryDigestive")}
            </SelectItem>
            <SelectItem value="THYROID">
              {t("medications.categoryThyroid")}
            </SelectItem>
            <SelectItem value="HORMONE">
              {t("medications.categoryHormone")}
            </SelectItem>
            <SelectItem value="SKIN">
              {t("medications.categorySkin")}
            </SelectItem>
            <SelectItem value="SLEEP_AID">
              {t("medications.categorySleepAid")}
            </SelectItem>
            <SelectItem value="OTHER">
              {t("medications.categoryOther")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* v1.4.25 W4d — treatment-class selector. Surfaces the GLP-1
          option without crowding the existing clinical-category
          dropdown (those are orthogonal taxonomies). GENERIC keeps the
          form rendering exactly as v1.4.24; GLP1 opens the
          weekly-cadence preset + pen-inventory inputs below. */}
      <div className="space-y-1.5">
        <Label htmlFor="med-treatment-class">
          {t("medications.formTreatmentClass")}
        </Label>
        <Select value={treatmentClass} onValueChange={setTreatmentClass}>
          <SelectTrigger id="med-treatment-class" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GENERIC">
              {t("medications.treatmentClassGeneric")}
            </SelectItem>
            <SelectItem value="GLP1">
              {t("medications.treatmentClassGlp1")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs leading-4">
          {t("medications.formTreatmentClassHelp")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="med-dose-amount">{t("medications.formDose")}</Label>
          <Input
            id="med-dose-amount"
            type="text"
            inputMode="decimal"
            value={doseAmount}
            onChange={(e) => setDoseAmount(e.target.value)}
            placeholder={t("medications.dosePlaceholder")}
            required
            maxLength={20}
            enterKeyHint="next"
            autoComplete="off"
            aria-required="true"
            aria-invalid={!!error || undefined}
            aria-describedby={errorDescriptor}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="med-dose-unit">{t("medications.formUnit")}</Label>
          <Input
            id="med-dose-unit"
            list="dose-units"
            value={doseUnit}
            onChange={(e) => setDoseUnit(e.target.value)}
            placeholder="mg"
            maxLength={30}
            className="w-full"
            enterKeyHint="next"
            autoComplete="off"
          />
        </div>
      </div>
      <datalist id="dose-units">
        {doseUnits.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

      {treatmentClass === "GLP1" && (
        <>
          {/* v1.4.25 W4d — once-weekly preset. One tap on a weekday
              writes daysOfWeek=[N] + intervalWeeks=1 into the first
              schedule and reveals the advanced section so the user can
              still tune the window. Persists the last pick across
              sessions for convenience. */}
          <div className="border-border/70 bg-card/60 space-y-2.5 rounded-xl border p-3.5">
            <div className="space-y-1">
              <Label className="text-sm leading-none">
                {t("medications.glp1WeeklyPresetTitle")}
              </Label>
              <p className="text-muted-foreground text-xs leading-4">
                {t("medications.glp1WeeklyPresetHelp")}
              </p>
            </div>
            <div className="flex w-full gap-1">
              {getDayLabelsShort(t).map((label, dayIndex) => {
                const isSelected =
                  schedules[0]?.daysOfWeek.length === 1 &&
                  schedules[0]?.daysOfWeek[0] === dayIndex;
                return (
                  <button
                    key={dayIndex}
                    type="button"
                    onClick={() => applyWeeklyPreset(dayIndex)}
                    className={`h-9 flex-1 rounded-md border text-xs font-medium transition-colors ${
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                    }`}
                    aria-pressed={isSelected}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {!schedules.some((s) => s.daysOfWeek.length === 1) && (
              <button
                type="button"
                onClick={() => applyWeeklyPreset(readLastWeeklyWeekday())}
                className="text-primary text-xs underline-offset-2 hover:underline"
              >
                {t("medications.glp1WeeklyPresetSuggest")}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="med-doses-per-unit">
              {t("medications.glp1DosesPerUnit")}
            </Label>
            <Input
              id="med-doses-per-unit"
              type="number"
              inputMode="numeric"
              enterKeyHint="next"
              min={1}
              max={100}
              value={dosesPerUnit}
              onChange={(e) => setDosesPerUnit(e.target.value)}
              placeholder={t("medications.glp1DosesPerUnitPlaceholder")}
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
            <p className="text-muted-foreground text-xs leading-4">
              {t("medications.glp1DosesPerUnitHelp")}
            </p>
          </div>
        </>
      )}

      <div className="space-y-2">
        <div className="flex h-8 items-center justify-between">
          <Label className="text-sm leading-none">
            {t("medications.formSchedule")}
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={addSchedule}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("medications.newSchedule")}
          </Button>
        </div>

        {schedules.map((s, i) => (
          <div
            key={i}
            className="bg-card border-border/70 rounded-xl border p-3.5"
          >
            <div className="flex items-center justify-between">
              <p className="flex-1 pr-2 pl-1 text-xs leading-5 break-words">
                <span className="font-medium">
                  {s.label.trim() ||
                    `${t("medications.formSchedule")} ${i + 1}`}
                </span>{" "}
                <span className="text-foreground/70 font-normal">
                  ({formatNextWindowSummary(s, t, fmt.dateShort, locale)})
                </span>
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label={t("common.moreOptions")}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => toggleAdvanced(i)}>
                    <Settings2 className="mr-2 h-4 w-4" />
                    {s.showAdvanced
                      ? t("medications.advancedEditingHide")
                      : t("medications.advancedEditing")}
                  </DropdownMenuItem>
                  {schedules.length > 1 && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => removeSchedule(i)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("medications.removeSchedule")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="mt-1 grid items-end gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label className="text-xs font-normal">
                  {t("medications.scheduleFrom")}
                </Label>
                <Input
                  type="time"
                  enterKeyHint="next"
                  placeholder="08:00"
                  value={s.windowStart}
                  // v1.4.27 MB3 — `text-base` on mobile keeps the
                  // schedule time inputs at 16 px, the iOS Safari floor
                  // below which the focus-zoom auto-fires. Desktop
                  // stays compact at `text-xs` because the surrounding
                  // grid carries the small dense rhythm.
                  className="h-11 text-base md:text-xs"
                  onChange={(e) =>
                    updateSchedule(i, "windowStart", e.target.value)
                  }
                  required
                  aria-required="true"
                  aria-invalid={!!error || undefined}
                  aria-describedby={errorDescriptor}
                  maxLength={5}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-normal">
                  {t("medications.scheduleTo")}
                </Label>
                <Input
                  type="time"
                  enterKeyHint="next"
                  placeholder="09:00"
                  value={s.windowEnd}
                  className="h-11 text-base md:text-xs"
                  onChange={(e) =>
                    updateSchedule(i, "windowEnd", e.target.value)
                  }
                  required
                  aria-required="true"
                  aria-invalid={!!error || undefined}
                  aria-describedby={errorDescriptor}
                  maxLength={5}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-normal">
                  {t("medications.scheduleLabel")}
                </Label>
                <Input
                  value={s.label}
                  className="h-11 text-base md:text-xs"
                  onChange={(e) => updateSchedule(i, "label", e.target.value)}
                  placeholder={t("medications.labelPlaceholder")}
                  maxLength={50}
                  enterKeyHint="next"
                  autoCapitalize="sentences"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-normal">
                  {t("medications.dose")}
                </Label>
                <Input
                  value={s.dose}
                  className="h-11 text-base md:text-xs"
                  onChange={(e) => updateSchedule(i, "dose", e.target.value)}
                  placeholder={dose || t("medications.defaultDose")}
                  maxLength={50}
                  enterKeyHint="done"
                  autoComplete="off"
                />
              </div>
            </div>
            {s.showAdvanced && (
              <p className="text-muted-foreground mt-2 pl-1 text-xs leading-4">
                {formatRecurrenceSummary(s, t)}
              </p>
            )}

            {/* Day-of-week selection */}
            {s.showAdvanced && (
              <div className="border-border/60 mt-2.5 space-y-2.5 border-t pt-2.5">
                <div className="space-y-2">
                  <Label className="text-sm">
                    {t("medications.scheduleInterval")}
                  </Label>
                  <div className="grid grid-cols-4 gap-1">
                    {[1, 2, 3, 4].map((weeks) => (
                      <button
                        key={weeks}
                        type="button"
                        onClick={() =>
                          updateSchedule(i, "intervalWeeks", weeks)
                        }
                        className={`min-h-11 rounded-md border text-xs font-medium transition-colors ${
                          s.intervalWeeks === weeks
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/70 bg-muted text-foreground/70 hover:bg-accent hover:text-foreground"
                        }`}
                      >
                        {weeks}W
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">
                    {t("medications.scheduleDays")}
                  </Label>
                  {/* v1.4.27 MB6 CF-4 — the previous single-row
                      `flex w-full gap-1` layout placed the wide
                      "Daily" pill (min-w-24 ≈ 96 px) next to seven
                      weekday pills inside the same row. At 320 px
                      viewport widths the eighth child pushed the row
                      past the form edge and the last weekday clipped
                      off-screen. The new layout stacks the Daily
                      pill above a seven-column grid so each weekday
                      keeps the 44 px tap-target floor without
                      relying on the available width. The grid wraps
                      naturally at any container width because every
                      cell is one explicit grid track. */}
                  <button
                    type="button"
                    onClick={() => updateSchedule(i, "daysOfWeek", [])}
                    className={`block w-full min-h-11 rounded-md border px-3 text-xs font-medium transition-colors ${
                      s.daysOfWeek.length === 0
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/70 bg-muted text-foreground/70 hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    {t("medications.scheduleDaily")}
                  </button>
                  <div className="grid w-full grid-cols-7 gap-1">
                    {getDayLabelsShort(t).map((label, dayIndex) => {
                      const isSelected = s.daysOfWeek.includes(dayIndex);
                      return (
                        <button
                          key={dayIndex}
                          type="button"
                          onClick={() => toggleDay(i, dayIndex)}
                          className={`min-h-11 rounded-md border text-xs font-medium transition-colors ${
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                          }`}
                          title={
                            s.daysOfWeek.includes(dayIndex)
                              ? t("medications.dayDeactivate", { day: label })
                              : t("medications.dayActivate", { day: label })
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {(() => {
        const footerNode = (
          <div className="flex w-full items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11"
                  disabled={loading || deleting}
                  aria-label={t("common.moreOptions")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {isEdit ? (
                  <>
                    {editActions && (
                      <>
                        <DropdownMenuItem onClick={editActions.onImportIntakes}>
                          <Upload className="mr-2 h-4 w-4" />
                          {t("medications.importIntakesAction")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={editActions.onApiAccess}>
                          <Terminal className="mr-2 h-4 w-4" />
                          {t("medications.apiEndpointAction")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setPhaseConfigOpen(true)}
                        >
                          <Clock className="mr-2 h-4 w-4" />
                          {t("medications.phaseConfig")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() => setActive((prev) => !prev)}
                    >
                      {active ? (
                        <Pause className="mr-2 h-4 w-4" />
                      ) : (
                        <Play className="mr-2 h-4 w-4" />
                      )}
                      {active
                        ? t("medications.pause")
                        : t("medications.activate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        setNotificationsEnabled((prev) => !prev)
                      }
                    >
                      {notificationsEnabled ? (
                        <BellOff className="mr-2 h-4 w-4" />
                      ) : (
                        <Bell className="mr-2 h-4 w-4" />
                      )}
                      {notificationsEnabled
                        ? t("medications.disableNotifications")
                        : t("medications.enableNotifications")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setPurgeDialogOpen(true)}
                    >
                      <Eraser className="mr-2 h-4 w-4" />
                      {t("medications.purgeRecords")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("common.delete")}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem onClick={resetCreateForm}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {t("medications.formReset")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              {onCancel && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onCancel}
                  disabled={loading || deleting}
                >
                  {t("common.cancel")}
                </Button>
              )}
              <Button
                type="submit"
                form={formId}
                disabled={loading || deleting}
              >
                {loading && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {isEdit
                  ? t("common.save")
                  : t("medications.createMedication")}
              </Button>
            </div>
          </div>
        );
        return footerSlot ? createPortal(footerNode, footerSlot) : footerNode;
      })()}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.deleteConfirm")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.purgeConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.purgeConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purging}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handlePurge}
              disabled={purging}
            >
              {purging ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("medications.purgeRecords")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isEdit && initial?.id && (
        <PhaseConfigDialog
          medicationId={initial.id}
          open={phaseConfigOpen}
          onOpenChange={setPhaseConfigOpen}
        />
      )}
    </form>
  );
}
