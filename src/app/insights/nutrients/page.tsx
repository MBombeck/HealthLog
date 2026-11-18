"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Coffee, KeyRound, Leaf, Wine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { HydrationCard } from "@/components/insights/nutrients/hydration-card";
import { EnergyMacrosCard } from "@/components/insights/nutrients/energy-macros-card";
import { SingleNutrientCard } from "@/components/insights/nutrients/single-nutrient-card";
import { MicronutrientsCard } from "@/components/insights/nutrients/micronutrients-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
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
 * Measurement-backed; this store is `NutrientIntakeDay`). Five cards:
 * hydration hero (always renders once the module is on — even at 0 mL),
 * energy and macronutrients, caffeine and alcohol (each self-gates to
 * nothing without data), micronutrients (self-gates to an EmptyState
 * without data). Degradation ladder:
 *
 *   - module off → never reaches this page: the shell answers the URL with
 *     the module notice (`ModulePageGate`), like every other module page.
 *     The module STAYS opt-in (2026-07-17 memo — the HealthKit read prompt on
 *     the device is not visible consent to a server / Coach holding a
 *     supplement pattern).
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
 *   - otherwise → the card spine.
 */
export default function InsightsNutrientsPage() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();

  const nutrientsEnabled = user?.modules?.nutrients === true;

  const overview = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
    enabled: nutrientsEnabled,
  });

  if (overview.isError) {
    return (
      <SubPageShell
        title={t("nutrients.page.title")}
        description={t("nutrients.page.description")}
      >
        <QueryErrorCard
          error={overview.error}
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
            action={
              // A food tracker posts its day totals with a measurement token;
              // the empty page names that route, so it opens it too.
              <Button asChild>
                <Link
                  href="/settings/api#measurements-token"
                  data-slot="nutrients-empty-token-link"
                >
                  <KeyRound aria-hidden="true" />
                  {t("nutrients.page.emptyTokenAction")}
                </Link>
              </Button>
            }
          />
        )}
      </SubPageShell>
    );
  }

  // Which cards exist depends on the overview (the codes with data in the
  // window), so the spine below the always-present hydration card waits for
  // it and then mounts in one step, each card with its own skeleton, instead
  // of cards popping in one by one between their siblings.
  return (
    <SubPageShell
      title={t("nutrients.page.title")}
      description={t("nutrients.page.description")}
    >
      <HydrationCard />
      {overview.isLoading ? null : (
        <>
          <EnergyMacrosCard />
          <SingleNutrientCard
            code="caffeine"
            icon={Coffee}
            metaKey="nutrients.caffeine.ceilingMeta"
            loadErrorKey="nutrients.caffeine.loadError"
          />
          <SingleNutrientCard
            code="alcohol"
            icon={Wine}
            metaKey={null}
            loadErrorKey="nutrients.alcohol.loadError"
          />
          <MicronutrientsCard />
        </>
      )}
    </SubPageShell>
  );
}
