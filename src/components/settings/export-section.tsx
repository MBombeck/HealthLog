"use client";

/**
 * Settings → Export & Import.
 *
 * One readable column of two lists. "Import" holds a row per source (see
 * `import-panel/`); "Export" holds a row per way out: the full backup, the
 * measurement, medication and mood CSVs, and the doctor's report, which has a
 * page of its own. A row opens a sheet with that export's options and one
 * Download. UI standards §20: a list is one card per group, a row per item,
 * and a sheet has at most two buttons.
 */

import { useState } from "react";
import {
  Activity,
  Archive,
  FileHeart,
  Loader2,
  Pill,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { PasswordInput } from "@/components/ui/password-input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SwitchRow } from "@/components/ui/switch-row";
import { ImportSources } from "@/components/settings/import-panel";
import {
  SourceIcon,
  useOpenOnAnchor,
} from "@/components/settings/import-panel/import-card-shell";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  recentProofErrorMessage,
  throwIfReproofRequired,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";

/** Where the doctor's report is made. */
const DOCTOR_REPORT_HREF = "/settings/health-record";

/** Save a response body as a file the browser downloads. */
async function saveResponse(res: Response, filename: string): Promise<void> {
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

async function downloadFromUrl(url: string, filename: string): Promise<void> {
  await saveResponse(
    await throwIfReproofRequired(
      await apiFetchRaw(url, { credentials: "include" }),
    ),
    filename,
  );
}

/** Today as a file name stamp. */
function fileStamp(): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp, not a day shown or compared
  return new Date().toISOString().slice(0, 10);
}

export function ExportSection() {
  const { t } = useTranslations();
  return (
    <div className="max-w-180 space-y-8">
      <section
        aria-labelledby="settings-section-import-title"
        className="space-y-3"
      >
        <div className="space-y-1">
          <h2
            id="settings-section-import-title"
            className="text-base font-semibold"
          >
            {t("settings.sections.export.import.heading")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("settings.sections.export.import.description")}
          </p>
        </div>
        <ListGroup data-testid="import-sources">
          <ImportSources />
        </ListGroup>
      </section>

      <section
        aria-labelledby="settings-section-export-title"
        className="space-y-3"
      >
        <h2
          id="settings-section-export-title"
          className="text-base font-semibold"
        >
          {t("settings.sections.export.exportHeading")}
        </h2>
        <ListGroup data-testid="export-rows">
          <FullBackupExport />
          <CsvExport
            kind="measurements"
            anchor="measurements-csv"
            icon={Activity}
            endpoint="/api/export/measurements"
            filenamePrefix="healthlog-measurements"
          />
          <MedicationsCsvExport />
          <CsvExport
            kind="mood"
            anchor="mood-csv"
            icon={Waves}
            endpoint="/api/export/mood"
            filenamePrefix="healthlog-mood"
          />
          <ListItem
            data-testid="export-card-doctor-report"
            icon={<SourceIcon icon={FileHeart} />}
            title={t("settings.sections.export.cards.doctorReport.title")}
            meta={t("settings.sections.export.cards.doctorReport.description")}
            href={DOCTOR_REPORT_HREF}
          />
        </ListGroup>
      </section>
    </div>
  );
}

// ─────────────────────────── Row + sheet ───────────────────────────

/**
 * One export: the row on the page (icon, name, one meta line, chevron) and
 * the sheet with its options. The footer is Close and Download.
 */
function ExportRow({
  testId,
  anchor,
  icon,
  title,
  meta,
  actionTestId,
  busy,
  disabled,
  onDownload,
  onOpenChange,
  open,
  children,
}: {
  testId: string;
  /** Deep-link anchor of the row (`/settings/export#<anchor>`). */
  anchor: string;
  icon: LucideIcon;
  title: string;
  meta: string;
  actionTestId: string;
  busy: boolean;
  disabled?: boolean;
  onDownload: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  useOpenOnAnchor(anchor, () => onOpenChange(true));
  return (
    <>
      <ListItem
        id={anchor}
        className="scroll-mt-28"
        data-testid={testId}
        icon={<SourceIcon icon={icon} />}
        title={title}
        meta={meta}
        onSelect={() => onOpenChange(true)}
      />
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        contentWidth="lg"
        title={title}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.close")}
            </Button>
            <Button
              type="button"
              data-testid={actionTestId}
              onClick={onDownload}
              disabled={busy || disabled}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("settings.sections.export.actions.download")}
            </Button>
          </>
        }
      >
        <div data-testid={`${testId}-sheet`} className="space-y-4">
          {children}
        </div>
      </ResponsiveSheet>
    </>
  );
}

function DateRangeFields({
  since,
  until,
  setSince,
  setUntil,
  idPrefix,
}: {
  since: string;
  until: string;
  setSince: (v: string) => void;
  setUntil: (v: string) => void;
  idPrefix: string;
}) {
  const { t } = useTranslations();
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-since`}>
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
        <Label htmlFor={`${idPrefix}-until`}>
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

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {error}
    </p>
  );
}

/** One download at a time, with the shared failure sentence. */
function useDownload() {
  const { t } = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(
        recentProofErrorMessage(
          err,
          t("settings.sections.export.downloadFailed"),
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

// ─────────────────────────── CSV exports ───────────────────────────

function CsvExport({
  kind,
  anchor,
  icon,
  endpoint,
  filenamePrefix,
}: {
  kind: "measurements" | "mood";
  /** Written out at the call site so the search palette's check finds it. */
  anchor: string;
  icon: LucideIcon;
  endpoint: string;
  filenamePrefix: string;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const download = useDownload();
  // Literal keys, so the i18n call-site guard sees each one.
  const copy =
    kind === "measurements"
      ? {
          title: t("settings.sections.export.cards.measurementsCsv.title"),
          meta: t("settings.sections.export.cards.measurementsCsv.description"),
        }
      : {
          title: t("settings.sections.export.cards.moodCsv.title"),
          meta: t("settings.sections.export.cards.moodCsv.description"),
        };
  return (
    <ExportRow
      testId={`export-card-${kind}-csv`}
      anchor={anchor}
      icon={icon}
      title={copy.title}
      meta={copy.meta}
      actionTestId={`export-action-${kind}-csv`}
      busy={download.busy}
      open={open}
      onOpenChange={setOpen}
      onDownload={() =>
        void download.run(() =>
          downloadFromUrl(
            `${endpoint}${buildQueryString({
              since: since || undefined,
              until: until || undefined,
            })}`,
            `${filenamePrefix}-${fileStamp()}.csv`,
          ),
        )
      }
    >
      <DateRangeFields
        idPrefix={`export-${kind}-csv`}
        since={since}
        until={until}
        setSince={setSince}
        setUntil={setUntil}
      />
      <ErrorLine error={download.error} />
    </ExportRow>
  );
}

function MedicationsCsvExport() {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [includeIntake, setIncludeIntake] = useState(true);
  const download = useDownload();
  return (
    <ExportRow
      testId="export-card-medications-csv"
      anchor="medications-csv"
      icon={Pill}
      title={t("settings.sections.export.cards.medicationsCsv.title")}
      meta={t("settings.sections.export.cards.medicationsCsv.description")}
      actionTestId="export-action-medications-csv"
      busy={download.busy}
      open={open}
      onOpenChange={setOpen}
      onDownload={() =>
        void download.run(() =>
          downloadFromUrl(
            `/api/export/medications${buildQueryString({
              since: since || undefined,
              until: until || undefined,
              intake: includeIntake ? "true" : "false",
            })}`,
            `healthlog-medications-${fileStamp()}.csv`,
          ),
        )
      }
    >
      <DateRangeFields
        idPrefix="export-medications-csv"
        since={since}
        until={until}
        setSince={setSince}
        setUntil={setUntil}
      />
      <SwitchRow
        className="min-h-11"
        label={t("settings.sections.export.cards.medicationsCsv.includeIntake")}
        id="export-medications-include-intake"
        data-testid="export-medications-include-intake"
        checked={includeIntake}
        onCheckedChange={setIncludeIntake}
      />
      <ErrorLine error={download.error} />
    </ExportRow>
  );
}

// ─────────────────────────── Full backup ───────────────────────────

const MIN_EXPORT_PASSPHRASE_LENGTH = 12;

function FullBackupExport() {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const download = useDownload();
  // Opt-in passphrase encryption: the download POSTs to
  // /api/export/encrypted and saves an opaque `.hlx` archive instead of
  // plaintext JSON.
  const [encrypt, setEncrypt] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const passphraseTooShort =
    encrypt && passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH;
  // The whole record leaves the server here, so it asks for a fresh proof
  // unless the session signed in or re-proved within five minutes.
  const recentProof = useRecentProof();

  async function downloadOnce() {
    const stamp = fileStamp();
    if (encrypt) {
      await saveResponse(
        await throwIfReproofRequired(
          await apiFetchRaw("/api/export/encrypted", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passphrase }),
          }),
        ),
        `healthlog-backup-${stamp}.hlx`,
      );
    } else {
      await downloadFromUrl(
        "/api/export/full-backup",
        `healthlog-backup-${stamp}.json`,
      );
    }
  }

  return (
    <ExportRow
      testId="export-card-full-backup"
      anchor="full-backup"
      icon={Archive}
      title={t("settings.sections.export.cards.fullBackup.title")}
      meta={t("settings.sections.export.cards.fullBackup.description")}
      actionTestId="export-action-full-backup"
      busy={download.busy}
      disabled={passphraseTooShort}
      open={open}
      onOpenChange={setOpen}
      onDownload={() => void download.run(() => recentProof.run(downloadOnce))}
    >
      {/* What the file holds and what it leaves out (document binaries,
          workout GPS and sample series), folded under "Learn more". */}
      <Disclosure data-fold summary={t("common.learnMore")}>
        <p className="text-sm">
          {t("settings.sections.export.cards.fullBackup.detail")}
        </p>
        <p
          data-testid="export-full-backup-scope-note"
          className="text-muted-foreground text-xs"
        >
          {t("settings.sections.export.cards.fullBackup.scopeNote")}
        </p>
      </Disclosure>
      <SwitchRow
        className="min-h-11"
        label={t("settings.sections.export.cards.fullBackup.encryptToggle")}
        id="export-full-backup-encrypt"
        data-testid="export-full-backup-encrypt"
        checked={encrypt}
        onCheckedChange={(v) => {
          setEncrypt(v);
          download.setError(null);
          if (!v) setPassphrase("");
        }}
      />
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
            className="h-9"
          />
          <p className="text-muted-foreground text-xs">
            {t("settings.sections.export.cards.fullBackup.passphraseHelp")}
          </p>
          <p className="text-warning text-xs">
            {t("settings.sections.export.cards.fullBackup.noRecoveryWarning")}
          </p>
        </div>
      )}
      <ErrorLine error={download.error} />
      {recentProof.dialog}
    </ExportRow>
  );
}
