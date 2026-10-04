"use client";

/**
 * v1.39.4 — how an answer was worked out, as one muted line at the end of
 * the open steps list: sources, windows, counts and aggregation, rendered
 * on the server in the request locale. Never a health value, so it sits in
 * the meta tier.
 */
import { useTranslations } from "@/lib/i18n/context";
import { COACH_METHOD_KEYS } from "@/lib/ai/coach/dialog-keys";
import type { CoachMethod } from "@/lib/ai/coach/types";

export interface CoachMethodLineProps {
  method: CoachMethod | null;
}

export function CoachMethodLine({ method }: CoachMethodLineProps) {
  const { t } = useTranslations();
  if (!method || !method.text) return null;
  return (
    <p
      data-slot="coach-method-line"
      className="text-muted-foreground text-xs leading-relaxed"
    >
      <span className="font-medium">{t(COACH_METHOD_KEYS.label)}:</span>{" "}
      {method.text}
    </p>
  );
}
