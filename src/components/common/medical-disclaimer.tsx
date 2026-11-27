"use client";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.25 — the one place the app states what it is and is not.
 *
 * HealthLog's self-description standard is layered, not a wall of warnings:
 * a single intended-purpose statement plus calm, context-specific notes that
 * sit once on the surface they belong to. Every string is plain React text —
 * no markdown renderer, in line with the project's XSS posture (Coach,
 * briefing and insights all render as text children).
 *
 * The copy lives under the `selfDescription` i18n namespace so every locale
 * carries the same set, one key per kind. Pick the note that fits the surface
 * and render it once per page or section, never per row or card:
 *
 * - `dataPosture` — self-hosted, data stays on your instance, BYOK / local AI.
 * - `notDiagnosis` — HealthLog describes data and does not diagnose. Every
 *   Insights metric page carries it once (`SubPageShell`), as do the
 *   medical-history pages.
 * - `notCause` — a pattern or a correlation is not a cause. Pages that show
 *   associations (mood, medication effect) carry it instead.
 *
 * A screen that needs the statement takes this component; it does not grow a
 * sentence of its own ("…, not a diagnosis.") in its copy. The guard is
 * `src/__tests__/disclaimer-central-guard.test.ts`.
 *
 * What stays in context on purpose, because it is safety or consent rather
 * than self-description: crisis help, the seizure emergency plan, the cycle
 * contraception warning, device rhythm alerts, the AI consent texts, and
 * every disclaimer in a document that leaves the app (doctor report, share
 * link). The acknowledged onboarding disclaimer (`onboarding.disclaimer.*`)
 * and the legal medical-device boundary on the public privacy page remain the
 * standing floor; this note is the gentle, in-context layer above it.
 */
export type DisclaimerVariant = "dataPosture" | "notDiagnosis" | "notCause";

const VARIANT_KEY: Record<DisclaimerVariant, string> = {
  dataPosture: "selfDescription.dataPosture",
  notDiagnosis: "selfDescription.notDiagnosis",
  notCause: "selfDescription.notCause",
};

export interface MedicalDisclaimerProps {
  variant: DisclaimerVariant;
  className?: string;
}

/**
 * A calm, muted, plain-text disclaimer line. Defaults to a small,
 * unobtrusive footnote treatment; pass `className` to tune spacing for the
 * surface. Keep it to one instance per surface — the standard is layered,
 * not repeated.
 */
export function MedicalDisclaimer({
  variant,
  className,
}: MedicalDisclaimerProps) {
  const { t } = useTranslations();
  return (
    <p
      data-slot="medical-disclaimer"
      data-variant={variant}
      className={cn("text-muted-foreground text-xs leading-relaxed", className)}
    >
      {t(VARIANT_KEY[variant])}
    </p>
  );
}
