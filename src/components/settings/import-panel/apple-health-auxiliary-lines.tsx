"use client";

import { useTranslations } from "@/lib/i18n/context";

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
}

/**
 * The outcome lines of the passes that run after export.xml: the ECG
 * recordings and the lab results from health records. A line shows only when
 * the archive held something of its kind.
 */
export function AppleHealthAuxiliaryLines({
  ecg,
  labs,
}: {
  ecg?: AppleHealthEcgCounts;
  labs?: AppleHealthLabCounts;
}) {
  const { t } = useTranslations();
  return (
    <>
      {(ecg?.discovered ?? 0) > 0 && (
        <p
          data-testid="import-apple-health-ecg-result"
          className="text-muted-foreground text-xs"
        >
          {t("settings.sections.export.import.appleHealth.ecgResult", {
            discovered: ecg?.discovered ?? 0,
            imported: ecg?.imported ?? 0,
            updated: ecg?.updated ?? 0,
            skipped: ecg?.skipped ?? 0,
            failed: ecg?.failed ?? 0,
          })}
        </p>
      )}
      {(labs?.discovered ?? 0) > 0 && (
        <p
          data-testid="import-apple-health-labs-result"
          className="text-muted-foreground text-xs"
        >
          {t("settings.sections.export.import.appleHealth.labsResult", {
            discovered: labs?.discovered ?? 0,
            imported: labs?.imported ?? 0,
            duplicate: labs?.duplicate ?? 0,
            skipped: labs?.skipped ?? 0,
            failed: labs?.failed ?? 0,
          })}
        </p>
      )}
    </>
  );
}
