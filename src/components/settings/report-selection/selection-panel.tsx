"use client";

/**
 * Settings → Export → the health-record export panel.
 *
 * One surface driving `POST /api/export/health-record`: a format radio, the
 * reporting window, the practice line, the scope picker, and the generate
 * action that streams the artefact as a download.
 *
 * Three states, by design:
 *
 *   1. First run (no saved selection): NOTHING is selected. The picker opens
 *      expanded so the standard-report button and the empty fenced tier are
 *      both in view, and Generate is disabled until something is ticked. One
 *      click on that button still produces a complete doctor's report, so the
 *      fast path costs one interaction, not a scope nobody chose.
 *   2. Repeat run: the picker is collapsed behind its disclosure, the saved
 *      selection is loaded, and the scope line under the button says what will
 *      be in the document. Two interactions after navigation, and the reading
 *      is the consent check.
 *   3. Editing: a group row is one control for up to sixteen leaves; the leaf
 *      grid opens only when the scope actually changes, which is rare.
 *
 * The saved selection seeds per-user during render with a stored-id guard —
 * `useAuth` resolves asynchronously, so a `useState` initialiser would read
 * `undefined` and stick — and the per-user gate means a late re-resolve never
 * clobbers edits the user is in the middle of.
 */
import { isCalendarDateKey } from "@/lib/tz/date-only";
import Link from "next/link";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  Loader2,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ReportVisitOffer } from "./report-visit-offer";
import { Switch } from "@/components/ui/switch";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  recentProofErrorMessage,
  throwIfReproofRequired,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";
import {
  parseSavedProfile,
  SAVED_PROFILE_FALLBACK,
} from "@/lib/report-selection/profile-shape";
import { orderLeaves } from "@/lib/report-selection/selection";

import { ReportScopePicker } from "./report-scope-picker";
import { ScopeSummary } from "./scope-summary";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import {
  DEFAULT_TIMEZONE,
  detectBrowserTimezone,
  shiftDateKey,
  validTimezoneOr,
} from "@/lib/tz/format";

type ExportFormat = "pdf" | "fhir" | "package";

const EXPORT_FORMATS: readonly ExportFormat[] = ["pdf", "fhir", "package"];
const PRESET_RANGES = [30, 90, 180, 365] as const;

/**
 * The custom window a link into the panel asks for, when both ends are
 * calendar dates in order. Anything else opens the panel as usual.
 */
export function readLinkedReportRange(): { from: string; to: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const from = params.get("reportFrom");
  const to = params.get("reportTo");
  if (!from || !to || !isCalendarDateKey(from) || !isCalendarDateKey(to)) {
    return null;
  }
  return from <= to ? { from, to } : null;
}

/** A refusal already worded for the panel; shown as it is. */
class ReportRequestError extends Error {}

export function HealthRecordExportPanel() {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  // The report reads its window in the profile zone (the server's
  // `reportTz`), so the picked days are cut there too.
  const reportTz = validTimezoneOr(
    user?.timezone ?? detectBrowserTimezone(),
    DEFAULT_TIMEZONE,
  );
  const queryClient = useQueryClient();

  const [format, setFormat] = useState<ExportFormat>(
    SAVED_PROFILE_FALLBACK.format,
  );
  const [days, setDays] = useState<number>(SAVED_PROFILE_FALLBACK.rangeDays);
  // v1.42 — `?reportFrom=&reportTo=` (the visit preparation's "Doctor
  // report for this period") opens the panel on that custom window. Read
  // once, on the first client render; the person can change it from there.
  const [linkedRange] = useState(readLinkedReportRange);
  const [customRange, setCustomRange] = useState(linkedRange !== null);
  const [startDate, setStartDate] = useState(linkedRange?.from ?? "");
  const [endDate, setEndDate] = useState(linkedRange?.to ?? "");
  const [practiceName, setPracticeName] = useState("");
  const [includeCharts, setIncludeCharts] = useState<boolean>(
    SAVED_PROFILE_FALLBACK.includeCharts,
  );
  // Empty until a human ticks something. There is no default selection to get
  // wrong, because there is no default selection.
  const [selected, setSelected] = useState<ReadonlySet<ReportLeafId>>(
    () => new Set<ReportLeafId>(),
  );
  const [seededUserId, setSeededUserId] = useState<string | null>(null);
  // A first run opens the picker: with nothing selected, the standard-report
  // button and the empty groups are the two things the person needs to see.
  const [pickerOpen, setPickerOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerPanelId = useId();
  const scopeSummaryId = useId();

  if (user && user.id !== seededUserId) {
    setSeededUserId(user.id);
    setPracticeName(user.lastReportPracticeName ?? "");
    const saved = parseSavedProfile(user.reportSelection);
    if (saved) {
      setSelected(new Set(saved.leaves as ReportLeafId[]));
      setFormat(saved.format);
      setDays(saved.rangeDays);
      setIncludeCharts(saved.includeCharts);
      setPickerOpen(false);
    }
  }

  const isPdfLike = format === "pdf" || format === "package";
  const isFhirLike = format === "fhir" || format === "package";

  const { getRadioProps: getFormatRadioProps } = useRovingRadioGroup({
    count: EXPORT_FORMATS.length,
    selectedIndex: EXPORT_FORMATS.indexOf(format),
    onSelect: (index) => setFormat(EXPORT_FORMATS[index]!),
  });

  // The report is built from the whole record, so it asks for a fresh proof
  // unless the session signed in or re-proved within five minutes.
  const recentProof = useRecentProof();

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      await recentProof.run(generateOnce);
    } catch (err) {
      if (err instanceof ReportRequestError) {
        setError(err.message);
        return;
      }
      const message = recentProofErrorMessage(
        err,
        err instanceof Error ? err.message : String(err),
      );
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function generateOnce() {
    const range =
      customRange && startDate && endDate
        ? {
            // The picked days are the user's days: from the first instant
            // of the first to the last instant of the last, in their zone.
            // UTC midnight started the window the previous evening west of
            // UTC, and the report read it as one day more.
            startDate: startOfLocalDayKey(startDate, reportTz).toISOString(),
            endDate: new Date(
              startOfLocalDayKey(shiftDateKey(endDate, 1), reportTz).getTime() -
                1,
            ).toISOString(),
          }
        : { days };
    const res = await throwIfReproofRequired(
      await apiFetchRaw("/api/export/health-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          format,
          // Carry the active in-app locale so the artefact matches the UI
          // language instead of falling back to Accept-Language on the server.
          locale,
          range,
          practiceName: practiceName.trim() || undefined,
          includeCharts,
          selection: { v: 2, leaves: orderLeaves(selected) },
        }),
      }),
    );
    if (!res.ok) {
      throw new ReportRequestError(
        res.status === 429
          ? t("settings.healthRecord.errorRateLimit")
          : res.status === 403
            ? t("settings.healthRecord.errorModuleDisabled")
            : t("settings.healthRecord.errorGeneric"),
      );
    }
    const blob = await res.blob();
    const ext = format === "pdf" ? "pdf" : format === "fhir" ? "json" : "zip";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp, not a day shown or compared
    a.download = `healthlog-health-record-${new Date()
      .toISOString()
      .slice(0, 10)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    // The route just persisted the practice name and the selection, so the
    // cached `/me` payload is stale. Refresh it, or a remount would seed from
    // the previous values.
    void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="health-record-export-title"
      data-testid="health-record-export-panel"
    >
      <SettingsCardHeader
        icon={FileText}
        titleId="health-record-export-title"
        title={t("settings.healthRecord.title")}
        description={t("settings.healthRecord.description")}
      />

      <div className="space-y-4">
        {/* Format + range share a row on desktop; on mobile they stack. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium">
              {t("settings.healthRecord.format")}
            </legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {EXPORT_FORMATS.map((f, index) => (
                <Button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  variant={format === f ? "default" : "outline"}
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => setFormat(f)}
                  {...getFormatRadioProps(index)}
                >
                  {t(`settings.healthRecord.format_${f}`)}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="hr-range">{t("settings.healthRecord.range")}</Label>
            <NativeSelect
              id="hr-range"
              value={customRange ? "custom" : String(days)}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  setCustomRange(true);
                  return;
                }
                setCustomRange(false);
                setDays(Number(e.target.value));
              }}
            >
              {PRESET_RANGES.map((preset) => (
                <option key={preset} value={String(preset)}>
                  {t(`settings.healthRecord.range${preset}`)}
                </option>
              ))}
              <option value="custom">
                {t("settings.healthRecord.rangeCustom")}
              </option>
            </NativeSelect>
            {/* Entry point into the document vault for the report period
                (navigation only). Only rendered when the module is enabled. */}
            {user?.modules?.inboundDocuments ? (
              <Link
                href={`/documents?year=${new Date().getFullYear()}`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md text-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <FolderOpen className="size-3.5" aria-hidden />
                {t("settings.healthRecord.documentsLink")}
              </Link>
            ) : null}
          </div>
        </div>

        {/* Never auto-applies: pressing it is what opens the custom window and
            sets its end date. */}
        <ReportVisitOffer
          onUseVisitDate={(endDay) => {
            setCustomRange(true);
            setEndDate(endDay);
          }}
        />

        {customRange ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hr-range-start">
                {t("settings.healthRecord.rangeCustomStart")}
              </Label>
              <DateField
                id="hr-range-start"
                value={startDate}
                onChange={setStartDate}
                max={endDate || undefined}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hr-range-end">
                {t("settings.healthRecord.rangeCustomEnd")}
              </Label>
              <DateField
                id="hr-range-end"
                value={endDate}
                onChange={setEndDate}
                min={startDate || undefined}
              />
            </div>
          </div>
        ) : null}

        {/* Practice name — PDF only */}
        {isPdfLike && (
          <div className="space-y-1.5">
            <Label htmlFor="hr-practice">
              {t("settings.healthRecord.practiceName")}
            </Label>
            <Input
              id="hr-practice"
              value={practiceName}
              onChange={(e) => setPracticeName(e.target.value)}
              maxLength={120}
              placeholder={t("settings.healthRecord.practiceNamePlaceholder")}
            />
          </div>
        )}

        <fieldset className="space-y-3">
          <legend className="sr-only">
            {t("settings.healthRecord.includedData")}
          </legend>
          <button
            type="button"
            data-testid="health-record-included-data-toggle"
            aria-expanded={pickerOpen}
            aria-controls={pickerPanelId}
            onClick={() => setPickerOpen((v) => !v)}
            className="text-foreground hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span>{t("settings.healthRecord.includedData")}</span>
            <ChevronDown
              className={cn(
                "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
                pickerOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>

          {pickerOpen && (
            <div
              id={pickerPanelId}
              data-testid="health-record-included-data-panel"
              className="animate-insight-in space-y-3"
              style={{ animationDuration: "200ms" }}
            >
              <ReportScopePicker
                surface="export"
                selected={selected}
                onChange={setSelected}
              />
              {isPdfLike ? (
                <label className="flex min-h-11 items-center justify-between gap-3 text-sm sm:min-h-9">
                  <span className="text-foreground">
                    {t("settings.healthRecord.includeCharts")}
                  </span>
                  <Switch
                    checked={includeCharts}
                    onCheckedChange={() => setIncludeCharts((v) => !v)}
                  />
                </label>
              ) : null}
            </div>
          )}
        </fieldset>

        {/* The FHIR note and the generate action share the footer row. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <ScopeSummary
              t={t}
              id={scopeSummaryId}
              surface="export"
              selected={selected}
            />
            {isFhirLike ? (
              <p className="text-muted-foreground max-w-md text-xs">
                {t("settings.healthRecord.fhirNote")}
              </p>
            ) : null}
          </div>
          {/* An empty scope cannot be generated: there is no document to make.
              The scope line beside the button carries the reason and the way
              out of it, and describes the button so the disabled state is not
              silent for a screen reader. */}
          <Button
            type="button"
            onClick={handleGenerate}
            disabled={busy || selected.size === 0}
            aria-describedby={scopeSummaryId}
            data-testid="health-record-generate"
            className="ml-auto min-h-11 shrink-0 sm:min-h-9"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t("settings.healthRecord.generate")}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      {recentProof.dialog}
    </SettingsCard>
  );
}
