"use client";

/**
 * The overview's plan: how the medication is taken, in one table. Intake,
 * period, reminder, supply, the person's note and the leaflet, with "Edit"
 * opening the wizard.
 */

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { MedicationLeafletRow } from "@/components/medications/detail/medication-leaflet-section";
import { useCadenceLine } from "@/components/medications/medication-detail-summary";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import type { MedicationDetailSnapshot } from "@/components/medications/detail/medication-detail-tabs";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDate as formatCalendarDate } from "@/lib/date-format";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import type { SupplySummary } from "@/lib/medications/inventory/summary";
import { estimateRunwayDays } from "@/lib/medications/supply-runway";
import { queryKeys } from "@/lib/query-keys";

/** One plan row: the name left, the value right, a rule between rows. */
const PLAN_ROW =
  "border-border/60 flex min-h-11 items-start justify-between gap-4 border-b py-2.5 text-sm last:border-b-0 md:[&:nth-last-child(2):nth-child(odd)]:border-b-0";

export function PlanCard({
  medication,
  payload,
  recordOnly,
  asNeeded,
  oneShot,
  onEdit,
}: {
  medication: MedicationDetailSnapshot;
  payload: MedicationPayload;
  recordOnly: boolean;
  asNeeded: boolean;
  oneShot: boolean;
  onEdit?: () => void;
}) {
  const { t, locale } = useTranslations();
  const dateFormatPref = useDateFormatPreference();
  const { canManageDomain } = useRecordCapabilities();
  const cadence = useCadenceLine({
    payload,
    oneShot,
    asNeeded,
    startsOn: medication.startsOn,
  });
  const id = medication.id;

  // The supply tab's read and cache cell; the row shows once items exist.
  const { data: inventory } = useQuery({
    queryKey: queryKeys.medicationInventory(id),
    queryFn: () =>
      apiGet<{
        items: Array<{ state: string }>;
        summary?: SupplySummary;
      } | null>(`/api/medications/${id}/inventory`),
    enabled: canManageDomain("medications"),
    staleTime: 30_000,
  });
  const hasSupply =
    Array.isArray(inventory?.items) && inventory.items.length > 0;
  const summary = inventory?.summary;
  // The server's slot-aware runway; the estimate only for an older payload
  // that does not carry one.
  const runway =
    medication.runwayDays !== undefined
      ? medication.runwayDays
      : estimateRunwayDays(summary?.dosesRemaining ?? 0, medication.schedules);

  const calendar = (iso: string) =>
    formatCalendarDate(new Date(iso), dateFormatPref, locale);
  const period = medication.startsOn
    ? medication.endsOn
      ? t("medications.detail.overview.plan.range", {
          start: calendar(medication.startsOn),
          end: calendar(medication.endsOn),
        })
      : t("medications.detail.overview.plan.since", {
          date: calendar(medication.startsOn),
        })
    : null;
  const grace = medication.schedules[0]?.reminderGraceMinutes ?? 30;
  const reminder =
    asNeeded || recordOnly
      ? null
      : medication.autoMarkTaken
        ? t("medications.detail.overview.plan.autoRecorded")
        : medication.notificationsEnabled
          ? t("medications.detail.overview.plan.reminderOn", {
              minutes: grace,
            })
          : t("medications.detail.uebersicht.reminderOff");

  const rows: { key: string; label: string; value: ReactNode }[] = [
    {
      key: "intake",
      label: t("medications.detail.overview.intake.title"),
      value: cadence,
    },
    ...(period
      ? [
          {
            key: "period",
            label: t("medications.detail.settingsTab.groups.period"),
            value: period,
          },
        ]
      : []),
    ...(reminder
      ? [
          {
            key: "reminder",
            label: t("medications.detail.uebersicht.reminderLabel"),
            value: reminder,
          },
        ]
      : []),
    ...(hasSupply && summary
      ? [
          {
            key: "supply",
            label: t("medications.detail.uebersicht.supplyLabel"),
            value: [
              t("medications.detail.bestand.summary", {
                remaining: summary.dosesRemaining,
                total: summary.dosesTotal,
              }),
              summary.expiredUnits > 0
                ? t("medications.detail.bestand.expiredSuffix", {
                    units: summary.expiredUnits,
                  })
                : null,
              runway !== null
                ? t("medications.detail.uebersicht.supplyRunway", {
                    days: runway,
                  })
                : null,
            ]
              .filter(Boolean)
              .join(", "),
          },
        ]
      : []),
    ...(medication.note
      ? [
          {
            key: "note",
            label: t("common.note"),
            value: (
              <span
                className="whitespace-pre-line"
                data-slot="medication-detail-note"
              >
                {medication.note}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card data-slot="medication-overview-plan">
      <CardHeader>
        <TileHeader
          icon={Clock}
          title={t("medications.detail.overview.plan.title")}
          titleAs="h2"
          right={
            onEdit ? (
              <InlineAction
                onClick={onEdit}
                data-slot="medication-overview-plan-edit"
              >
                {t("common.edit")}
              </InlineAction>
            ) : null
          }
        />
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 md:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.key}
              className={PLAN_ROW}
              data-slot={`medication-overview-plan-${row.key}`}
            >
              <dt className="text-muted-foreground shrink-0">{row.label}</dt>
              <dd className="text-foreground min-w-0 text-right">
                {row.value}
              </dd>
            </div>
          ))}
          <MedicationLeafletRow medication={medication} className={PLAN_ROW} />
        </dl>
      </CardContent>
    </Card>
  );
}
