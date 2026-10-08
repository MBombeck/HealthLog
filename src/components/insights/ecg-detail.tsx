"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { DayLinkAt } from "@/components/day/day-link";

import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { EcgWaveform } from "@/components/insights/ecg-waveform";
import { InsightSectionCard } from "@/components/insights/insight-section-card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import {
  ecgResultLabel,
  isNonNormalEcg,
  type EcgClassification,
} from "@/lib/insights/ecg-classification";

/**
 * One ECG recording: the trace, the metadata, and the DEVICE's own result.
 *
 * NON-DIAGNOSTIC: the result shown is the recording device's, attributed to
 * the device ("Recorded result: …, as reported by the recording device").
 * HealthLog reads nothing off the curve. A non-normal device result adds the
 * "discuss with a clinician" note. Plain React text children throughout.
 *
 * The component owns its own read, addressed by id, so the detail page needs
 * nothing from the list it was opened from — a deep link works cold.
 */

export interface EcgDetailResponse {
  recordedAt: string;
  durationSeconds: number | null;
  samplingFrequency: number;
  averageHeartRate: number | null;
  lead: string | null;
  classification: EcgClassification;
  source: string;
  samples: number[];
  decimated: boolean;
}

export function EcgDetail({ recordingId }: { recordingId: string }) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.insightsEcgDetail(recordingId, false),
    queryFn: async () => {
      try {
        return await apiGet<EcgDetailResponse>(
          `/api/insights/ecg/${recordingId}`,
        );
      } catch {
        throw new Error(t("insights.ecg.loadError"));
      }
    },
  });

  if (isError) {
    // A failed read must never read as "no data" (UI-STANDARDS §6), and the
    // alert is content, not muted meta — it also has to be recoverable.
    return (
      <QueryErrorCard
        title={t("insights.ecg.loadError")}
        onRetry={() => refetch()}
      />
    );
  }

  if (isLoading || !data) {
    return (
      <div
        data-slot="ecg-waveform-skeleton"
        className="bg-muted/40 h-40 w-full animate-pulse rounded-lg motion-reduce:animate-none"
      />
    );
  }

  const resultLabel = ecgResultLabel(data.classification, t);
  const leadLabel = data.lead ?? t("insights.ecg.meta.leadSingle");
  const durationLabel =
    data.durationSeconds != null
      ? t("insights.ecg.meta.durationValue", {
          seconds: Math.round(data.durationSeconds),
        })
      : t("insights.ecg.meta.unknown");

  return (
    <InsightSectionCard slot="ecg-detail" className="border-border">
      {/* The DEVICE's result, attributed to the device. This is the ONLY
          verdict shown — HealthLog produces none. */}
      {resultLabel && (
        <p
          data-slot="ecg-result"
          className="text-foreground text-sm font-medium"
        >
          {t("insights.ecg.resultAttribution", { result: resultLabel })}
        </p>
      )}

      <EcgWaveform
        samples={data.samples}
        recordedAt={data.recordedAt}
        durationSeconds={data.durationSeconds}
        averageHeartRate={data.averageHeartRate}
        resultLabel={resultLabel}
      />

      <dl
        data-slot="ecg-meta"
        className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3"
      >
        <MetaItem
          label={t("insights.ecg.meta.recorded")}
          // v1.42 — the date opens the day around the recording.
          value={
            <DayLinkAt at={data.recordedAt}>
              {fmt.dateTime(new Date(data.recordedAt))}
            </DayLinkAt>
          }
        />
        <MetaItem
          label={t("insights.ecg.meta.duration")}
          value={durationLabel}
        />
        <MetaItem label={t("insights.ecg.meta.lead")} value={leadLabel} />
        <MetaItem
          label={t("insights.ecg.meta.averageHeartRate")}
          value={
            data.averageHeartRate != null
              ? t("insights.ecg.meta.bpmValue", { bpm: data.averageHeartRate })
              : t("insights.ecg.meta.unknown")
          }
        />
        <MetaItem
          label={t("insights.ecg.meta.samplingRate")}
          value={
            data.samplingFrequency > 0
              ? t("insights.ecg.meta.hzValue", { hz: data.samplingFrequency })
              : t("insights.ecg.meta.unknown")
          }
        />
      </dl>

      {/* "Discuss with a clinician" — only on a non-normal device result. */}
      {isNonNormalEcg(data.classification) && (
        <p
          data-slot="ecg-clinician-note"
          className="text-foreground text-sm font-medium"
        >
          {t("insights.ecg.clinicianNote")}
        </p>
      )}
    </InsightSectionCard>
  );
}

function MetaItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
