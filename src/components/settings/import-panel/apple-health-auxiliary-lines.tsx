"use client";

import Link from "next/link";

import { InlineAction } from "@/components/ui/inline-action";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

export interface AppleHealthEcgCounts {
  discovered?: number;
  imported?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
}

export interface AppleHealthLabCounts {
  discovered?: number;
  imported?: number;
  duplicate?: number;
  skipped?: number;
  failed?: number;
  /** Markers the import added to Labs because no existing one took a reading. */
  markersCreated?: number;
}

const KEY = "settings.sections.export.import.appleHealth";

/**
 * The outcome lines of the passes that run after export.xml: the ECG
 * recordings and the lab results from health records. A line shows only when
 * the archive held something of its kind. The counts read like the lab CSV
 * import's summary: localised, the reassurance about a failure only when
 * something failed, and the markers the import added named as a count with
 * the way to them (the job result keeps counts only, never a marker name).
 */
export function AppleHealthAuxiliaryLines({
  ecg,
  labs,
}: {
  ecg?: AppleHealthEcgCounts;
  labs?: AppleHealthLabCounts;
}) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const n = (value: number | undefined) => fmt.integer(value ?? 0);
  const markersCreated = labs?.markersCreated ?? 0;
  const labsLanded = (labs?.imported ?? 0) + (labs?.duplicate ?? 0) > 0;
  return (
    <>
      {(ecg?.discovered ?? 0) > 0 && (
        <p
          data-testid="import-apple-health-ecg-result"
          className="text-muted-foreground text-xs"
        >
          {t(`${KEY}.ecgResult`, {
            discovered: n(ecg?.discovered),
            imported: n(ecg?.imported),
            updated: n(ecg?.updated),
            skipped: n(ecg?.skipped),
            failed: n(ecg?.failed),
          })}
          {(ecg?.failed ?? 0) > 0 ? ` ${t(`${KEY}.ecgFailedNote`)}` : null}
        </p>
      )}
      {(labs?.discovered ?? 0) > 0 && (
        <div
          data-testid="import-apple-health-labs-result"
          className="text-muted-foreground space-y-1 text-xs"
        >
          <p>
            {t(`${KEY}.labsResult`, {
              discovered: n(labs?.discovered),
              imported: n(labs?.imported),
              duplicate: n(labs?.duplicate),
              skipped: n(labs?.skipped),
              failed: n(labs?.failed),
            })}
            {(labs?.failed ?? 0) > 0 ? ` ${t(`${KEY}.labsFailedNote`)}` : null}
          </p>
          {markersCreated > 0 ? (
            <p data-slot="import-apple-health-labs-markers">
              {tCount(`${KEY}.labsMarkersCreated`, markersCreated, {
                count: n(markersCreated),
              })}
            </p>
          ) : null}
          {labsLanded ? (
            <InlineAction asChild tone="primary" size="xs">
              <Link href="/labs" data-slot="import-apple-health-view-labs">
                {t(`${KEY}.viewInLabs`)}
              </Link>
            </InlineAction>
          ) : null}
        </div>
      )}
    </>
  );
}
