"use client";

/**
 * The status rows of the Antigravity settings card. Each row states what the
 * CLI or the last test reported. None of them is the result of a write.
 */
import { CheckCircle2, XCircle } from "lucide-react";

import type { AntigravityStatusResponse } from "@/app/api/antigravity/status/route";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

export function CliInstallRow({
  installed,
  version,
}: {
  installed: boolean;
  version: string | null;
}) {
  const { t } = useTranslations();

  return (
    <div className="flex items-center space-x-2">
      {installed ? (
        <CheckCircle2 className="text-success h-5 w-5" />
      ) : (
        <XCircle className="text-destructive h-5 w-5" />
      )}
      <div>
        <p className="font-medium">
          {t("settings.ai.antigravity.cliInstallation")}
        </p>
        <p className="text-muted-foreground text-sm">
          {installed
            ? t("settings.ai.antigravity.cliVersion", {
                version: version ?? t("common.unknown"),
              })
            : t("settings.ai.antigravity.cliNotFound")}
        </p>
      </div>
    </div>
  );
}

export function ConnectionStateRow({
  connection,
  connectedAt,
}: {
  connection: AntigravityStatusResponse["connectionStatus"];
  connectedAt: string | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const info = (
    {
      disconnected: {
        label: t("settings.ai.antigravity.statusDisconnected"),
        color: "text-muted-foreground",
      },
      connected: {
        label: t("settings.ai.antigravity.statusConnected"),
        color: "text-success",
      },
      auth_required: {
        label: t("settings.ai.antigravity.statusAuthRequired"),
        color: "text-warning",
      },
      error: {
        label: t("settings.ai.antigravity.statusError"),
        color: "text-destructive",
      },
    } as Record<string, { label: string; color: string }>
  )[connection] ?? { label: connection, color: "text-muted-foreground" };

  return (
    <div>
      <p className="font-medium">
        {t("settings.ai.antigravity.connectionStatus")}
      </p>
      <p className={`text-sm ${info.color}`}>{info.label}</p>
      {connectedAt && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.antigravity.connectedAt", {
            when: fmt.dateTime(new Date(connectedAt)),
          })}
        </p>
      )}
    </div>
  );
}
