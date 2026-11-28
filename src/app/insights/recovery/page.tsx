"use client";

import { useTranslations } from "@/lib/i18n/context";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { RecoverySection } from "@/components/insights/recovery/recovery-section";

/**
 * `/insights/recovery`, titled "Device scores" since 1.50.
 *
 * What a wearable reports under its own names: the device's recovery (WHOOP
 * Recovery, Oura Readiness, Polar Nightly Recharge) with its two-week
 * course, recharge, strain and load, and the day's heart-rate and energy
 * totals. HealthLog's own stress and strain stand at the head of Insights
 * with the other scores, labelled as estimates.
 *
 * The route keeps its name so links, the nav pill and the integration cards
 * keep working. The readiness HealthLog computes lives on the Insights head
 * and on its own page; the retired `/insights/scores/recovery` slug sends a
 * device account here.
 *
 * Every block is data-gated inside `<RecoverySection>`, and whether the page
 * has anything at all is the server's answer, so an account without a strap
 * or ring sees the calm empty note.
 */
export default function InsightsRecoveryPage() {
  const { t } = useTranslations();

  return (
    <SubPageShell
      title={t("insights.deviceScores.title")}
      info={t("insights.deviceScores.description")}
      explainerMetric="recoveryPage"
      coachLaunch
    >
      <RecoverySection />
    </SubPageShell>
  );
}
