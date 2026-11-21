"use client";

import { Baby } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";

import type { CyclePregnancy } from "./types";

/**
 * The cycle page's line while a pregnancy or postpartum state holds:
 * the week the server resolved, the owner's dates, and that the forecast is
 * paused. Present data only; nothing about what the week means.
 */
export function CyclePregnancyBanner({
  pregnancy,
}: {
  pregnancy: CyclePregnancy | undefined;
}) {
  const { t, locale } = useTranslations();
  if (!pregnancy?.state) return null;
  const day = (d: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(`${d}T12:00:00Z`));

  const title =
    pregnancy.state === "PREGNANT"
      ? pregnancy.gestationalWeeks !== null
        ? t("cycle.pregnancy.banner.pregnantWeek", {
            weeks: pregnancy.gestationalWeeks,
            days: pregnancy.gestationalDays ?? 0,
          })
        : t("cycle.pregnancy.banner.pregnant")
      : t("cycle.pregnancy.banner.postpartumWeek", {
          weeks: pregnancy.postpartumWeek ?? 0,
        });
  const dateLine =
    pregnancy.state === "PREGNANT"
      ? pregnancy.dueDate
        ? t("cycle.pregnancy.banner.due", { date: day(pregnancy.dueDate) })
        : null
      : pregnancy.postpartumEndsOn
        ? t("cycle.pregnancy.banner.resumes", {
            date: day(pregnancy.postpartumEndsOn),
          })
        : null;

  return (
    <Card density="compact" data-slot="cycle-pregnancy-banner">
      <CardHeader>
        <TileHeader icon={Baby} title={title} size="sm" />
      </CardHeader>
      <CardContent className="space-y-1">
        {dateLine ? <p className="text-sm">{dateLine}</p> : null}
        <p className="text-muted-foreground text-sm">
          {t("cycle.pregnancy.banner.paused")}
        </p>
      </CardContent>
    </Card>
  );
}
