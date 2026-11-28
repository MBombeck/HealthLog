"use client";

import { use } from "react";
import { notFound, useSearchParams } from "next/navigation";

import { useTranslations } from "@/lib/i18n/context";
import {
  INSIGHTS_OVERVIEW,
  resolveValuesBackHref,
} from "@/lib/insights/values-back-link";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { MEASUREMENT_TYPE_LABEL_KEYS as EVERY_MEASUREMENT_TYPE } from "@/lib/measurements/type-label-keys";
import { BackLink } from "@/components/ui/back-link";
import { MeasurementList } from "@/components/measurements/measurement-list";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.8.5 — `/insights/values/[type]`.
 *
 * The "show all readings" subpage for a single metric. The insights
 * category pages link here with their `MeasurementType` as the route
 * segment (e.g. `/insights/values/WEIGHT`); this page pins the existing
 * `<MeasurementList>` to that type via `lockedType`, giving the user the
 * full paginated, inline-editable raw-readings view without rebuilding
 * any of the list machinery.
 *
 * A single dynamic route serves every metric — the enum guard rejects an
 * unknown segment with a 404 rather than rendering an empty list for a
 * typo'd type.
 */
export default function InsightsMetricValuesPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { t } = useTranslations();
  const { type } = use(params);
  const searchParams = useSearchParams();

  // Reject any segment that is not a real MeasurementType so a typo'd
  // deep-link 404s instead of mounting a blank list. The leaf label map is
  // typed `Record<MeasurementType, string>`, so the compiler holds it to
  // exactly the enum, and it answers the question without pulling the
  // measurement schemas, and Zod, into the page.
  if (!Object.hasOwn(EVERY_MEASUREMENT_TYPE, type)) {
    notFound();
  }

  const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[type];
  const metricLabel = labelKey ? t(labelKey) : type;

  // v1.10.2 — return to the originating metric page when the link carried a
  // `from` param (set by `<SubPageShell>` on the "show all readings" link),
  // so a `weight → show all values` drill-in lands back on `weight` rather
  // than the Insights overview. `resolveValuesBackHref` sanitises the value to
  // an internal `/insights/<slug>` path so a crafted `?from=` can never become
  // an off-site or protocol-relative target; anything else falls back to the
  // overview.
  const backHref = resolveValuesBackHref(searchParams.get("from"));
  const backToOrigin = backHref !== INSIGHTS_OVERVIEW;

  return (
    <SubPageShell
      title={t("insights.subPage.valuesPageTitle", { metric: metricLabel })}
      info={t("insights.subPage.valuesPageDescription")}
      backLink={
        <BackLink
          href={backHref}
          label={
            backToOrigin
              ? t("insights.subPage.valuesBackToMetric", {
                  metric: metricLabel,
                })
              : t("insights.subPage.valuesBack")
          }
          dataSlot="metric-values-back"
        />
      }
    >
      <MeasurementList lockedType={type} />
    </SubPageShell>
  );
}
