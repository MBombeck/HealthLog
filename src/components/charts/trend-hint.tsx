"use client";

import { TrendingUp } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations } from "@/lib/i18n/context";
import { trendHintFor } from "@/lib/onboarding/checklist";

interface TrendHintProps {
  /** Total readings logged for this metric (raw count, not days). */
  count: number;
}

/**
 * Tiny banner shown below or alongside a chart for users still in the
 * "first week" of HealthLog: ≥1 but <5 readings of this metric. We
 * mount the existing `<EmptyState variant="plain">` primitive so the
 * shape matches every other empty-state in the app and inherits its
 * polite-live-region semantics. Renders nothing once the user crosses
 * 5 readings — no flicker.
 */
export function TrendHint({ count }: TrendHintProps) {
  const { t } = useTranslations();
  const result = trendHintFor(count);
  if (result.kind === "hidden") return null;

  const description =
    result.remaining === 1
      ? t("trendHints.remainingOne")
      : t("trendHints.remainingMany", { count: result.remaining });

  return (
    <EmptyState
      variant="plain"
      size="compact"
      icon={<TrendingUp className="size-4" />}
      title={t("trendHints.title")}
      description={description}
    />
  );
}
