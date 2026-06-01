"use client";

/**
 * v1.7.2 — Data-portability row for the advanced-settings Data group.
 *
 * Co-locates intake Import and Export side by side so the two halves of
 * the "move my data" flow share one visual block instead of import
 * living alone in the sheet while export hides under /settings/export.
 *
 *   - Import: opens the page-owned `<IntakeImportDialog>` via
 *     `onOpenImport`. The dialog parses a JSON intake array.
 *   - Export: downloads `/api/export/medications` as CSV. The
 *     intake-history toggle mirrors the Settings → Export card, so an
 *     operator can grab the medication row plus its full intake log
 *     from the same place they imported it.
 *
 * The download helper spins up an off-DOM anchor — the same pattern the
 * Settings export cards use — so the response stays a same-origin GET
 * and never needs a new endpoint.
 */

import { useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";

export interface DataPortabilityRowProps {
  medicationId: string;
  /** Opens the page-owned `<IntakeImportDialog>`. */
  onOpenImport?: () => void;
}

async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
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

export function DataPortabilityRow({
  medicationId,
  onOpenImport,
}: DataPortabilityRowProps) {
  const { t } = useTranslations();
  const [includeIntake, setIncludeIntake] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        intake: includeIntake ? "true" : "false",
        medicationId,
      }).toString();
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadFromUrl(
        `/api/export/medications?${query}`,
        `healthlog-medication-${stamp}.csv`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="grid gap-4 sm:grid-cols-2"
      data-slot="advanced-data-portability-row"
    >
      {/* Import — JSON intake array */}
      <div
        className="border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-3"
        data-slot="advanced-import-block"
      >
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.advanced.dataPortability.import.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.advanced.dataPortability.import.helper")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenImport?.()}
          className="mt-auto min-h-11 w-full sm:min-h-9"
          data-slot="advanced-import-button"
        >
          <Upload aria-hidden="true" className="h-4 w-4" />
          {t("medications.detail.advanced.dataPortability.import.button")}
        </Button>
      </div>

      {/* Export — medications CSV */}
      <div
        className="border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-3"
        data-slot="advanced-export-block"
      >
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.advanced.dataPortability.export.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.advanced.dataPortability.export.helper")}
          </p>
        </div>
        <label
          htmlFor={`advanced-export-include-intake-${medicationId}`}
          className="flex min-h-11 cursor-pointer items-center gap-2 text-xs sm:min-h-8"
        >
          <Switch
            id={`advanced-export-include-intake-${medicationId}`}
            checked={includeIntake}
            onCheckedChange={setIncludeIntake}
            data-slot="advanced-export-include-intake"
          />
          <span className="text-muted-foreground">
            {t(
              "medications.detail.advanced.dataPortability.export.includeIntake",
            )}
          </span>
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleExport()}
          disabled={busy}
          aria-busy={busy || undefined}
          className="mt-auto min-h-11 w-full sm:min-h-9"
          data-slot="advanced-export-button"
        >
          {busy ? (
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Download aria-hidden="true" className="h-4 w-4" />
          )}
          {t("medications.detail.advanced.dataPortability.export.button")}
        </Button>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
