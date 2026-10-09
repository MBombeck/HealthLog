"use client";

/**
 * `<NutrientIntakeCard>` — Settings → Sources, read-only synced-nutrient
 * list (v1.28).
 *
 * The smallest honest surface for the opt-in `nutrients` module: a flat
 * list of what the server holds — per nutrient the latest synced day
 * total and the days-with-data count over the last 14 days — so the
 * user can verify the sync works and see exactly what the account
 * stores. No route slug, no nav entry, no chart, no edit affordance;
 * the module toggle in the Modules hub is the consent surface and the
 * card links to it. Rendered only when the module is on (resolved
 * module map from `useAuth().user.modules`, the environment-section
 * pattern); reads unwrap through `apiGet`, the key rides the
 * centralized factory.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Leaf } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

const WINDOW_DAYS = 14;

/** Wire `ug` renders as µg; mg / ml pass through. */
const UNIT_LABELS: Record<string, string> = { mg: "mg", ug: "µg", ml: "ml" };

interface NutrientOverviewRow {
  nutrient: string;
  unit: string;
  latestDay: string;
  latestAmount: number;
  daysWithData: number;
}

interface NutrientIntakeOverview {
  windowDays: number;
  nutrients: NutrientOverviewRow[];
}

function formatAmount(amount: number): string {
  // Day totals arrive as floats; one decimal is plenty for a glance
  // list and trailing zeros read as noise.
  return String(Math.round(amount * 10) / 10);
}

export function NutrientIntakeCard() {
  const { t } = useTranslations();
  const { user } = useAuth();

  const enabled = user?.modules?.nutrients === true;

  const overview = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    enabled,
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
  });

  if (!enabled) return null;

  const rows = overview.data?.nutrients ?? [];

  return (
    <SettingsCard data-slot="nutrient-intake-card">
      <SettingsCardHeader
        anchor="nutrient-intake"
        icon={Leaf}
        title={t("settings.sections.sources.nutrients.title")}
        description={t("settings.sections.sources.nutrients.description", {
          days: WINDOW_DAYS,
        })}
      />
      <p className="text-sm">
        {t("settings.sections.sources.nutrients.detail")}
      </p>
      {overview.isLoading ? (
        <div className="space-y-1" aria-hidden="true">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("settings.sections.sources.nutrients.empty")}
        />
      ) : (
        <ul className="divide-border divide-y rounded-md border" role="list">
          {rows.map((row) => (
            <li
              key={row.nutrient}
              data-slot="nutrient-intake-row"
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 p-2"
            >
              <span className="text-sm">
                {t(`nutrients.names.${row.nutrient}`)}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {t("settings.sections.sources.nutrients.latest", {
                  amount: formatAmount(row.latestAmount),
                  unit: UNIT_LABELS[row.unit] ?? row.unit,
                  date: row.latestDay,
                })}
                {" · "}
                {t("settings.sections.sources.nutrients.daysWithData", {
                  count: row.daysWithData,
                  days: WINDOW_DAYS,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">
        {t("settings.sections.sources.nutrients.moduleHint")}{" "}
        <Link
          href="/settings/modules"
          className="text-primary underline underline-offset-2"
          data-slot="nutrient-intake-modules-link"
        >
          {t("settings.sections.sources.nutrients.moduleHintLink")}
        </Link>
      </p>
    </SettingsCard>
  );
}
