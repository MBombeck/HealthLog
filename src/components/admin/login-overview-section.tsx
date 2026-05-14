"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  Loader2,
  MapPin,
  ScrollText,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { toCSV } from "@/lib/export";
import { formatInUserTz, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { useAuth } from "@/hooks/use-auth";
import {
  type AdminAuditEntry,
  auditLogCsvHeaderLabels,
  buildAuditLogCsvRecords,
  iconForAuthProvider,
  providerForAction,
  useAuthActionLabels,
  useAuthProviderLabels,
} from "./_shared";

type DateRangePreset = "all" | "24h" | "7d" | "30d";
type PerPageValue = 25 | 50 | 100;

const PER_PAGE_OPTIONS: PerPageValue[] = [25, 50, 100];

interface AuditLogResponse {
  entries: AdminAuditEntry[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    page: number;
    perPage: number;
  };
}

function rangeToSince(range: DateRangePreset): string | undefined {
  if (range === "all") return undefined;
  const now = Date.now();
  const ms = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return new Date(now - ms * 60 * 60 * 1000).toISOString();
}

export function LoginOverviewSection() {
  const { t } = useTranslations();
  const { user } = useAuth();
  // v1.4.25 W7 — every CSV-emitted timestamp uses the admin's display
  // timezone so the resulting `2026-05-11T11:05:00+02:00` cell stays
  // legible after Excel/LibreOffice strip the `Z` suffix from the
  // legacy UTC export.
  const userTz = user?.timezone ?? DEFAULT_TIMEZONE;

  // v1.4.25 W8b — the section used to wrap its body in a
  // collapse/expand toggle. Since v1.5 phase-4b moved this to a
  // dedicated `/admin/login-overview` route (the only thing on the
  // page), the toggle was pure clutter: visiting the page already
  // signals intent to see the audit log. The toggle is gone; content
  // always renders. The `settings.collapse` / `settings.expand`
  // i18n keys are retained centrally for any future surface.

  // Quick-filter pill (kept from the v1.4.x UI for one-tap "show failed").
  const [filter, setFilter] = useState<"all" | "failed">("all");

  // v1.4.16 phase B4 — deeper filter/pagination/export.
  const [actor, setActor] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [target, setTarget] = useState("");
  const [range, setRange] = useState<DateRangePreset>("7d");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<PerPageValue>(50);

  const AUTH_ACTION_LABELS = useAuthActionLabels();
  const AUTH_PROVIDER_LABELS = useAuthProviderLabels();

  // Build the query string once so it's reused by the data-query key, the
  // export download, and the next-/prev- buttons.
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("perPage", String(perPage));
    // F-02 (v1.4.19): The page is the auth/admin "Login Overview" — restrict
    // to `auth.*` actions so insights/admin/data events don't leak into the
    // viewer (the previous behaviour rendered rows like
    // `insights.weight-status.en` next to "Passkey login"). When the user
    // picks a specific action below we trust their explicit choice and let
    // it overwrite this default.
    params.set("filter", "auth");
    if (actor.trim()) params.set("actor", actor.trim());
    if (actionFilter && actionFilter !== "__all__") {
      params.set("action", actionFilter);
    }
    if (target.trim()) params.set("target", target.trim());
    const since = rangeToSince(range);
    if (since) params.set("since", since);
    return params;
  }, [page, perPage, actor, actionFilter, target, range]);

  const { data, isLoading } = useQuery({
    queryKey: [
      "admin",
      "audit-log",
      "filtered",
      filter,
      page,
      perPage,
      actor,
      actionFilter,
      target,
      range,
    ],
    queryFn: async () => {
      const params = new URLSearchParams(queryParams);
      // Quick-filter pill stacks on top of the new filters.
      if (filter === "failed") {
        params.set("action", "auth.login.failed");
      }
      const res = await fetch(`/api/admin/audit-log?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AuditLogResponse;
    },
  });

  // Distinct actions for the dropdown — populated lazily.
  const { data: actionsData } = useQuery({
    queryKey: ["admin", "audit-log", "actions"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit-log/actions");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as { actions: string[] };
    },
    staleTime: 5 * 60_000,
  });

  const entries = data?.entries ?? [];
  const total = data?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / perPage));

  function downloadCsv() {
    if (entries.length === 0) return;
    const labels = {
      timestamp: t("admin.timestamp"),
      user: t("admin.users"),
      ip: t("admin.ip"),
      location: t("admin.location"),
      provider: t("admin.provider"),
      outcome: t("admin.outcome"),
      action: t("admin.action"),
      details: t("admin.auditDetails"),
      outcomeFailed: t("admin.outcomeFailed"),
      outcomeSuccess: t("admin.outcomeSuccess"),
      unknownUser: t("common.unknown"),
      providerLabels: AUTH_PROVIDER_LABELS,
    };
    const records = buildAuditLogCsvRecords(entries, labels, (iso) =>
      formatInUserTz(new Date(iso), userTz, "iso-with-offset"),
    );
    const csv = toCSV(records, auditLogCsvHeaderLabels(labels));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    a.download = `healthlog-audit-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function resetPageOnFilterChange<T>(setter: (v: T) => void): (v: T) => void {
    return (v) => {
      setPage(1);
      setter(v);
    };
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <ScrollText className="text-primary h-5 w-5" />
        <div className="text-lg font-semibold">{t("admin.loginOverview")}</div>
      </div>

      <div className="mt-4 space-y-3">
        {/* Quick-filter pills. Failed-only is the most common
              admin "is something wrong" question — keep the one-tap shortcut. */}
        <div className="flex gap-1">
          <Button
            variant={filter === "all" ? "default" : "ghost"}
            size="sm"
            className="min-h-11 min-w-11 px-3 text-xs"
            onClick={resetPageOnFilterChange(() => setFilter("all"))}
          >
            {t("admin.allAuthEvents")}
          </Button>
          <Button
            variant={filter === "failed" ? "default" : "ghost"}
            size="sm"
            className="min-h-11 min-w-11 px-3 text-xs"
            onClick={resetPageOnFilterChange(() => setFilter("failed"))}
          >
            {t("admin.failedOnly")}
          </Button>
        </div>

        {/* Detailed filter row */}
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          <Input
            type="search"
            placeholder={t("admin.section.auditLog.filterActor")}
            value={actor}
            onChange={(e) => {
              setPage(1);
              setActor(e.target.value);
            }}
            aria-label={t("admin.section.auditLog.filterActor")}
          />
          <Select
            value={actionFilter || "__all__"}
            onValueChange={(v) => {
              setPage(1);
              setActionFilter(v === "__all__" ? "" : v);
            }}
          >
            <SelectTrigger
              aria-label={t("admin.section.auditLog.filterAction")}
            >
              <SelectValue
                placeholder={t("admin.section.auditLog.filterAction")}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">
                {t("admin.section.auditLog.filterActionAll")}
              </SelectItem>
              {(actionsData?.actions ?? [])
                .filter((a) => a.startsWith("auth."))
                .map((a) => (
                  <SelectItem key={a} value={a}>
                    {AUTH_ACTION_LABELS[a] ?? a}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Input
            type="search"
            placeholder={t("admin.section.auditLog.filterTarget")}
            value={target}
            onChange={(e) => {
              setPage(1);
              setTarget(e.target.value);
            }}
            aria-label={t("admin.section.auditLog.filterTarget")}
          />
          <Select
            value={range}
            onValueChange={(v) => {
              setPage(1);
              setRange(v as DateRangePreset);
            }}
          >
            <SelectTrigger aria-label={t("admin.section.auditLog.filterDate")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">
                {t("admin.section.auditLog.range24h")}
              </SelectItem>
              <SelectItem value="7d">
                {t("admin.section.auditLog.range7d")}
              </SelectItem>
              <SelectItem value="30d">
                {t("admin.section.auditLog.range30d")}
              </SelectItem>
              <SelectItem value="all">
                {t("admin.section.auditLog.rangeAll")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Toolbar row: per-page + export */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {t("admin.section.auditLog.perPage")}
            </span>
            <Select
              value={String(perPage)}
              onValueChange={(v) => {
                setPage(1);
                setPerPage(Number(v) as PerPageValue);
              }}
            >
              <SelectTrigger className="h-8 w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PER_PAGE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={downloadCsv}
            disabled={entries.length === 0}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            {t("admin.section.auditLog.export")}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : !entries.length ? (
          <EmptyState
            icon={<ScrollText className="size-6" />}
            title={
              filter === "failed"
                ? t("admin.loginEmptyFailedTitle")
                : t("admin.section.auditLog.empty")
            }
            description={
              filter === "failed"
                ? t("admin.loginEmptyFailedDescription")
                : t("admin.loginEmptyDescription")
            }
            action={
              filter === "failed" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetPageOnFilterChange(() => setFilter("all"))}
                >
                  {t("admin.loginEmptyResetFilter")}
                </Button>
              ) : undefined
            }
          />
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
                  <th className="px-3 py-2 text-left font-medium">
                    {t("admin.provider")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("admin.ip")}
                  </th>
                  {/*
                      v1.4.25 W8b — Standort column. Previously rendered
                      `text-right`, which on wide audit tables let the
                      `Berlin, DE` label drift to the table edge and
                      blend into the timestamp gutter. Left-aligning it
                      (and dropping the `text-right` from IP for
                      consistency) makes Standort a first-class column
                      that admins actually notice.
                    */}
                  <th className="px-3 py-2 text-left font-medium">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" aria-hidden="true" />
                      {t("admin.location")}
                    </span>
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("admin.timestamp")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {entries.map((entry, i) => {
                  const isFailed = entry.action === "auth.login.failed";
                  const provider = providerForAction(entry.action);
                  const ProviderIcon = iconForAuthProvider(provider);
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
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        <span className="inline-flex items-center gap-1.5">
                          <ProviderIcon
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          {AUTH_PROVIDER_LABELS[provider]}
                        </span>
                      </td>
                      <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                        {entry.ipAddress ?? "—"}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
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
            <div className="text-muted-foreground mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>
                {t("admin.showingEntries", {
                  count: entries.length,
                  total,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  {t("admin.section.auditLog.prev")}
                </Button>
                <span>
                  {t("admin.section.auditLog.pageOf", {
                    page,
                    total: lastPage,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= lastPage}
                  onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
                >
                  {t("admin.section.auditLog.next")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
