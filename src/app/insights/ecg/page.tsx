"use client";

import Link from "next/link";
import { Activity } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { EcgSection } from "@/components/insights/ecg-section";
import { useEcgList } from "@/components/insights/use-ecg-list";

/**
 * v1.30 — `/insights/ecg` (UX/IA audit finding H1).
 *
 * Routed home for the ECG recording surface. Before this page the only
 * inbound pointer to a user's ECGs was a cross-link card on the spot-pulse
 * page; hiding the overview ECG teaser in "Anpassen" left no route back at
 * all. This page gives ECG its own address, reached from the Heart-group
 * pill in the tab strip (gated on `hasRecordings`) and the metric catalog.
 *
 * The surface itself is `<EcgSection>` — the list of strips. Its internal
 * `<SectionHeading>` is suppressed (via `hideHeading`) because
 * `<SubPageShell>` already renders the page heading, mirroring how every other
 * routed sub-page lets the shell own the `<h1>`.
 *
 * A row opens `/insights/ecg/[id]`, which is where the trace, the metadata and
 * the device's own result live. The overview `<EcgSection>` teaser on
 * `/insights` links to the same place.
 */
export default function InsightsEcgPage() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  // Reuse the SAME query cell `<EcgSection>` reads (`insightsEcgList`) so the
  // page and the section share one cache entry. The page only needs the
  // `hasRecordings` flag to choose between the empty state and the section.
  const { data: page, isLoading, isError, error, refetch } = useEcgList();
  const data = page?.data;

  // A read failure must be visible, not a heading over an empty body that
  // reads the same as "still loading" (§6). The section shows a one-line
  // `QueryErrorRow`, the right weight for a supplementary block on the
  // overview; on the page the person opened to see this list the failure is
  // the whole content, so it gets the full `QueryErrorCard` instead.
  if (isError) {
    return (
      <SubPageShell
        title={t("insights.ecg.sectionTitle")}
        info={t("insights.subPage.ecgDescription")}
      >
        <QueryErrorCard error={error} onRetry={() => refetch()} />
      </SubPageShell>
    );
  }

  // Data-availability empty state — a direct URL hit (or deleted recordings)
  // lands here without a section to show. Mirrors the sub-page convention:
  // a calm one-line scaffold + a connect-a-device CTA, never a blank surface.
  // While the probe is in flight we render nothing extra (the section self-
  // gates too), so first paint stays quiet rather than flashing an empty card.
  if (!isLoading && data && !data.hasRecordings) {
    return (
      <SubPageShell
        title={t("insights.ecg.sectionTitle")}
        info={t("insights.subPage.ecgDescription")}
      >
        <MetricEmptyState
          icon={<Activity className="size-6" />}
          title={t("insights.ecg.emptyTitle")}
          cta={
            <Button size="sm" asChild>
              <Link href="/settings/integrations">
                {t("insights.ecg.emptyCta")}
              </Link>
            </Button>
          }
          coachPrefill={null}
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.ecg.sectionTitle")}
      info={t("insights.subPage.ecgDescription")}
    >
      <EcgSection enabled={isAuthenticated} hideHeading />
    </SubPageShell>
  );
}
