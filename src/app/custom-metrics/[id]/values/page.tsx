"use client";

/**
 * v1.25.5 — `/custom-metrics/[id]/values`.
 *
 * The "show all values" sub-page for one custom metric, mirroring the labs
 * values sub-page. The detail page keeps the numbers-first spine and links here
 * for the raw, editable value feed. Owns auth + the back link to the detail.
 */
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { CustomMetricValuesList } from "@/components/custom-metrics/custom-metric-values-list";
import type { CustomMetricDto } from "@/components/custom-metrics/types";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { BackLink } from "@/components/ui/back-link";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export default function CustomMetricValuesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const { t } = useTranslations();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  const { data: metric } = useQuery({
    queryKey: queryKeys.customMetricDetail(id),
    queryFn: () => apiGet<CustomMetricDto>(`/api/custom-metrics/${id}`),
    enabled: isAuthenticated && id.length > 0,
  });

  if (!mounted || isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  const metricName = metric?.name ?? "";

  return (
    <SubPageShell
      title={t("customMetrics.detail.valuesTitle", { metric: metricName })}
      info={t("customMetrics.detail.valuesDescription")}
      backLink={
        <BackLink
          href={`/custom-metrics/${id}`}
          label={t("customMetrics.detail.backToMetric", { metric: metricName })}
          dataSlot="custom-metric-values-back"
        />
      }
    >
      <CustomMetricValuesList customMetricId={id} />
    </SubPageShell>
  );
}
