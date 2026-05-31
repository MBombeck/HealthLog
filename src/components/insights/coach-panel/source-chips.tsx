"use client";

import { Link2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import type { CoachProvenance } from "@/lib/ai/coach/types";

/**
 * v1.4.20 phase B2b — provenance chip row.
 *
 * Renders the labels-only `metricSourceJson` envelope that the backend
 * attaches to every assistant message. We never render raw values here
 * — only metric + window labels + sample counts so that the row
 * remains queryable / analytics-safe and keeps PII out of any future
 * server-side log capture.
 *
 * The chip click is a no-op for v1.4.20; a chart deeplink will land in
 * B3 once the correlation row knows which window to focus.
 */
export interface SourceChipsProps {
  provenance: CoachProvenance | null;
  className?: string;
}

// v1.7.0 — every provenance metric token resolves to
// `insights.coach.metric.<token>`. The clustered taxonomy added ~26
// new tokens; the key is derived from the token rather than maintained
// in a hand-listed map. The resolver falls back to the raw token when
// a locale file lags, and `messages/en.json` carries one leaf per
// token (propagated to all locales by the locale-integrity guard).
function metricI18nKey(metric: CoachProvenance["metrics"][number]): string {
  return `insights.coach.metric.${metric}`;
}

const WINDOW_KEYS: Record<CoachProvenance["windows"][number], string> = {
  last7days: "insights.coach.window.last7days",
  last30days: "insights.coach.window.last30days",
  last90days: "insights.coach.window.last90days",
  // v1.4.27 B7 / BL-P6-4 — year-in-review window. The i18n key
  // resolves to a localised label; absent translations fall back
  // through the resolver to the English source.
  lastYear: "insights.coach.window.lastYear",
  allTime: "insights.coach.window.allTime",
};

export function SourceChips({ provenance, className }: SourceChipsProps) {
  const { t } = useTranslations();
  if (!provenance) return null;
  const { metrics, windows, counts } = provenance;
  if (metrics.length === 0 && windows.length === 0) return null;

  // We pair each metric with its first window (the assistant only ever
  // surfaces a single window-per-metric in v1.4.20). When the provenance
  // envelope has no windows (e.g. refusal path with `windows: []`), we
  // still render the metric as a standalone chip so the user gets the
  // "general" tag visibly.
  const primaryWindowKey = windows[0] ?? null;
  const chips = metrics.map((metric) => {
    const metricLabel = t(metricI18nKey(metric));
    const windowLabel = primaryWindowKey
      ? t(WINDOW_KEYS[primaryWindowKey])
      : null;
    const count =
      counts && metric in counts
        ? counts[metric as keyof typeof counts]
        : undefined;
    return {
      key: `${metric}-${primaryWindowKey ?? "none"}`,
      metric,
      metricLabel,
      windowLabel,
      count,
    };
  });

  return (
    <div
      data-slot="coach-source-chips"
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          data-slot="coach-source-chip"
          data-metric={chip.metric}
          className={cn(
            "border-dracula-cyan/25 text-dracula-cyan/90",
            "inline-flex items-center gap-1 rounded-full border bg-transparent",
            "px-2 py-0.5 text-[11px] leading-none",
          )}
        >
          <Link2 className="h-2.5 w-2.5" aria-hidden="true" />
          <span className="font-medium">{chip.metricLabel}</span>
          {chip.windowLabel && (
            <span className="opacity-75">· {chip.windowLabel}</span>
          )}
          {typeof chip.count === "number" && chip.count > 0 && (
            <span className="opacity-60">· n={chip.count}</span>
          )}
        </span>
      ))}
    </div>
  );
}
