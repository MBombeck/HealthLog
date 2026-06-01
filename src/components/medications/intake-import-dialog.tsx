"use client";

/**
 * v1.5.5 D-3 §10 invariant 19 — `IntakeImportDialog` lifted out of
 * `src/app/medications/page.tsx` so the detail-page intake-history
 * header can mount it as the only CSV-import affordance. The list
 * page previously owned the only mount + the per-card kebab triggered
 * `setImportMedId(id)`. v1.5.5 retires the per-card trigger; the
 * detail page is the only surface that opens the dialog, and the
 * intake-history preview owns the trigger so the import lives next to
 * the table it changes.
 *
 * The contract is preserved verbatim from the v1.5.4 list-page copy
 * so the integration test surface stays familiar: open via
 * `medicationId` going non-null, close via `onClose`. The dialog
 * resets every transient piece of state on close so the next open
 * never picks up the previous session's text.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, RotateCcw, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface IntakeImportDialogProps {
  medicationId: string | null;
  onClose: () => void;
}

export function IntakeImportDialog({
  medicationId,
  onClose,
}: IntakeImportDialogProps) {
  const { t } = useTranslations();
  const [jsonText, setJsonText] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultType, setResultType] = useState<"success" | "error" | null>(
    null,
  );
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const queryClient = useQueryClient();

  function resetImportForm() {
    setJsonText("");
    setResult(null);
    setResultType(null);
    setSelectedFileName(null);
    setFileInputKey((prev) => prev + 1);
  }

  function handleClose() {
    resetImportForm();
    onClose();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setResult(null);
    setResultType(null);

    try {
      const content = await file.text();
      JSON.parse(content);
      setJsonText(content);
      setSelectedFileName(file.name);
      setResult(t("medications.importFileLoaded", { name: file.name }));
      setResultType("success");
    } catch {
      setResult(t("medications.importInvalidJson"));
      setResultType("error");
    }
  }

  async function handleImport() {
    if (!medicationId || !jsonText.trim()) return;
    setImporting(true);
    setResult(null);
    setResultType(null);

    try {
      let data = JSON.parse(jsonText.trim());
      // Support both array and object-with-array
      if (!Array.isArray(data)) {
        const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]));
        if (arrKey) data = data[arrKey];
        else throw new Error(t("medications.importNoArray"));
      }

      const res = await fetch(
        `/api/medications/${medicationId}/intake/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );

      const json = await res.json();
      if (res.ok) {
        const d = json.data;
        setResult(
          t("medications.importResult", { imported: d.imported }) +
            (d.skippedDuplicates > 0
              ? `, ${t("medications.importDuplicatesSkipped", { count: d.skippedDuplicates })}`
              : "") +
            (d.skippedInvalid > 0
              ? `, ${t("medications.importInvalidSkipped", { count: d.skippedInvalid })}`
              : ""),
        );
        setResultType("success");
        void invalidateKeys(queryClient, medicationDependentKeys);
      } else {
        setResult(json.error || t("medications.importFailed"));
        setResultType("error");
      }
    } catch (err) {
      setResult(
        err instanceof SyntaxError
          ? t("medications.importInvalidFormat")
          : (err as Error).message || t("medications.importFailed"),
      );
      setResultType("error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={!!medicationId} onOpenChange={() => handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("medications.importIntakes")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {t("medications.importDescription")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="intake-import-file" className="text-xs font-medium">
              {t("medications.importUploadFile")}
            </Label>
            <input
              key={fileInputKey}
              id="intake-import-file"
              type="file"
              accept="application/json,.json"
              onChange={handleFileSelect}
              className="border-input bg-background text-foreground file:bg-muted file:text-foreground w-full cursor-pointer rounded-md border text-sm file:mr-2 file:border-0 file:px-3 file:py-2"
            />
            {selectedFileName && (
              <p className="text-muted-foreground text-xs">
                {t("medications.importSelected", { name: selectedFileName })}
              </p>
            )}
          </div>
          <pre className="bg-muted text-muted-foreground rounded-lg p-3 text-xs">
            {`[
  {"datum": "2026-02-14", "uhrzeit": "10:27:43", "zaehler": 523},
  {"datum": "2026-02-14", "uhrzeit": "23:33:42", "zaehler": 524}
]`}
          </pre>
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder={t("medications.importPaste")}
            rows={8}
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
          {result && (
            <p
              className={`text-sm ${resultType === "success" ? "text-dracula-green" : "text-destructive"}`}
              role="status"
              aria-live="polite"
            >
              {result}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  disabled={importing}
                  aria-label={t("common.moreOptions")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={resetImportForm}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t("common.reset")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={importing}
                className="min-h-11 sm:min-h-9"
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleImport}
                disabled={importing || !jsonText.trim()}
                aria-busy={importing || undefined}
                className="min-h-11 sm:min-h-9"
              >
                {importing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {t("common.import")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
