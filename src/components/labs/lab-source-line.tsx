"use client";

import { useTranslations } from "@/lib/i18n/context";
import { labSourceLabelKey } from "@/lib/i18n/source-labels";

/**
 * How a lab reading reached the record, in the app's source vocabulary
 * ("Manual", "Scanned report", "Import", "Apple Health"); null for a value
 * this client does not know, which then shows nothing rather than a raw code.
 */
export function labSourceLabel(
  source: string,
  t: (key: string) => string,
): string | null {
  const key = labSourceLabelKey(source);
  return key ? t(key) : null;
}

/** The muted provenance line under a reading. */
export function LabSourceLine({ source }: { source: string }) {
  const { t } = useTranslations();
  const label = labSourceLabel(source, t);
  if (!label) return null;
  return (
    <p className="text-muted-foreground text-xs" data-slot="lab-reading-source">
      {label}
    </p>
  );
}
