"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Leaf } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ModuleDisabledNotice } from "@/components/layout/module-disabled-notice";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { HydrationCard } from "@/components/insights/nutrients/hydration-card";
import { CaffeineCard } from "@/components/insights/nutrients/caffeine-card";
import { MicronutrientsCard } from "@/components/insights/nutrients/micronutrients-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { NutrientIntakeOverview } from "@/components/insights/nutrients/types";

const WINDOW_DAYS = 30;

/**
 * `nutrient.batch.ingest`'s closed skip-reason codes
 * (`src/app/api/nutrients/batch/route.ts`) mapped to a human sentence —
 * never render the raw code. A reason with no useful action for the
 * account holder says plainly that the entries couldn't be stored rather
 * than inventing advice; `dayInvalid` is the one case with something
 * genuinely worth checking (a clock/time-zone mismatch on the sending
 * side), so it says so.
 */
const LAST_ATTEMPT_REASON_KEYS: Record<string, string> = {
  unit_mismatch: "nutrients.page.lastAttemptReason.unitMismatch",
  value_out_of_range: "nutrients.page.lastAttemptReason.valueOutOfRange",
  day_invalid: "nutrients.page.lastAttemptReason.dayInvalid",
  upsert_failed: "nutrients.page.lastAttemptReason.upsertFailed",
};

function lastAttemptReasonKey(reason: string): string {
  return (
    LAST_ATTEMPT_REASON_KEYS[reason] ??
    "nutrients.page.lastAttemptReason.unknown"
  );
}

/**
 * `/insights/nutrients` — hydration + micronutrients (v1.29).
 *
 * Custom sub-page (NOT `HealthKitMetricPage` — that scaffold is
 * Measurement-backed; this store is `NutrientIntakeDay`). Three cards:
 * hydration hero (always renders once the module is on — even at 0 mL,
 * the quick-add entry point IS the first-run invitation), caffeine
 * (self-gates to nothing without data), micronutrients (self-gates to
 * an EmptyState without data). Degradation ladder:
 *
 *   - module off → the shared `ModuleDisabledNotice`, which names the reason
 *     and carries the in-context enable CTA when it is the record's own
 *     switch that is off. The module STAYS opt-in (2026-07-17 memo — the
 *     HealthKit read prompt on the device is not visible consent to a
 *     server / Coach holding a supplement pattern); this page just makes
 *     the toggle discoverable in context instead of buried in Settings.
 *   - module on, the overview read failed → a `QueryErrorCard` with a
 *     retry. This branch has to sit ABOVE the empty-state check below:
 *     `overview.data` is `undefined` on a failed read exactly like it is
 *     before the first response lands, so without this the page told a
 *     self-hoster who granted every HealthKit permission "no nutrient
 *     data yet" when the read had actually failed — a guess dressed up
 *     as an honest absence. `<MicronutrientsCard>` reads this SAME
 *     `queryKeys.nutrientIntake(WINDOW_DAYS)` query and already renders
 *     its own error card, but this page's old empty-state branch
 *     short-circuited before that card ever mounted.
 *   - module on, zero rows anywhere in the window, AND the server found a
 *     recent sync attempt that landed nothing (`overview.data.lastAttempt`,
 *     from `GET /api/nutrients` — see that route for the AuditLog lookup
 *     and its retention coupling) → an EmptyState naming the attempt and
 *     the reason, not the generic copy. A batch CAN arrive and have every
 *     entry rejected (wrong unit, an implausible amount, a bad date, a
 *     write failure); without this branch that read the same as nothing
 *     ever syncing.
 *   - module on, zero rows, no recorded attempt → the generic EmptyState
 *     explaining where data comes from (a health-app sync or a manual
 *     water entry) instead of three near-empty cards.
 *   - otherwise → the three-card spine.
 */
export default function InsightsNutrientsPage() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const nutrientsEnabled = user?.modules?.nutrients === true;

  const overview = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
    enabled: nutrientsEnabled,
  });

  const enableModule = useMutation({
    mutationFn: () => apiPatch("/api/auth/me/modules", { nutrients: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
    onError: () => toast.error(t("nutrients.page.moduleEnableError")),
  });

  if (!nutrientsEnabled) {
    return (
      <SubPageShell title={t("nutrients.page.title")}>
        {/*
          The shared notice rather than this page's own copy: "nutrients is
          off" was three situations wearing one sentence, and only one of them
          is fixed by the button below. A delegate whose grant does not reach
          the measurements section, and an account on an instance where the
          operator removed the module, both used to be handed a switch that
          would refuse them. The notice reads the reason off `moduleAccess`
          and drops the action for the two cases it cannot help.
        */}
        <ModuleDisabledNotice
          moduleKey="nutrients"
          icon={<Leaf className="size-6" />}
          action={
            <Button
              size="sm"
              onClick={() => enableModule.mutate()}
              disabled={enableModule.isPending}
              data-slot="nutrients-enable-module"
            >
              {t("nutrients.page.moduleOffCta")}
            </Button>
          }
        />
      </SubPageShell>
    );
  }

  if (overview.isError) {
    return (
      <SubPageShell
        title={t("nutrients.page.title")}
        description={t("nutrients.page.description")}
      >
        <QueryErrorCard
          title={t("nutrients.page.loadError")}
          onRetry={() => void overview.refetch()}
        />
      </SubPageShell>
    );
  }

  const hasAnyData = (overview.data?.nutrients.length ?? 0) > 0;
  if (!overview.isLoading && !hasAnyData) {
    const lastAttempt = overview.data?.lastAttempt ?? null;
    return (
      <SubPageShell
        title={t("nutrients.page.title")}
        description={t("nutrients.page.description")}
      >
        {lastAttempt ? (
          <EmptyState
            icon={<Leaf className="size-6" />}
            title={t("nutrients.page.lastAttemptTitle")}
            description={
              <>
                {t(lastAttemptReasonKey(lastAttempt.topReason))}
                <span className="mt-1 block text-xs">
                  {t("nutrients.page.lastAttemptAt", {
                    date: fmt.dateTime(lastAttempt.at),
                  })}
                </span>
              </>
            }
          />
        ) : (
          <EmptyState
            icon={<Leaf className="size-6" />}
            title={t("nutrients.page.emptyTitle")}
            description={t("nutrients.page.emptyDescription")}
          />
        )}
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("nutrients.page.title")}
      description={t("nutrients.page.description")}
    >
      <HydrationCard />
      <CaffeineCard />
      <MicronutrientsCard />
    </SubPageShell>
  );
}
