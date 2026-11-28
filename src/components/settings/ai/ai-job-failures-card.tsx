"use client";

/* ────────────────────────────────────────────────────────────────
 * #1404 — background AI work that stopped, and why.
 *
 * A document summary, a document read, the status notes, the briefing, a
 * workout note: when one of them stops because the provider is down, a bound
 * chain has nowhere to go or a key is missing, the server records the reason
 * (`GET /api/ai/job-failures`) and this card says it. An entry goes by itself
 * once the work succeeds again. Nothing to show, no card.
 * ──────────────────────────────────────────────────────────────── */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { AiJobFailureLine } from "@/components/ai/ai-job-failure-line";
import { SettingsCard } from "@/components/settings/settings-card";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiGet } from "@/lib/api/api-fetch";
import type { AiJobFailureDto } from "@/lib/ai/job-failure/types";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export function AiJobFailuresCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const query = useQuery({
    queryKey: queryKeys.aiJobFailures(),
    queryFn: () =>
      apiGet<{ failures: AiJobFailureDto[] }>("/api/ai/job-failures"),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
  const failures = query.data?.failures ?? [];
  // A failed read is said as one; nothing to report, no card.
  if (query.isError) {
    return (
      <SettingsCard data-slot="ai-job-failures-card">
        <SettingsCardHeader
          icon={TriangleAlert}
          title={t("aiRuns.jobFailure.title")}
        />
        <QueryErrorRow
          inset
          error={query.error}
          slot="ai-job-failures-error"
          onRetry={() => void query.refetch()}
        />
      </SettingsCard>
    );
  }
  if (failures.length === 0) return null;

  return (
    <SettingsCard data-slot="ai-job-failures-card">
      <SettingsCardHeader
        icon={TriangleAlert}
        title={t("aiRuns.jobFailure.title")}
      />
      <ul className="space-y-3">
        {failures.map((failure) => (
          <li
            key={`${failure.job}:${failure.documentId ?? ""}`}
            className="space-y-1"
          >
            <AiJobFailureLine failure={failure} withJob />
            {failure.documentId ? (
              <InlineAction asChild size="sm">
                <Link
                  href={`/documents?doc=${encodeURIComponent(failure.documentId)}`}
                >
                  {t("aiRuns.jobFailure.openDocument")}
                </Link>
              </InlineAction>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
