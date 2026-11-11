"use client";

import { TriangleAlert } from "lucide-react";

import { InfoPopover } from "@/components/ui/info-popover";
import { useTranslations } from "@/lib/i18n/context";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS } from "@/lib/i18n/source-labels";

/**
 * v1.28.x — the discreet "sources disagree" marker, extracted from
 * `sleep-hypnogram.tsx` (which introduced it in v1.28.21) so the dashboard
 * sleep tile and the hypnogram render the identical hint off the identical
 * wire shape. Observational only: the headline number always stays the
 * winning writer's total; the popover lists each writer's own total so a
 * multi-tracker user can see WHY the night reads surprising.
 */

/** Wire shape of the server-computed annotation (rounded minutes). */
export interface SleepSourceDiscrepancyDto {
  deltaMinutes: number;
  sources: {
    source: string;
    deviceType: string | null;
    asleepMinutes: number;
  }[];
}

/**
 * Localised device-type label keys (`Measurement.deviceType`), reused from
 * the source-priority settings surface. Appended in parentheses so two
 * writer apps behind the same source (watch vs phone under Apple Health)
 * stay distinguishable in the discrepancy popover.
 */
const DEVICE_TYPE_LABEL_KEYS: Record<string, string> = {
  watch: "settings.sections.sources.deviceLabels.watch",
  band: "settings.sections.sources.deviceLabels.band",
  ring: "settings.sections.sources.deviceLabels.ring",
  phone: "settings.sections.sources.deviceLabels.phone",
  scale: "settings.sections.sources.deviceLabels.scale",
  other: "settings.sections.sources.deviceLabels.other",
};

export function sourceDisplayName(
  source: string,
  deviceType: string | null,
  t: (key: string) => string,
): string {
  // The wire carries whatever the row's `source` column held, so an
  // unknown value still has to render as itself rather than as a missing
  // key. The catalogue covers every enum member the guard knows about.
  const labelKey = MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS[
    source as keyof typeof MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS
  ] as string | undefined;
  const base = labelKey ? t(labelKey) : source;
  const deviceKey = deviceType ? DEVICE_TYPE_LABEL_KEYS[deviceType] : undefined;
  return deviceKey ? `${base} (${t(deviceKey)})` : base;
}

export interface SleepSourceDiscrepancyMarkerProps {
  discrepancy: SleepSourceDiscrepancyDto | null | undefined;
  /** Popover alignment relative to the trigger (default `"start"`). */
  align?: "start" | "center" | "end";
}

/**
 * Discreet source-discrepancy marker: two writers reported clearly
 * different totals for the night. Muted, no colour wash, no banner;
 * negative margins keep the 44 px hit target from growing the host line
 * (same trick as measurement-diversity-nudge). Renders nothing when the
 * annotation is absent — no layout shift on the ordinary path.
 */
export function SleepSourceDiscrepancyMarker({
  discrepancy,
  align = "start",
}: SleepSourceDiscrepancyMarkerProps) {
  const { t } = useTranslations();
  if (!discrepancy) return null;
  return (
    // On the dashboard the marker sits in the tile's link: its tap opens the
    // popover, not the tile.
    <span
      className="contents"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <InfoPopover
        content={
          <>
            <span className="text-foreground block font-medium">
              {t("insights.sleep.sourceDiscrepancy.tooltipTitle")}
            </span>
            {discrepancy.sources
              .map(
                (b) =>
                  `${sourceDisplayName(b.source, b.deviceType, t)} ${formatDurationMinutes(b.asleepMinutes, t)}`,
              )
              .join(" · ")}
          </>
        }
        label={t("insights.sleep.sourceDiscrepancy.tooltipTitle")}
        icon={TriangleAlert}
        className="-mx-3"
        align={align}
        triggerDataSlot="sleep-source-discrepancy"
        bodyDataSlot="sleep-source-discrepancy-body"
      />
    </span>
  );
}
