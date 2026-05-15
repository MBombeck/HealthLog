"use client";

/**
 * `<AppLogPreviewSection>` — surfaces the in-process wide-event ring buffer
 * (`src/lib/logging/in-memory-buffer.ts`) so admins can drill into the most
 * recent ~500 structured events without standing up a Loki stack just to
 * read the last hour.
 *
 * Limitations (covered by the section header):
 *   - Per-process. Under split web/worker deployments, only the web buffer
 *     is visible here. Worker logs ship to Loki when configured.
 *   - Volatile. Restart drops the buffer.
 *
 * Privacy: every event passes through `redactSecrets()` server-side before
 * reaching this component; storage stays raw so the diagnostic value
 * survives shipping to Loki.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  X,
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import type { WideEvent, LogLevel } from "@/lib/logging/types";

type RangePreset = "15m" | "1h" | "6h" | "all";

interface AppLogsResponse {
  events: WideEvent[];
  meta: {
    total: number;
    bufferMax: number;
  };
}

function rangeToSince(range: RangePreset): string | undefined {
  if (range === "all") return undefined;
  const now = Date.now();
  const minutes = range === "15m" ? 15 : range === "1h" ? 60 : 6 * 60;
  return new Date(now - minutes * 60 * 1000).toISOString();
}

function levelIcon(level: LogLevel) {
  switch (level) {
    case "error":
      return <AlertCircle className="text-destructive h-4 w-4" />;
    case "warn":
      return <AlertTriangle className="text-dracula-yellow h-4 w-4" />;
    case "debug":
      return <Info className="text-muted-foreground h-4 w-4" />;
    case "info":
    default:
      return <CheckCircle2 className="text-dracula-green h-4 w-4" />;
  }
}

export function AppLogPreviewSection() {
  const { t } = useTranslations();

  const [traceId, setTraceId] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [level, setLevel] = useState<LogLevel | "__all__">("__all__");
  const [range, setRange] = useState<RangePreset>("1h");
  const [selected, setSelected] = useState<WideEvent | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (traceId.trim()) p.set("traceId", traceId.trim());
    if (actionFilter.trim()) p.set("action", actionFilter.trim());
    if (level !== "__all__") p.set("level", level);
    const since = rangeToSince(range);
    if (since) p.set("since", since);
    return p;
  }, [traceId, actionFilter, level, range]);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin", "app-logs", traceId, actionFilter, level, range],
    queryFn: async () => {
      const res = await fetch(`/api/admin/app-logs?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load app logs");
      return (await res.json()).data as AppLogsResponse;
    },
    refetchInterval: 30_000,
  });

  const events = data?.events ?? [];

  return (
    <div className="bg-card border-border space-y-4 rounded-xl border p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <FileText className="text-primary mt-0.5 h-5 w-5" />
          <div>
            <h2 className="text-lg font-semibold">
              {t("admin.section.app-logs.title")}
            </h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("admin.section.app-logs.processNote")}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label={t("admin.section.app-logs.refresh")}
        >
          <RefreshCw
            className={`h-4 w-4 ${isFetching ? "animate-spin" : ""} motion-reduce:animate-none`}
          />
        </Button>
      </header>

      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
        <Input
          type="search"
          placeholder={t("admin.section.app-logs.filterTraceId")}
          value={traceId}
          onChange={(e) => setTraceId(e.target.value)}
          aria-label={t("admin.section.app-logs.filterTraceId")}
        />
        <Input
          type="search"
          placeholder={t("admin.section.app-logs.filterAction")}
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          aria-label={t("admin.section.app-logs.filterAction")}
        />
        <Select
          value={level}
          onValueChange={(v) => setLevel(v as LogLevel | "__all__")}
        >
          <SelectTrigger aria-label={t("admin.section.app-logs.filterLevel")}>
            <SelectValue
              placeholder={t("admin.section.app-logs.filterLevel")}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">
              {t("admin.section.app-logs.levelAll")}
            </SelectItem>
            <SelectItem value="debug">debug</SelectItem>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="error">error</SelectItem>
          </SelectContent>
        </Select>
        <Select value={range} onValueChange={(v) => setRange(v as RangePreset)}>
          <SelectTrigger aria-label={t("admin.section.app-logs.filterRange")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="15m">
              {t("admin.section.app-logs.range15m")}
            </SelectItem>
            <SelectItem value="1h">
              {t("admin.section.app-logs.range1h")}
            </SelectItem>
            <SelectItem value="6h">
              {t("admin.section.app-logs.range6h")}
            </SelectItem>
            <SelectItem value="all">
              {t("admin.section.app-logs.rangeAll")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-6" />}
          title={t("admin.section.app-logs.empty")}
          description={t("admin.section.app-logs.emptyDescription")}
        />
      ) : (
        // v1.4.27 MB5 — keep the table scroll container, but lift the
        // "showing X of Y" summary line out into a sibling `<div>` so
        // the meta info stays reachable on narrow viewports even when
        // the table is scrolled horizontally. The refresh control was
        // already in the header above the table wrapper.
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-xs">
                  <th className="px-2 py-2 text-left font-medium">
                    {t("admin.section.app-logs.colLevel")}
                  </th>
                  <th className="px-2 py-2 text-left font-medium">
                    {t("admin.section.app-logs.colTimestamp")}
                  </th>
                  <th className="px-2 py-2 text-left font-medium">
                    {t("admin.section.app-logs.colAction")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("admin.section.app-logs.colDuration")}
                  </th>
                  <th className="px-2 py-2 text-left font-medium">
                    {t("admin.section.app-logs.colTraceId")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {events.map((event, i) => (
                  <tr
                    key={`${event.request_id}-${i}`}
                    className={`${i % 2 === 0 ? "bg-muted/30" : ""} hover:bg-muted cursor-pointer`}
                    onClick={() => setSelected(event)}
                  >
                    <td className="px-2 py-2">{levelIcon(event.level)}</td>
                    <td className="text-muted-foreground px-2 py-2 text-xs whitespace-nowrap">
                      {formatDateTime(event.timestamp)}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      {event.action?.name ??
                        (`${event.http?.method ?? ""} ${event.http?.path ?? ""}`.trim() ||
                          event.kind)}
                    </td>
                    <td className="text-muted-foreground px-2 py-2 text-right font-mono text-xs">
                      {event.duration_ms} ms
                    </td>
                    <td className="text-muted-foreground px-2 py-2 font-mono text-xs">
                      {event.trace_id.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="text-muted-foreground mt-3 flex items-center justify-between text-xs"
            data-testid="app-log-preview-summary"
          >
            <span>
              {t("admin.section.app-logs.showing", {
                count: events.length,
                bufferMax: data?.meta.bufferMax ?? 500,
              })}
            </span>
          </div>
        </>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && levelIcon(selected.level)}
              <span className="font-mono text-sm">
                {selected?.action?.name ??
                  selected?.http?.path ??
                  t("admin.section.app-logs.eventDetails")}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto">
            {selected && (
              <pre className="bg-muted text-foreground rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
                {JSON.stringify(selected, null, 2)}
              </pre>
            )}
          </div>
          <DialogClose asChild>
            <Button
              variant="outline"
              size="sm"
              className="absolute top-3 right-3"
              aria-label={t("admin.section.app-logs.closeDetails")}
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  );
}
