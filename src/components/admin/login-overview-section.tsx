"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  MapPin,
  Network,
  ScrollText,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUDIT_ACTION_FAMILY_KEYS,
  groupAuditActions,
  type AuditActionFamily,
} from "@/lib/auth/audit-families";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { toCSV } from "@/lib/export";
import { formatInUserTz, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { useAuth } from "@/hooks/use-auth";
import {
  type AdminAuditEntry,
  AuditActedBy,
  auditLogCsvHeaderLabels,
  buildAuditLogCsvRecords,
  carrierShortLabel,
  iconForAuthProvider,
  providerForAction,
  useAuthActionLabels,
  useAuthProviderLabels,
} from "./_shared";
import { apiGet } from "@/lib/api/api-fetch";

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

/** The dropdown value that picks a whole family of actions. */
const FAMILY_PREFIX = "family:";

function isAuditActionFamily(value: string): value is AuditActionFamily {
  return (AUDIT_ACTION_FAMILY_KEYS as readonly string[]).includes(value);
}

function rangeToSince(range: DateRangePreset): string | undefined {
  if (range === "all") return undefined;
  const now = Date.now();
  const ms = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return new Date(now - ms * 60 * 60 * 1000).toISOString();
}

/**
 * The audit-log query for the viewer's filter state.
 *
 * F-02 (v1.4.19): the page is the auth/admin "Login Overview", so with no
 * action chosen it restricts to `auth.*` (`filter=auth`) and insights or
 * data events stay out of the default view. An action picked from the
 * dropdown is an explicit choice and replaces that default: the server ANDs
 * the two, so keeping `filter=auth` beside a non-auth action (a document
 * upload a guardian made inside a managed profile, #1403) answered zero rows
 * for an action the same dropdown had just offered.
 *
 * The dropdown offers each family of `AUDIT_ACTION_FAMILIES` (sign-ins,
 * documents, sharing and managed profiles, medications) as a whole
 * (`family:<key>`, sent as `filter=<key>`) and each action the table holds in
 * it, so a guardian's document upload, with its actor, is one pick away.
 */
export function buildAuditLogQueryParams(state: {
  page: number;
  perPage: number;
  actor: string;
  actionFilter: string;
  target: string;
  range: DateRangePreset;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("perPage", String(state.perPage));
  const choice =
    state.actionFilter && state.actionFilter !== "__all__"
      ? state.actionFilter
      : null;
  const family = choice?.startsWith(FAMILY_PREFIX)
    ? choice.slice(FAMILY_PREFIX.length)
    : null;
  if (family && isAuditActionFamily(family)) params.set("filter", family);
  else if (choice && !family) params.set("action", choice);
  else params.set("filter", "auth");
  if (state.actor.trim()) params.set("actor", state.actor.trim());
  if (state.target.trim()) params.set("target", state.target.trim());
  const since = rangeToSince(state.range);
  if (since) params.set("since", since);
  return params;
}

export function LoginOverviewSection() {
  const [{ t }, fmt] = [useTranslations(), useFormatters()];
  const { user } = useAuth();
  // v1.4.25 — every CSV-emitted timestamp uses the admin's display
  // timezone so the resulting `2026-05-11T11:05:00+02:00` cell stays
  // legible after Excel/LibreOffice strip the `Z` suffix from the
  // legacy UTC export.
  const userTz = user?.timezone ?? DEFAULT_TIMEZONE;

  // v1.4.25 — the section used to wrap its body in a
  // collapse/expand toggle. Since v1.5 phase-4b moved this to a
  // dedicated `/admin/login-overview` route (the only thing on the
  // page), the toggle was pure clutter: visiting the page already
  // signals intent to see the audit log. The toggle is gone; content
  // always renders. The `settings.collapse` / `settings.expand`
  // i18n keys are retained centrally for any future surface.

  // Quick-filter pill (kept from the v1.4.x UI for one-tap "show failed").
  const [filter, setFilter] = useState<"all" | "failed">("all");

  // v1.4.16 — deeper filter/pagination/export.
  const [actor, setActor] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [target, setTarget] = useState("");
  const [range, setRange] = useState<DateRangePreset>("7d");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<PerPageValue>(50);

  const AUTH_ACTION_LABELS = useAuthActionLabels();
  const AUTH_PROVIDER_LABELS = useAuthProviderLabels();

  // v1.25.11 (#151) — long IPv6 addresses are truncated in the table cell so
  // they never force the wrapper into horizontal scroll; the full value is one
  // click away. Track the most-recently-copied row so the icon can flip to a
  // checkmark for transient feedback.
  const [copiedIp, setCopiedIp] = useState<string | null>(null);

  async function copyIp(id: string, ip: string) {
    try {
      await navigator.clipboard.writeText(ip);
      setCopiedIp(id);
      toast.success(t("admin.ipCopied"));
      window.setTimeout(() => {
        setCopiedIp((current) => (current === id ? null : current));
      }, 2_000);
    } catch (failure) {
      showErrorToast(t("admin.copyFailed"), { cause: failure });
    }
  }

  // Build the query string once so it's reused by the data-query key, the
  // export download, and the next-/prev- buttons.
  const queryParams = useMemo(
    () =>
      buildAuditLogQueryParams({
        page,
        perPage,
        actor,
        actionFilter,
        target,
        range,
      }),
    [page, perPage, actor, actionFilter, target, range],
  );

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminAuditLogFiltered({
      filter,
      page,
      perPage,
      actor,
      actionFilter,
      target,
      range,
    }),
    queryFn: async () => {
      const params = new URLSearchParams(queryParams);
      // Quick-filter pill stacks on top of the new filters.
      if (filter === "failed") {
        params.set("action", "auth.login.failed");
      }
      return apiGet<AuditLogResponse>(
        `/api/admin/audit-log?${params.toString()}`,
      );
    },
  });

  // Distinct actions for the dropdown — populated lazily.
  const { data: actionsData } = useQuery({
    queryKey: queryKeys.adminAuditActions(),
    queryFn: async () => {
      return apiGet<{ actions: string[] }>("/api/admin/audit-log/actions");
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
      user: t("admin.userColumn"),
      actedBy: t("admin.auditActedByColumn"),
      deletedAccount: t("admin.auditActorDeleted"),
      ip: t("admin.ip"),
      location: t("admin.location"),
      // v1.4.27 — `admin.carrier` is shipped by bucket B6. The
      // `t()` helper falls back to the raw key string when the
      // translation row hasn't landed yet, so the CSV stays valid
      // through the staggered B3 → B6 release.
      carrier: t("admin.carrier"),
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
    <SettingsCard>
      <SettingsCardHeader
        icon={ScrollText}
        title={t("admin.loginOverviewCardTitle")}
        description={t("admin.loginOverviewDescription")}
      />

      <div className="space-y-3">
        {/* Quick-filter pills. Failed-only is the most common
              admin "is something wrong" question — keep the one-tap shortcut. */}
        <Segmented
          mode="toggle"
          label={t("admin.loginOverviewFilterLabel")}
          slot="admin-login-filter"
          value={filter}
          onChange={resetPageOnFilterChange(setFilter)}
          options={[
            { value: "all", label: t("admin.allAuthEvents") },
            { value: "failed", label: t("admin.failedOnly") },
          ]}
        />

        {/* Detailed filter row */}
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]">
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
          <AuditActionSelect
            actions={actionsData?.actions ?? []}
            value={actionFilter}
            onChange={(v) => {
              setPage(1);
              setActionFilter(v);
            }}
          />
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
            <SelectTrigger
              className="w-full"
              aria-label={t("admin.section.auditLog.filterDate")}
            >
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
            <span
              id="login-overview-per-page"
              className="text-muted-foreground"
            >
              {t("admin.section.auditLog.perPage")}
            </span>
            <Select
              value={String(perPage)}
              onValueChange={(v) => {
                setPage(1);
                setPerPage(Number(v) as PerPageValue);
              }}
            >
              <SelectTrigger
                className="h-8 w-20"
                aria-labelledby="login-overview-per-page"
              >
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
            <Download className="h-3.5 w-3.5" />
            {t("admin.section.auditLog.export")}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !entries.length ? (
          <EmptyState
            icon={<ScrollText className="size-6" />}
            title={
              filter === "failed"
                ? t("admin.loginEmptyFailedTitle")
                : t("admin.section.auditLog.empty")
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
          // v1.4.27 — the audit table itself stays in an
          // `overflow-x-auto` scroll container so wide rows can pan
          // horizontally on phones, but the pagination + summary line
          // moved out into a sibling `<div>` below so the prev/next
          // controls stay reachable without first scrolling the table
          // back to its starting offset. The CSV-export button was
          // already in the toolbar row above the table wrapper.
          <>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.status")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.userColumn")}
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
                      v1.4.25 — Standort column. Previously rendered
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
                    {/*
                      v1.25.8 — the network operator (carrier) is now its own
                      column instead of a chip stacked under the auth-provider.
                      It resolves from the online geo provider's ISP field, so
                      it's populated even without the optional offline ASN MMDB.
                    */}
                    <th className="px-3 py-2 text-left font-medium">
                      <span className="inline-flex items-center gap-1">
                        <Network className="h-3 w-3" aria-hidden="true" />
                        {t("admin.carrier")}
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
                            <CheckCircle2 className="text-success h-4 w-4" />
                          )}
                        </td>
                        <td
                          className={`px-3 py-2 font-medium ${isFailed ? "text-destructive" : ""}`}
                        >
                          {entry.user?.username ?? t("common.unknown")}
                          <AuditActedBy
                            actor={entry.actor}
                            className="block text-xs font-normal"
                          />
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
                          {entry.ipAddress ? (
                            <IpCopyButton
                              ip={entry.ipAddress}
                              copied={copiedIp === entry.id}
                              label={t("admin.copyIp")}
                              onCopy={() =>
                                copyIp(entry.id, entry.ipAddress as string)
                              }
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-xs">
                          {entry.location ?? "—"}
                        </td>
                        {/*
                          v1.25.8 — carrier / network operator in its own
                          column. Known DACH operators fold to a short label
                          ("Telekom", "Vodafone", "1&1", "O2"); unknown ones
                          show the raw operator string the provider returned.
                        */}
                        <td
                          className="text-muted-foreground px-3 py-2 text-xs"
                          data-slot="login-overview-carrier"
                        >
                          {entry.carrier
                            ? carrierShortLabel(entry.carrier)
                            : "—"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                          {fmt.dateTime(entry.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div
              className="text-muted-foreground mt-3 flex flex-wrap items-center justify-between gap-2 text-xs"
              data-testid="login-overview-pagination"
            >
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
          </>
        )}
      </div>
    </SettingsCard>
  );
}

/**
 * One login row's IP address, a button that copies it. Named by the address
 * it shows with the action added for screen readers, so the accessible name
 * contains the visible text (WCAG 2.5.3).
 */
function IpCopyButton({
  ip,
  copied,
  label,
  onCopy,
}: {
  ip: string;
  copied: boolean;
  label: string;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title={ip}
      data-slot="login-overview-ip"
      className="hover:text-foreground focus-visible:ring-ring inline-flex max-w-[10rem] items-center gap-1 rounded font-mono focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="sr-only">{label}</span>
      <span className="truncate">{ip}</span>
      {copied ? (
        <Check className="text-success h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * The action picker: each family of `AUDIT_ACTION_FAMILIES` as a whole and
 * every action the table holds in it (#1403). `""` is no choice.
 */
function AuditActionSelect({
  actions,
  value,
  onChange,
}: {
  actions: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslations();
  const AUTH_ACTION_LABELS = useAuthActionLabels();
  return (
    <Select
      value={value || "__all__"}
      onValueChange={(v) => onChange(v === "__all__" ? "" : v)}
    >
      <SelectTrigger
        className="w-full"
        aria-label={t("admin.section.auditLog.filterAction")}
      >
        <SelectValue placeholder={t("admin.section.auditLog.filterAction")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">
          {t("admin.section.auditLog.filterActionAll")}
        </SelectItem>
        {groupAuditActions(actions).map((group) => (
          <SelectGroup key={group.family}>
            <SelectLabel>
              {t(`admin.section.auditLog.family.${group.family}`)}
            </SelectLabel>
            <SelectItem value={`${FAMILY_PREFIX}${group.family}`}>
              {t(`admin.section.auditLog.familyAll.${group.family}`)}
            </SelectItem>
            {group.actions.map((a) => (
              <SelectItem key={a} value={a}>
                {AUTH_ACTION_LABELS[a] ?? a}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
