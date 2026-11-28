"use client";

/**
 * v1.25.1 — `/labs/[biomarkerId]/values`.
 *
 * The "show all readings" sub-page for one biomarker, mirroring the metric
 * sub-pages' `/insights/values/[type]`. The detail page keeps the
 * numbers-first spine (description → stat strip → chart → assessment) and
 * links here for the raw, editable reading feed. Owns auth + the back link to
 * the biomarker detail, and hands the marker id to `<LabValuesList>`.
 */
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { LabValuesList } from "@/components/labs/lab-values-list";
import type { BiomarkerDto } from "@/components/labs/types";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { BackLink } from "@/components/ui/back-link";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export default function LabBiomarkerValuesPage({
  params,
}: {
  params: Promise<{ biomarkerId: string }>;
}) {
  const { biomarkerId } = use(params);
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const { t } = useTranslations();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  const { data: marker } = useQuery({
    queryKey: queryKeys.biomarkerDetail(biomarkerId),
    queryFn: () => apiGet<BiomarkerDto>(`/api/biomarkers/${biomarkerId}`),
    enabled: isAuthenticated && biomarkerId.length > 0,
  });

  if (!mounted || isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  const markerName = marker?.name ?? "";

  return (
    <SubPageShell
      title={t("labs.detail.valuesTitle", { marker: markerName })}
      info={t("labs.detail.valuesDescription")}
      backLink={
        <BackLink
          href={`/labs/${biomarkerId}`}
          label={t("labs.detail.backToMarker", { marker: markerName })}
          dataSlot="lab-values-back"
        />
      }
    >
      <LabValuesList biomarkerId={biomarkerId} />
    </SubPageShell>
  );
}
