"use client";

/**
 * v1.7.0 — Settings → Export → Health Record export panel.
 *
 * One surface that drives `POST /api/export/health-record`: a format
 * toggle (PDF / FHIR / package) that drives the visible options below it
 * (per the "dropdown drives the form, no top/bottom split" preference),
 * a date-range picker, grouped data-section toggles, and the generate
 * action that streams the artefact as a download.
 *
 * Mood stays default-OFF everywhere (privacy). PDF-only fields (practice
 * name, charts) hide when the format is FHIR. The ePA-compat note shows
 * for the FHIR + package formats.
 */

import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { useTranslations } from "@/lib/i18n/context";

type ExportFormat = "pdf" | "fhir" | "package";

const EXPORT_FORMATS: readonly ExportFormat[] = ["pdf", "fhir", "package"];

interface SectionState {
  weight: boolean;
  bp: boolean;
  pulse: boolean;
  oxygenSaturation: boolean;
  bodyFat: boolean;
  bodyComposition: boolean;
  restingHeartRate: boolean;
  hrv: boolean;
  vo2max: boolean;
  steps: boolean;
  distance: boolean;
  sleep: boolean;
  glucose: boolean;
  medList: boolean;
  compliance: boolean;
  mood: boolean;
  bmi: boolean;
}

const DEFAULT_SECTIONS: SectionState = {
  weight: true,
  bp: true,
  pulse: true,
  oxygenSaturation: true,
  bodyFat: true,
  bodyComposition: false,
  restingHeartRate: false,
  hrv: false,
  vo2max: false,
  steps: false,
  distance: false,
  sleep: false,
  glucose: true,
  medList: true,
  compliance: true,
  mood: false, // privacy default
  bmi: true,
};

function buildSelectionSections(s: SectionState) {
  return {
    vitals: {
      weight: s.weight,
      bp: s.bp,
      pulse: s.pulse,
      oxygenSaturation: s.oxygenSaturation,
      bodyFat: s.bodyFat,
      bodyComposition: s.bodyComposition,
    },
    cardioFitness: {
      restingHeartRate: s.restingHeartRate,
      hrv: s.hrv,
      vo2max: s.vo2max,
    },
    activity: {
      steps: s.steps,
      distance: s.distance,
      sleep: s.sleep,
    },
    glucose: s.glucose,
    medications: { list: s.medList, compliance: s.compliance },
    mood: s.mood,
    bmi: s.bmi,
  };
}

export function HealthRecordExportPanel() {
  const { t, locale } = useTranslations();
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [days, setDays] = useState<number>(90);
  const [practiceName, setPracticeName] = useState("");
  const [includeCharts, setIncludeCharts] = useState(true);
  const [includeAiSummary, setIncludeAiSummary] = useState(false);
  const [sections, setSections] = useState<SectionState>(DEFAULT_SECTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPdfLike = format === "pdf" || format === "package";
  const isFhirLike = format === "fhir" || format === "package";

  const { getRadioProps: getFormatRadioProps } = useRovingRadioGroup({
    count: EXPORT_FORMATS.length,
    selectedIndex: EXPORT_FORMATS.indexOf(format),
    onSelect: (index) => setFormat(EXPORT_FORMATS[index]!),
  });

  function toggle(key: keyof SectionState) {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // The single "Medikamente" control gates the whole medication block
  // (list + compliance) so unchecking it actually excludes all medication
  // data from the export — matching the iOS five-section model.
  function toggleMedications() {
    setSections((prev) => {
      const next = !(prev.medList && prev.compliance);
      return { ...prev, medList: next, compliance: next };
    });
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/export/health-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          format,
          // Carry the active in-app locale so the generated artefact matches
          // the UI language instead of falling back to the browser's
          // Accept-Language header on the server.
          locale,
          range: { days },
          practiceName: practiceName.trim() || undefined,
          includeCharts,
          includeAiSummary,
          sections: buildSelectionSections(sections),
        }),
      });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const blob = await res.blob();
      const ext =
        format === "pdf" ? "pdf" : format === "fhir" ? "json" : "zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `healthlog-health-record-${new Date()
        .toISOString()
        .slice(0, 10)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="health-record-export-title"
      data-testid="health-record-export-panel"
      className="bg-card border-border rounded-xl border p-6"
    >
      <div className="mb-4 flex items-center gap-2">
        <FileText className="text-primary h-5 w-5" aria-hidden="true" />
        <h2 id="health-record-export-title" className="text-lg font-semibold">
          {t("settings.healthRecord.title")}
        </h2>
      </div>
      <p className="text-muted-foreground mb-4 text-sm">
        {t("settings.healthRecord.description")}
      </p>

      <div className="space-y-5">
        {/* Format toggle */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
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
                className="min-h-11 sm:min-h-9"
                onClick={() => setFormat(f)}
                {...getFormatRadioProps(index)}
              >
                {t(`settings.healthRecord.format_${f}`)}
              </Button>
            ))}
          </div>
        </fieldset>

        {/* Date range */}
        <div className="space-y-2">
          <Label htmlFor="hr-range">{t("settings.healthRecord.range")}</Label>
          <NativeSelect
            id="hr-range"
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value="90">{t("settings.healthRecord.range90")}</option>
            <option value="180">{t("settings.healthRecord.range180")}</option>
            <option value="365">{t("settings.healthRecord.range365")}</option>
          </NativeSelect>
        </div>

        {/* Practice name — PDF only */}
        {isPdfLike && (
          <div className="space-y-2">
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

        {/* Section groups */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            {t("settings.healthRecord.includedData")}
          </legend>

          <div className="border-border space-y-2 rounded-lg border p-3">
            <p className="text-xs font-semibold">
              {t("settings.healthRecord.groupVitals")}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow
                label={t("settings.healthRecord.weight")}
                checked={sections.weight}
                onToggle={() => toggle("weight")}
              />
              <ToggleRow
                label={t("settings.healthRecord.bp")}
                checked={sections.bp}
                onToggle={() => toggle("bp")}
              />
              <ToggleRow
                label={t("settings.healthRecord.pulse")}
                checked={sections.pulse}
                onToggle={() => toggle("pulse")}
              />
              <ToggleRow
                label={t("settings.healthRecord.oxygenSaturation")}
                checked={sections.oxygenSaturation}
                onToggle={() => toggle("oxygenSaturation")}
              />
              <ToggleRow
                label={t("settings.healthRecord.bodyFat")}
                checked={sections.bodyFat}
                onToggle={() => toggle("bodyFat")}
              />
              <ToggleRow
                label={t("settings.healthRecord.bodyComposition")}
                checked={sections.bodyComposition}
                onToggle={() => toggle("bodyComposition")}
              />
            </div>
          </div>

          <div className="border-border space-y-2 rounded-lg border p-3">
            <p className="text-xs font-semibold">
              {t("settings.healthRecord.groupCardio")}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow
                label={t("settings.healthRecord.restingHeartRate")}
                checked={sections.restingHeartRate}
                onToggle={() => toggle("restingHeartRate")}
              />
              <ToggleRow
                label={t("settings.healthRecord.hrv")}
                checked={sections.hrv}
                onToggle={() => toggle("hrv")}
              />
              <ToggleRow
                label={t("settings.healthRecord.vo2max")}
                checked={sections.vo2max}
                onToggle={() => toggle("vo2max")}
              />
            </div>
          </div>

          <div className="border-border space-y-2 rounded-lg border p-3">
            <p className="text-xs font-semibold">
              {t("settings.healthRecord.groupActivity")}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow
                label={t("settings.healthRecord.steps")}
                checked={sections.steps}
                onToggle={() => toggle("steps")}
              />
              <ToggleRow
                label={t("settings.healthRecord.distance")}
                checked={sections.distance}
                onToggle={() => toggle("distance")}
              />
              <ToggleRow
                label={t("settings.healthRecord.sleep")}
                checked={sections.sleep}
                onToggle={() => toggle("sleep")}
              />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleRow
              label={t("settings.healthRecord.glucose")}
              checked={sections.glucose}
              onToggle={() => toggle("glucose")}
            />
            <ToggleRow
              label={t("settings.healthRecord.medications")}
              checked={sections.medList && sections.compliance}
              onToggle={toggleMedications}
            />
            <ToggleRow
              label={t("settings.healthRecord.bmi")}
              checked={sections.bmi}
              onToggle={() => toggle("bmi")}
            />
            <ToggleRow
              label={t("settings.healthRecord.mood")}
              checked={sections.mood}
              onToggle={() => toggle("mood")}
            />
          </div>

          {isPdfLike && (
            <ToggleRow
              label={t("settings.healthRecord.includeCharts")}
              checked={includeCharts}
              onToggle={() => setIncludeCharts((v) => !v)}
            />
          )}
          {isPdfLike && (
            <ToggleRow
              label={t("settings.healthRecord.includeAiSummary")}
              checked={includeAiSummary}
              onToggle={() => setIncludeAiSummary((v) => !v)}
            />
          )}
        </fieldset>

        {isFhirLike && (
          <p className="text-muted-foreground text-xs">
            {t("settings.healthRecord.fhirNote")}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="min-h-11 sm:min-h-9"
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {t("settings.healthRecord.generate")}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t("settings.healthRecord.error", { code: error })}
          </p>
        )}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onToggle} />
    </label>
  );
}
