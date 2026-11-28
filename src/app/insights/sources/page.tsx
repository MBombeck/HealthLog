"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { SubPageShell } from "@/components/insights/sub-page-shell";
import { SourceProvenanceView } from "@/components/provenance/source-provenance-view";
import { useTranslations } from "@/lib/i18n/context";
import { isProvenanceType } from "@/lib/provenance/ranked-types";

/**
 * v1.44 — `/insights/sources` (#1204, #1108, #576).
 *
 * Where a metric's values come from: per day, every source that delivered
 * one and the one the source priority picked, with the reason; and two
 * sources side by side over a range. Reached from a metric's page and from
 * Settings > Source priority; `?type=` and `?date=` open it on a metric and a
 * day. Read-only: the order that decides the pick is edited in Settings.
 */
function SourcesPageBody() {
  const params = useSearchParams();
  const type = params.get("type");
  const date = params.get("date");
  return (
    <SourceProvenanceView
      initialType={type && isProvenanceType(type) ? type : "ACTIVITY_STEPS"}
      initialDate={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null}
    />
  );
}

export default function InsightsSourcesPage() {
  const { t } = useTranslations();
  return (
    <SubPageShell
      title={t("sourceProvenance.title")}
      info={t("sourceProvenance.description")}
    >
      <Suspense fallback={null}>
        <SourcesPageBody />
      </Suspense>
    </SubPageShell>
  );
}
