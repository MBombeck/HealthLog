"use client";

import { useTranslations } from "@/lib/i18n/context";
import { SleepOverview } from "@/components/insights/sleep-overview";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 W4c — `/insights/schlaf`.
 *
 * The Sleep sub-page surfaces the per-stage breakdown + duration trend
 * the v1.4.23 schema gained but never rendered. All charts live inside
 * `<SleepOverview>` so the page-level scaffold stays trivial; data
 * fetches and empty-state handling are encapsulated in the component.
 */
export default function InsightsSchlafPage() {
  const { t } = useTranslations();
  return (
    <SubPageShell
      title={t("insights.sleep.title")}
      description={t("insights.sleep.description")}
    >
      <SleepOverview />
    </SubPageShell>
  );
}
