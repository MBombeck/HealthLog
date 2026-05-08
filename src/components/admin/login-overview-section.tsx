"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  ScrollText,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { type AdminAuditEntry } from "./_shared";

export function LoginOverviewSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | "failed">("all");

  const AUTH_ACTION_LABELS: Record<string, string> = {
    "auth.register": t("admin.authRegister"),
    "auth.login": t("admin.authLogin"),
    "auth.login.passkey": t("admin.authLoginPasskey"),
    "auth.login.password": t("admin.authLoginPassword"),
    "auth.login.failed": t("admin.authLoginFailed"),
    "auth.logout": t("admin.authLogout"),
    "auth.passkey.register": t("admin.authPasskeyRegister"),
    "auth.passkey.delete": t("admin.authPasskeyDelete"),
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-log", filter],
    queryFn: async () => {
      const res = await fetch(`/api/admin/audit-log?limit=100&filter=auth`);
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        entries: AdminAuditEntry[];
        meta: { total: number };
      };
    },
    enabled: expanded,
  });

  const entries =
    filter === "failed"
      ? data?.entries.filter((e) => e.action === "auth.login.failed")
      : data?.entries;

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("admin.loginOverview")}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? t("settings.collapse") : t("settings.expand")}
          <ChevronDown
            className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          <div className="flex gap-1">
            <Button
              variant={filter === "all" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setFilter("all")}
            >
              {t("admin.allAuthEvents")}
            </Button>
            <Button
              variant={filter === "failed" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setFilter("failed")}
            >
              {t("admin.failedOnly")}
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : !entries?.length ? (
            <p className="text-muted-foreground text-sm">
              {t("admin.noEntries")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.status")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.users")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.action")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.ip")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.location")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.timestamp")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {entries.map((entry, i) => {
                    const isFailed = entry.action === "auth.login.failed";
                    return (
                      <tr
                        key={entry.id}
                        className={i % 2 === 0 ? "bg-muted/30" : ""}
                      >
                        <td className="px-3 py-2">
                          {isFailed ? (
                            <XCircle className="text-destructive h-4 w-4" />
                          ) : (
                            <CheckCircle2 className="text-dracula-green h-4 w-4" />
                          )}
                        </td>
                        <td
                          className={`px-3 py-2 font-medium ${isFailed ? "text-destructive" : ""}`}
                        >
                          {entry.user?.username ?? t("common.unknown")}
                        </td>
                        <td
                          className={`px-3 py-2 text-xs ${isFailed ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {AUTH_ACTION_LABELS[entry.action] ?? entry.action}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right font-mono text-xs">
                          {entry.ipAddress ?? "—"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs">
                          {entry.location ?? "—"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                          {formatDateTime(entry.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data && data.meta.total > entries.length && (
                <p className="text-muted-foreground mt-3 text-center text-xs">
                  {t("admin.showingEntries", {
                    count: entries.length,
                    total: data.meta.total,
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
