"use client";

/**
 * v1.28 — compact, read-only medication-efficacy summary for the Insights
 * medication surface. Reads the SAME server-computed efficacy DTO the detail
 * page's "Wirkung" tab reads (no second computation) and shows, per eligible
 * medication with enough data, a one-line before/after against its target —
 * strictly association-framed, never a verdict. Each row links through to the
 * medication's Wirkung tab for the full view.
 *
 * Card anatomy per ui-standards.md §8: TileHeader + the inherited `px-4 md:px-6`
 * inset (never re-declared), foreground for content, muted for meta.
 */
import Link from "next/link";
import { Activity, TrendingUp } from "lucide-react";
import { useQueries } from "@tanstack/react-query";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import type {
  MedicationEfficacyDTO,
  EfficacyTargetView,
} from "@/lib/medications/efficacy/build-efficacy";
import { InlineAction } from "@/components/ui/inline-action";
import { EmptyState } from "@/components/ui/empty-state";

function primaryWithDelta(
  dto: MedicationEfficacyDTO,
): EfficacyTargetView | null {
  const withDelta = dto.targets.find(
    (t) => t.primary && t.beforeAfter.present && t.beforeAfter.delta,
  );
  return withDelta ?? null;
}

export function MedicationEfficacySummary({
  medications,
}: {
  medications: { id: string; name: string }[];
}) {
  const { t } = useTranslations();

  const results = useQueries({
    queries: medications.map((m) => ({
      queryKey: queryKeys.medicationEfficacy(m.id),
      queryFn: () =>
        apiGet<MedicationEfficacyDTO>(`/api/medications/${m.id}/efficacy`),
      staleTime: 60_000,
    })),
  });

  if (medications.length === 0) return null;

  const rows = results
    .map((r, i) => ({ med: medications[i], dto: r.data }))
    .filter(
      (
        x,
      ): x is {
        med: { id: string; name: string };
        dto: MedicationEfficacyDTO;
      } => !!x.dto && x.dto.eligible,
    )
    .map((x) => ({ med: x.med, target: primaryWithDelta(x.dto) }))
    .filter((x) => x.target !== null);

  return (
    <Card data-slot="insights-medication-efficacy">
      <CardHeader>
        <TileHeader
          icon={Activity}
          title={t("medications.efficacy.insights.title")}
        />
        <p className="text-muted-foreground mt-1 text-xs">
          {t("medications.efficacy.insights.subtitle")}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("medications.efficacy.insights.empty")}
          />
        ) : (
          <ul className="divide-border/60 divide-y">
            {rows.map(({ med, target }) => {
              const ba = target!.beforeAfter;
              const unit = target!.unit ? ` ${target!.unit}` : "";
              const arrow = (ba.delta?.mean ?? 0) > 0 ? "+" : "";
              return (
                <li
                  key={med.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                  data-slot="insights-medication-efficacy-row"
                >
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">
                      {med.name}
                    </p>
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <TrendingUp aria-hidden="true" className="h-3.5 w-3.5" />
                      <span>
                        {target!.label}: {ba.before?.mean}
                        {unit} → {ba.after?.mean}
                        {unit} ({arrow}
                        {ba.delta?.mean}
                        {unit})
                      </span>
                    </p>
                  </div>
                  <InlineAction asChild className="shrink-0">
                    <Link
                      href={`/medications/${med.id}?tab=effect`}
                      data-slot="insights-medication-efficacy-link"
                    >
                      {t("medications.efficacy.insights.link")}
                    </Link>
                  </InlineAction>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
