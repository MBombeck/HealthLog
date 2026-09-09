"use client";

/**
 * v1.18.2 → v1.18.3 — the per-day timeline anchor, hosted exclusively on the
 * episode detail surface. It surfaces the episode's logged days (symptoms with
 * their 0–3 severity, functional impact, fever) newest-first as a full
 * historical scroll, so the detail page owns the day-log content the list rows
 * no longer carry. Retrospective only — a record of what was logged, never a
 * forecast. Neutral palette throughout.
 *
 * The read uses the date-less `useIllnessDayLogList` hook (the episode's whole
 * day-log history, paginated server-side); when nothing has been logged it
 * renders a calm prompt to log a day.
 */
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

import { ILLNESS_SYMPTOM_CATALOG } from "./symptom-catalog";
import { useIllnessDayLogList } from "./use-illness";
import type { IllnessDayLogDTO } from "./types";

function symptomLabelKey(key: string): string | null {
  return ILLNESS_SYMPTOM_CATALOG.find((s) => s.key === key)?.labelKey ?? null;
}

/** One logged day rendered as a calm, retrospective block. */
function DayLogRow({ log }: { log: IllnessDayLogDTO }) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  return (
    <div className="border-border/60 space-y-2 border-l-2 pl-3">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {fmt.dateShortSmart(`${log.date}T12:00:00`)}
      </p>

      {log.symptoms.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {log.symptoms.map((s) => {
            const labelKey = symptomLabelKey(s.key);
            if (!labelKey) return null;
            return (
              <Badge key={s.key} variant="secondary">
                {t(labelKey)}
                {typeof s.severity === "number"
                  ? ` · ${t("illness.timeline.severity", {
                      severity: s.severity,
                    })}`
                  : ""}
              </Badge>
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("illness.timeline.noSymptoms")}
        </p>
      )}

      {log.functionalImpact !== null ? (
        <p className="text-foreground text-sm">
          {t("illness.timeline.impact", {
            impact: t(`illness.impact.${log.functionalImpact}`),
          })}
        </p>
      ) : null}

      {log.feverC !== null ? (
        <p className="text-foreground text-sm">
          {t("illness.timeline.fever", { value: fmt.number(log.feverC, 1) })}
        </p>
      ) : null}

      {log.note ? (
        <p className="text-muted-foreground text-sm whitespace-pre-wrap">
          {log.note}
        </p>
      ) : null}
    </div>
  );
}

export function IllnessDayTimeline({
  episodeId,
  onLogDay,
}: {
  episodeId: string;
  onLogDay: () => void;
}) {
  const { t } = useTranslations();
  // v1.36.x — logging a day is not a delegated verb.
  const { canManageDomain } = useRecordCapabilities();
  const canManageIllness = canManageDomain("illness");
  const { data, isLoading, isError } = useIllnessDayLogList(episodeId, "desc");

  const dayLogs = data?.dayLogs ?? [];

  return (
    <Card>
      <CardHeader>
        <TileHeader titleAs="h2" title={t("illness.timeline.title")} />
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError ? (
          <p className="text-muted-foreground text-sm">
            {t("illness.timeline.error")}
          </p>
        ) : dayLogs.length === 0 ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {t("illness.timeline.empty")}
            </p>
            {canManageIllness && (
              <Button
                variant="outline"
                className="min-h-11 sm:min-h-9"
                onClick={onLogDay}
              >
                {t("illness.logDay")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {dayLogs.map((log) => (
              <DayLogRow key={log.id} log={log} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
