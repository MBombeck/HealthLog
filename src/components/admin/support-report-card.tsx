"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Download, LifeBuoy, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { apiGet } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface SupportReport {
  generatedAt: string;
  text: string;
}

/**
 * Admin, System status: the redacted support report, with copy and download.
 *
 * The report is made on request, not on page load: it reads every account's
 * connection health, which is work an operator only wants when filing a bug.
 * Once made it is shown in full above the actions, so the operator reads what
 * they are about to share.
 */
export function SupportReportCard() {
  const { t } = useTranslations();
  const [copied, setCopied] = useState(false);
  const report = useQuery({
    queryKey: queryKeys.adminSupportReport(),
    queryFn: async () => apiGet<SupportReport>("/api/admin/support-report"),
    enabled: false,
    staleTime: 0,
    gcTime: 5 * 60_000,
  });

  async function load(): Promise<SupportReport | null> {
    const result = await report.refetch();
    if (result.error || !result.data) {
      showErrorToast(t("admin.supportReport.loadError"), {
        cause: result.error,
      });
      return null;
    }
    return result.data;
  }

  async function copy() {
    const data = await load();
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t("admin.supportReport.copy"), data.text);
    }
  }

  async function download() {
    const data = await load();
    if (!data) return;
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `healthlog-support-report-${data.generatedAt.slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const busy = report.isFetching;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={LifeBuoy}
        title={t("admin.supportReport.title")}
        description={t("admin.supportReport.description")}
      />
      <p className="text-sm">{t("admin.supportReport.body")}</p>
      {report.data && (
        <pre
          data-slot="support-report-text"
          className="bg-muted/50 max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
        >
          {report.data.text}
        </pre>
      )}
      <SettingsCardActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copy()}
          disabled={busy}
          aria-live="polite"
        >
          {busy ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied
            ? t("admin.supportReport.copied")
            : t("admin.supportReport.copy")}
        </Button>
        <Button size="sm" onClick={() => void download()} disabled={busy}>
          <Download className="size-4" aria-hidden="true" />
          {t("admin.supportReport.download")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
