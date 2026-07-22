"use client";

/**
 * v1.4.16 phase B7 — Settings → Export.
 *
 * Single surface that consolidates every "give me my data out" path in
 * HealthLog. Replaces the old `<ExportCard>` inside `<AdvancedSection>`
 * (CSV/JSON/Doctor-report buttons crammed onto one row) with one card
 * per export type, each with its own filter inputs and a clear
 * "Download" / "Generate" button.
 *
 *   1. Measurements CSV           — optional `since`/`until`
 *   2. Medications CSV            — optional intake-history toggle
 *   3. Mood CSV                   — optional `since`/`until`
 *   4. Full JSON Backup           — single-file user-scoped dump
 *
 * v1.18.0 (S5) — the full health-record export (PDF + FHIR R4 + zip
 * package) moved out to its own top-level "Gesundheitsakte" section. This
 * page now keeps only the generic data export/import paths.
 *
 * Mobile-first: cards stack on `<md`, two-column grid on `>=md`.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarHeart,
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pill,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { cn } from "@/lib/utils";
import { ImportPanel } from "@/components/settings/import-panel";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";

type ExportFormat = "CSV" | "JSON" | "FHIR";

/**
 * Trigger a browser download for a given URL by spinning up an anchor
 * element. Used by every CSV/JSON card so the implementation stays in
 * one place.
 */
async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const res = await apiFetchRaw(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export function ExportSection() {
  const { t } = useTranslations();
  // v1.18.6 (W9) — the visible page heading + subtitle now come from the
  // shared `<SettingsSectionFrame>` in the route; the inner `<h2>` keeps its
  // own "other options" subsection label.
  return (
    <div className="space-y-6">
      {/* v1.18.0 (S5) — the full health-record export moved to its own
          top-level "Gesundheitsakte" section. This page keeps the generic
          CSV/JSON data-out paths and the import surface. */}
      <section
        aria-labelledby="settings-section-export-other-title"
        className="space-y-3"
      >
        <h2
          id="settings-section-export-other-title"
          className="text-base font-semibold tracking-tight"
        >
          {t("settings.sections.export.otherOptionsHeading")}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <MeasurementsCsvCard />
          <MedicationsCsvCard />
          <MoodCsvCard />
          <FullBackupCard />
          {/* R30 — cycle export, gated on cycle tracking being enabled.
              The card mounts only for accounts with cycle data; it reuses
              the health-record FHIR export with the reproductive section
              opted in, so there is no separate backend path. */}
          <CycleExportCard />
        </div>
      </section>

      {/* R28 / issue #281 — the import surface for the Apple Health
          `export.zip` and the generic JSON paths. The export routes had
          backends with no UI until now. */}
      <ImportPanel />
    </div>
  );
}

// ─────────────────────────── Card primitives ───────────────────────────

interface ExportCardShellProps {
  testId: string;
  icon: LucideIcon;
  title: string;
  description: string;
  format: ExportFormat;
  children?: React.ReactNode;
  /** Footer slot — typically the "Download" button + status text. */
  footer: React.ReactNode;
  /** Extra grid-position classes applied to the outer card div. */
  outerClassName?: string;
}

function ExportCardShell({
  testId,
  icon: Icon,
  title,
  description,
  format,
  children,
  footer,
  outerClassName,
}: ExportCardShellProps) {
  return (
    <SettingsCard
      data-testid={testId}
      className={cn("flex h-full flex-col", outerClassName)}
    >
      <SettingsCardHeader
        icon={Icon}
        title={title}
        description={description}
        status={
          <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-medium tracking-wide uppercase">
            {format}
          </span>
        }
      />
      {children && <div className="mt-3 space-y-3">{children}</div>}
      <div className="mt-4 flex flex-wrap items-center gap-3">{footer}</div>
    </SettingsCard>
  );
}

// ─────────────────────────── CSV cards ───────────────────────────

interface DateRangeFieldsProps {
  since: string;
  until: string;
  setSince: (v: string) => void;
  setUntil: (v: string) => void;
  idPrefix: string;
}

function DateRangeFields({
  since,
  until,
  setSince,
  setUntil,
  idPrefix,
}: DateRangeFieldsProps) {
  const { t } = useTranslations();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-since`} className="text-xs">
          {t("settings.sections.export.filters.since")}
        </Label>
        <DateField
          id={`${idPrefix}-since`}
          value={since}
          onChange={setSince}
          max={until || undefined}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-until`} className="text-xs">
          {t("settings.sections.export.filters.until")}
        </Label>
        <DateField
          id={`${idPrefix}-until`}
          value={until}
          onChange={setUntil}
          min={since || undefined}
        />
      </div>
    </div>
  );
}

function buildQueryString(base: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v) params.set(k, v);
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

interface CsvCardProps {
  testId: string;
  actionTestId: string;
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
  endpoint: string;
  filenamePrefix: string;
}

function CsvCard({
  testId,
  actionTestId,
  icon,
  titleKey,
  descriptionKey,
  endpoint,
  filenamePrefix,
}: CsvCardProps) {
  const { t } = useTranslations();
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const query = buildQueryString({
        since: since || undefined,
        until: until || undefined,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `${filenamePrefix}-${stamp}.csv`;
      await downloadFromUrl(`${endpoint}${query}`, filename);
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId={testId}
      icon={icon}
      title={t(titleKey)}
      description={t(descriptionKey)}
      format="CSV"
      footer={
        <Button
          data-testid={actionTestId}
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={handleDownload}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      <DateRangeFields
        idPrefix={testId}
        since={since}
        until={until}
        setSince={setSince}
        setUntil={setUntil}
      />
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}

function MeasurementsCsvCard() {
  return (
    <CsvCard
      testId="export-card-measurements-csv"
      actionTestId="export-action-measurements-csv"
      icon={FileSpreadsheet}
      titleKey="settings.sections.export.cards.measurementsCsv.title"
      descriptionKey="settings.sections.export.cards.measurementsCsv.description"
      endpoint="/api/export/measurements"
      filenamePrefix="healthlog-measurements"
    />
  );
}

function MedicationsCsvCard() {
  // The intake-history toggle is local state on this card — we read it
  // when the user clicks Download and append `&intake=true` to the URL.
  const { t } = useTranslations();
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [includeIntake, setIncludeIntake] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const query = buildQueryString({
        since: since || undefined,
        until: until || undefined,
        intake: includeIntake ? "true" : "false",
      });
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadFromUrl(
        `/api/export/medications${query}`,
        `healthlog-medications-${stamp}.csv`,
      );
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId="export-card-medications-csv"
      icon={Pill}
      title={t("settings.sections.export.cards.medicationsCsv.title")}
      description={t(
        "settings.sections.export.cards.medicationsCsv.description",
      )}
      format="CSV"
      footer={
        <Button
          data-testid="export-action-medications-csv"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={handleDownload}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      <DateRangeFields
        idPrefix="export-medications-csv"
        since={since}
        until={until}
        setSince={setSince}
        setUntil={setUntil}
      />
      <label
        htmlFor="export-medications-include-intake"
        className="flex min-h-11 cursor-pointer items-center gap-3 text-xs"
      >
        <Switch
          id="export-medications-include-intake"
          data-testid="export-medications-include-intake"
          checked={includeIntake}
          onCheckedChange={setIncludeIntake}
        />
        <span className="text-muted-foreground">
          {t("settings.sections.export.cards.medicationsCsv.includeIntake")}
        </span>
      </label>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}

function MoodCsvCard() {
  return (
    <CsvCard
      testId="export-card-mood-csv"
      actionTestId="export-action-mood-csv"
      icon={Waves}
      titleKey="settings.sections.export.cards.moodCsv.title"
      descriptionKey="settings.sections.export.cards.moodCsv.description"
      endpoint="/api/export/mood"
      filenamePrefix="healthlog-mood"
    />
  );
}

const MIN_EXPORT_PASSPHRASE_LENGTH = 12;

function FullBackupCard() {
  const { t } = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v1.23 — opt-in passphrase encryption. When on, the download POSTs to
  // /api/export/encrypted with the passphrase and saves an opaque `.hlx`
  // archive instead of plaintext JSON.
  const [encrypt, setEncrypt] = useState(false);
  const [passphrase, setPassphrase] = useState("");

  const passphraseTooShort =
    encrypt && passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH;

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      if (encrypt) {
        const res = await apiFetchRaw("/api/export/encrypted", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passphrase }),
        });
        if (res.status === 401) {
          setError(t("settings.sections.export.cards.fullBackup.stepUpNeeded"));
          return;
        }
        if (!res.ok) {
          throw new Error(`Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = `healthlog-backup-${stamp}.hlx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      } else {
        await downloadFromUrl(
          "/api/export/full-backup",
          `healthlog-backup-${stamp}.json`,
        );
      }
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId="export-card-full-backup"
      icon={FileJson}
      title={t("settings.sections.export.cards.fullBackup.title")}
      description={t("settings.sections.export.cards.fullBackup.description")}
      format="JSON"
      footer={
        <Button
          data-testid="export-action-full-backup"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={handleDownload}
          disabled={busy || passphraseTooShort}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <FileText className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      {/* v1.28 backup-completeness — the description above lists what's
          included; this line honestly discloses what isn't (document
          binaries, workout GPS/sample series) rather than implying
          "everything" is in the file. Always visible, not gated on the
          encrypt toggle. */}
      <p
        data-testid="export-full-backup-scope-note"
        className="text-muted-foreground text-xs"
      >
        {t("settings.sections.export.cards.fullBackup.scopeNote")}
      </p>
      <label
        htmlFor="export-full-backup-encrypt"
        className="flex min-h-11 cursor-pointer items-center gap-3 text-xs"
      >
        <Switch
          id="export-full-backup-encrypt"
          data-testid="export-full-backup-encrypt"
          checked={encrypt}
          onCheckedChange={(v) => {
            setEncrypt(v);
            setError(null);
            if (!v) setPassphrase("");
          }}
        />
        <span className="text-muted-foreground">
          {t("settings.sections.export.cards.fullBackup.encryptToggle")}
        </span>
      </label>
      {encrypt && (
        <div className="space-y-2">
          <PasswordInput
            data-testid="export-full-backup-passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t(
              "settings.sections.export.cards.fullBackup.passphrasePlaceholder",
            )}
            autoComplete="new-password"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            className="h-9 text-sm"
          />
          <p className="text-muted-foreground text-xs">
            {t("settings.sections.export.cards.fullBackup.passphraseHelp")}
          </p>
          <p className="text-warning text-xs">
            {t("settings.sections.export.cards.fullBackup.noRecoveryWarning")}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}

// ─────────────────────────── Cycle export (gated) ───────────────────────────

/**
 * R30 — cycle / reproductive-health export, GATED on cycle tracking
 * being enabled for the account. A standalone cycle export was removed
 * from the cycle settings in v1.15.4 (it lives in the full backup); this
 * surfaces an explicit, opt-in cycle export here for accounts that track
 * a cycle. It reuses the flagship `/api/export/health-record` route with
 * the reproductive section opted in and every other section off — no
 * separate backend path. The card does not render at all when cycle
 * tracking is off, so a non-cycle account never sees it.
 */
function CycleExportCard() {
  const { t } = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The ungated prefs read tells us whether cycle tracking is enabled
  // without tripping the cycle gate's 403.
  const prefsQuery = useQuery({
    queryKey: queryKeys.cyclePrefs(),
    queryFn: async (): Promise<{ cycleTrackingEnabled: boolean }> => {
      return apiGet<{ cycleTrackingEnabled: boolean }>(
        "/api/auth/me/cycle-prefs",
        { credentials: "include" },
      );
    },
    staleTime: 5 * 60 * 1000,
  });

  // Gate: render nothing until we know cycle is on. A failed/absent read
  // keeps the card hidden (fail-closed) so it never appears spuriously.
  if (prefsQuery.data?.cycleTrackingEnabled !== true) return null;

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchRaw("/api/export/health-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          format: "fhir",
          sections: {
            vitals: {},
            cardioFitness: {},
            activity: {},
            glucose: false,
            medications: {},
            mood: false,
            bmi: false,
            cycle: true,
          },
        }),
      });
      if (!res.ok) {
        setError(t("settings.sections.export.downloadFailed"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `healthlog-cycle-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId="export-card-cycle"
      icon={CalendarHeart}
      title={t("settings.sections.export.cards.cycle.title")}
      description={t("settings.sections.export.cards.cycle.description")}
      format="FHIR"
      footer={
        <Button
          data-testid="export-action-cycle"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={handleGenerate}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}
