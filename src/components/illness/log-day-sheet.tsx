"use client";

/**
 * v1.18.1 — illness day-log sheet. The daily symptom timeline for one
 * episode-day: ~8 Jackson/WURSS symptom chips with a 0–3 severity, a
 * coarse functional-impact chip group (0 = fully functional … 3 =
 * bedbound), an optional fever reading, and an encrypted free-text note.
 *
 * Structurally a fork of the cycle `log-day-sheet`: the shared
 * `ResponsiveSheet` + `SheetSection` primitives, a `Chip`/`SymptomChip`
 * vocabulary, the envelope-aware pre-fill, and the `["illness"]`-prefix
 * invalidation on write. Neutral palette throughout — no alarming colour;
 * status reads via discreet text, never a red tint (the med-card rule
 * generalised).
 */
import { useMemo, useState } from "react";
import { Activity, CalendarDays, NotebookPen, Thermometer } from "lucide-react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SheetSection, SheetSectionCount } from "@/components/ui/sheet-section";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useUnitDisplay } from "@/hooks/use-unit-display";

import { ILLNESS_SYMPTOM_CATALOG } from "./symptom-catalog";
import { useIllnessDayLog, useUpsertDayLog } from "./use-illness";
import type { IllnessDayLogInput } from "./types";

interface LogDaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  episodeId: string;
  /** The day to seed the picker with (usually today). */
  date: string;
  /**
   * Episode onset day (`YYYY-MM-DD`) — the earliest day the picker allows, so
   * a retrospective journal can backdate a day within the episode window
   * (a user ill Sat–Sun who opens Monday can still record either day).
   */
  onsetDate?: string;
}

/** Mini toggle chip — the shared selection vocabulary. */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center rounded-full border px-3 py-1.5 text-sm transition-colors sm:min-h-8",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

/** A symptom chip with an inline 0–3 severity selector once active. */
function SymptomChip({
  label,
  icon: Icon,
  active,
  severity,
  onToggle,
  onSeverity,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  severity: number | null;
  onToggle: () => void;
  onSeverity: (value: number) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-pressed={active}
        onClick={onToggle}
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors sm:min-h-8",
          active
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:bg-muted",
        )}
      >
        <Icon className="h-4 w-4" />
        {label}
      </button>
      {active ? (
        <div
          className="flex gap-1 pl-2"
          role="group"
          aria-label={t("illness.sheet.severityFor", { symptom: label })}
        >
          {[1, 2, 3].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={severity === value}
              onClick={() => onSeverity(value)}
              className={cn(
                "grid h-11 w-11 place-items-center rounded-md border text-xs sm:h-8 sm:w-8",
                severity === value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function LogDaySheet({
  open,
  onOpenChange,
  episodeId,
  date,
  onsetDate,
}: LogDaySheetProps) {
  const { t } = useTranslations();
  // The fever is stored in °C and typed in the reader's temperature unit:
  // seeded through the transform, inverted on save.
  const { toDisplay, fromDisplay, unitFor } = useUnitDisplay();
  const feverUnit = unitFor("BODY_TEMPERATURE");

  // The day being logged — seeded from `date` (today), but the picker lets the
  // user backdate within [onset, today] for the retrospective journal.
  const [selectedDate, setSelectedDate] = useState(date);
  // Re-seed the picker each time the sheet opens (the open transition).
  const [pickerWasOpen, setPickerWasOpen] = useState(false);
  if (open && !pickerWasOpen) {
    setPickerWasOpen(true);
    setSelectedDate(date);
  } else if (!open && pickerWasOpen) {
    setPickerWasOpen(false);
  }

  const dayLog = useIllnessDayLog(open ? episodeId : null, selectedDate);
  const upsert = useUpsertDayLog(episodeId);

  const [symptoms, setSymptoms] = useState<Map<string, number | null>>(
    new Map(),
  );
  const [functionalImpact, setFunctionalImpact] = useState<number | null>(null);
  const [fever, setFever] = useState("");
  const [note, setNote] = useState("");

  // Hydrate the form from the fetched DTO once per (open, date, fetched-row)
  // tuple — React's recommended "adjust state during render keyed on a prop"
  // alternative to a setState-in-effect (the cycle log-day-sheet precedent).
  // `dto === null` (nothing logged) resets to blank.
  const dto = open ? (dayLog.data ?? null) : undefined;
  const formKey = open
    ? `${episodeId}:${selectedDate}:${dayLog.isSuccess ? "loaded" : "loading"}`
    : null;
  const [lastFormKey, setLastFormKey] = useState<string | null>(null);
  if (open && formKey !== lastFormKey && !dayLog.isLoading) {
    setLastFormKey(formKey);
    setSymptoms(
      new Map((dto?.symptoms ?? []).map((s) => [s.key, s.severity ?? null])),
    );
    setFunctionalImpact(dto?.functionalImpact ?? null);
    setFever(
      dto?.feverC != null
        ? String(toDisplay("BODY_TEMPERATURE", dto.feverC))
        : "",
    );
    setNote(dto?.note ?? "");
  } else if (!open && lastFormKey !== null) {
    setLastFormKey(null);
  }

  const symptomCount = symptoms.size;

  function toggleSymptom(key: string) {
    setSymptoms((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, null);
      return next;
    });
  }

  function setSeverity(key: string, value: number) {
    setSymptoms((prev) => {
      const next = new Map(prev);
      next.set(key, prev.get(key) === value ? null : value);
      return next;
    });
  }

  const feverValue = useMemo(() => {
    if (fever.trim() === "") return null;
    const parsed = Number.parseFloat(fever.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }, [fever]);

  async function handleSave() {
    const input: IllnessDayLogInput = {
      date: selectedDate,
      functionalImpact,
      feverC:
        feverValue == null
          ? null
          : Math.round(fromDisplay("BODY_TEMPERATURE", feverValue) * 100) / 100,
      symptoms: Array.from(symptoms.entries()).map(([key, severity]) => ({
        key,
        severity: severity ?? undefined,
      })),
      note: note.trim() === "" ? null : note,
    };
    try {
      await upsert.mutateAsync(input);
      onOpenChange(false);
    } catch {
      // Keep the sheet open; the error strip below reports it.
    }
  }

  const impactLabels = [
    t("illness.impact.0"),
    t("illness.impact.1"),
    t("illness.impact.2"),
    t("illness.impact.3"),
  ];

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("illness.sheet.title", { date: selectedDate })}
      description={t("illness.sheet.description")}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={upsert.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SheetSection
          title={t("illness.sheet.day")}
          icon={<CalendarDays className="h-4 w-4" />}
          summary={
            <span className="text-muted-foreground text-xs">
              {selectedDate}
            </span>
          }
          defaultOpen
        >
          <div className="pt-2">
            <Label htmlFor="illness-log-date" className="sr-only">
              {t("illness.sheet.day")}
            </Label>
            <DateField
              id="illness-log-date"
              value={selectedDate}
              min={onsetDate}
              max={date}
              onChange={(value) => {
                if (value) setSelectedDate(value);
              }}
              className="max-w-44"
            />
          </div>
        </SheetSection>

        <SheetSection
          title={t("illness.sheet.symptoms")}
          icon={<Activity className="h-4 w-4" />}
          summary={<SheetSectionCount count={symptomCount} />}
          defaultOpen
        >
          <div className="flex flex-wrap gap-2 pt-2">
            {ILLNESS_SYMPTOM_CATALOG.map((s) => (
              <SymptomChip
                key={s.key}
                label={t(s.labelKey)}
                icon={s.icon}
                active={symptoms.has(s.key)}
                severity={symptoms.get(s.key) ?? null}
                onToggle={() => toggleSymptom(s.key)}
                onSeverity={(value) => setSeverity(s.key, value)}
              />
            ))}
          </div>
        </SheetSection>

        <SheetSection
          title={t("illness.sheet.functionalImpact")}
          icon={<Activity className="h-4 w-4" />}
          summary={
            functionalImpact != null ? (
              <span className="text-muted-foreground text-xs">
                {impactLabels[functionalImpact]}
              </span>
            ) : null
          }
        >
          <div className="flex flex-wrap gap-2 pt-2">
            {[0, 1, 2, 3].map((value) => (
              <Chip
                key={value}
                active={functionalImpact === value}
                onClick={() =>
                  setFunctionalImpact(functionalImpact === value ? null : value)
                }
              >
                {impactLabels[value]}
              </Chip>
            ))}
          </div>
        </SheetSection>

        <SheetSection
          title={t("illness.sheet.fever")}
          icon={<Thermometer className="h-4 w-4" />}
          summary={
            feverValue != null ? (
              <span className="text-muted-foreground text-xs">
                {feverValue.toFixed(1)} {feverUnit}
              </span>
            ) : null
          }
        >
          <div className="pt-2">
            <Label htmlFor="illness-fever" className="sr-only">
              {t("illness.sheet.fever")}
            </Label>
            <Input
              id="illness-fever"
              inputMode="decimal"
              placeholder={toDisplay("BODY_TEMPERATURE", 37).toFixed(1)}
              value={fever}
              onChange={(e) => setFever(e.target.value)}
              className="max-w-32"
            />
          </div>
        </SheetSection>

        <SheetSection
          title={t("illness.sheet.note")}
          icon={<NotebookPen className="h-4 w-4" />}
          summary={
            note.trim() !== "" ? (
              <span className="text-muted-foreground text-xs">
                {t("illness.sheet.noteSet")}
              </span>
            ) : null
          }
        >
          <div className="pt-2">
            <Textarea
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("illness.sheet.notePlaceholder")}
              rows={4}
            />
          </div>
        </SheetSection>

        {upsert.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("illness.sheet.saveError")}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
