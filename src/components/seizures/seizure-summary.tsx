"use client";

/**
 * The diary's figures over the period (#1368), as the server derived them:
 * recorded seizures, seizure days, days since the last recorded seizure, the
 * longest run without one, cluster episodes under the record's rule with
 * NICE's count beside it, and the type × month table. "Recorded" is in every
 * label on purpose: a diary under-counts, and the page must not read as an
 * outcome.
 */
import { CalendarDays } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { SeizureDiaryDTO } from "@/lib/seizures/shared";

import { typeName } from "./seizure-format";

export function SeizureSummary({ diary }: { diary: SeizureDiaryDTO }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const s = diary.summary;
  const typeById = new Map(diary.types.map((ty) => [ty.id, ty]));
  const rule = t("seizures.report.ruleText", {
    count: diary.settings.rule.count,
    hours: diary.settings.rule.windowHours,
  });
  const months = s.monthly.months;
  const rows = s.monthly.rows.filter((r) => r.total > 0);

  const figures: Array<{ label: string; value: string; slot: string }> = [
    {
      label: t("seizures.summary.recorded", { days: s.days }),
      value: String(s.seizures),
      slot: "recorded",
    },
    {
      label: t("seizures.summary.seizureDays"),
      value: String(s.seizureDays),
      slot: "days",
    },
    {
      label: t("seizures.summary.sinceLast"),
      value:
        s.streak.daysSinceLast === null ? "—" : String(s.streak.daysSinceLast),
      slot: "since-last",
    },
    {
      label: t("seizures.summary.longestFree"),
      value: String(s.streak.longestFreeDays),
      slot: "longest-free",
    },
    {
      label: t("seizures.summary.clusters", { rule }),
      value: String(s.clusters.length),
      slot: "clusters",
    },
    {
      label: t("seizures.summary.niceClusters"),
      value: String(s.niceClusterCount),
      slot: "nice-clusters",
    },
  ];

  return (
    <Card data-slot="seizure-summary">
      <CardHeader>
        <TileHeader icon={CalendarDays} title={t("seizures.summary.title")} />
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
          {figures.map((f) => (
            <div
              key={f.slot}
              className="rounded-lg border p-3"
              data-figure={f.slot}
            >
              <dt className="text-muted-foreground text-xs">{f.label}</dt>
              <dd className="text-foreground text-2xl font-semibold tabular-nums">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
        {s.suspected > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("seizures.summary.suspected", { count: s.suspected })}
          </p>
        ) : null}
        {s.clusters.length > 0 ? (
          <ul className="space-y-1">
            {s.clusters.slice(0, 5).map((c) => (
              <li key={c.startAt} className="text-foreground text-sm">
                {t("seizures.summary.clusterLine", {
                  start: fmt.dateTime(c.startAt),
                  count: c.seizureCount,
                })}
              </li>
            ))}
          </ul>
        ) : null}
        {rows.length > 0 ? (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-muted-foreground mb-2 text-left text-xs">
                {t("seizures.summary.monthlyCaption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="py-1 pr-3 text-left font-medium">
                    {t("seizures.report.type")}
                  </th>
                  {months.map((m) => (
                    <th
                      key={m}
                      scope="col"
                      className="px-2 py-1 text-right font-medium tabular-nums"
                    >
                      {m.slice(2).replace("-", "/")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.typeProfileId ?? "untyped"} className="border-t">
                    <th scope="row" className="py-1 pr-3 text-left font-normal">
                      {typeName(
                        r.typeProfileId
                          ? typeById.get(r.typeProfileId)
                          : undefined,
                        t,
                      )}
                    </th>
                    {months.map((m) => (
                      <td key={m} className="px-2 py-1 text-right tabular-nums">
                        {r.counts[m] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {t("seizures.summary.undercount")}
        </p>
      </CardContent>
    </Card>
  );
}
