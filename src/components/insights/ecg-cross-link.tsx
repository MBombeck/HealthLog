"use client";

import { HeartPulse } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { CrossLinkCard } from "@/components/insights/cross-link-card";
import { useEcgList } from "./use-ecg-list";

/**
 * ECG cross-link, the pointer from the resting-HR / pulse context into
 * the ECG viewer (`/insights/ecg`). Points at the routed sub-page, which
 * always mounts, rather than the overview `#ecg` fragment, which is absent
 * until the overview section's own fetch resolves (UX-flows finding F1-1).
 *
 * NON-DIAGNOSTIC (load-bearing, mirrors `EcgSection` / `RhythmEventsCard`): the
 * card surfaces ONLY that recordings exist + the RECORDING DEVICE's OWN latest
 * result, attributed to the device. HealthLog never reads or interprets the
 * waveform, and this pointer never touches it — the list route returns metadata
 * only. All copy renders as plain React text children (no markdown library).
 *
 * Data-availability-gated: the card un-mounts entirely (`return null`) when the
 * user has no recordings, so a pulse page without any ECG never paints it. It
 * reuses the SAME query cell as `EcgSection` (`insightsEcgList`), so the two
 * surfaces share one cache entry with an identical response shape.
 */

/** The device verdict, surfaced verbatim and attributed to the device. */
const RESULT_LABEL_KEYS: Record<string, string> = {
  IRREGULAR: "insights.ecg.result.irregular",
  NOT_DETECTED: "insights.ecg.result.notDetected",
  INCONCLUSIVE: "insights.ecg.result.inconclusive",
};

interface EcgCrossLinkProps {
  enabled?: boolean;
  className?: string;
}

export function EcgCrossLink({ enabled = true, className }: EcgCrossLinkProps) {
  const { t } = useTranslations();

  const data = useEcgList(enabled).data?.data;

  // Data-availability gate — never paint an empty pointer.
  if (!data || !data.hasRecordings || data.recordings.length === 0) return null;

  const count = data.recordings.length;
  const latestClassification = data.recordings[0]?.classification ?? null;
  const resultKey = latestClassification
    ? RESULT_LABEL_KEYS[latestClassification]
    : null;

  const countText =
    count === 1
      ? t("insights.ecg.crossLink.recordingsOne", { count })
      : t("insights.ecg.crossLink.recordingsMany", { count });
  const resultText = resultKey
    ? t("insights.ecg.crossLink.latestResult", { result: t(resultKey) })
    : null;

  return (
    <CrossLinkCard
      href="/insights/ecg"
      slot="ecg-cross-link"
      icon={HeartPulse}
      title={t("insights.ecg.crossLink.title")}
      body={resultText ? `${countText} ${resultText}` : countText}
      cta={t("insights.ecg.crossLink.cta")}
      className={className}
      // `.metric-accent` — the heart-family identity edge (`--tile-strain`,
      // the wellness vocabulary's cardiovascular hue), the same mark the
      // `ecg_new_recording` rail card carries, so the two ECG pointers read
      // as one family.
      cardClassName="metric-accent"
      style={{ "--tile-hue": "var(--tile-strain)" } as React.CSSProperties}
    />
  );
}
