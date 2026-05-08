"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

export function AdvancedSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-advanced-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-advanced-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.advanced.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.advanced.description")}
        </p>
      </header>

      <ExportCard />
      <DataResetCard />
    </section>
  );
}

function ExportCard() {
  const { t, locale } = useTranslations();
  const [exporting, setExporting] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);

  async function handleExport(format: "csv" | "json") {
    setExporting(true);
    try {
      const res = await fetch(`/api/export?format=${format}&type=all`);
      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `healthlog-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function handleDoctorReport() {
    setGeneratingReport(true);
    try {
      const res = await fetch("/api/doctor-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 90 }),
      });
      if (!res.ok) return;
      const json = await res.json();

      const { generateDoctorReportPDF } =
        await import("@/lib/doctor-report-pdf");
      const doc = generateDoctorReportPDF(json.data, { t, locale });
      const fileSlug = locale === "de" ? "gesundheitsbericht" : "health-report";
      doc.save(`${fileSlug}-${new Date().toISOString().slice(0, 10)}.pdf`);
    } finally {
      setGeneratingReport(false);
    }
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Download className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("settings.export")}</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.exportDescription")}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleExport("json")}
          disabled={exporting}
        >
          {exporting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t("settings.exportJson")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleExport("csv")}
          disabled={exporting}
        >
          {exporting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t("settings.exportCsv")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDoctorReport}
          disabled={generatingReport}
        >
          {generatingReport && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          )}
          {t("settings.doctorReport")}
        </Button>
      </div>
    </div>
  );
}

function DataResetCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  async function handleDeleteAllData() {
    setDeleting(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await fetch("/api/settings/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || t("settings.dangerZoneDeleteFailed"));
        setMsgType("error");
        return;
      }

      await queryClient.invalidateQueries();
      setMsg(t("settings.dangerZoneSuccess"));
      setMsgType("success");
    } catch {
      setMsg(t("settings.dangerZoneDeleteFailed"));
      setMsgType("error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-5 w-5" />
        <h2 className="text-destructive text-lg font-semibold">
          {t("settings.dangerZone")}
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.dangerZoneDescription")}
      </p>

      <div className="mt-4">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={deleting}>
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.dangerZone")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.dangerZoneConfirm")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.dangerZoneConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={handleDeleteAllData}
              >
                {t("settings.finalDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {msg && (
        <p
          role="alert"
          className={`mt-3 text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
