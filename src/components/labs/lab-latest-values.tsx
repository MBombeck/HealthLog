"use client";

import Link from "next/link";
import { ListOrdered } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { useTranslations } from "@/lib/i18n/context";
import { labUnitText } from "@/lib/labs/dimensionless";

import { ReferenceRangeBadge } from "./reference-range-badge";
import type { LabResultDto } from "./types";
import { useLabDate, useLabNumber } from "./use-lab-format";

/** How many readings the detail page lists under its chart. */
export const LATEST_VALUES_SHOWN = 5;

/**
 * The newest readings of one marker as a small table under its chart, with
 * a link to the full list. "What was my LDL last time?" used to need the
 * unlabelled list icon in the header; now the answer is on the page.
 */
export function LabLatestValues({
  readings,
  biomarkerId,
}: {
  /** Newest first. */
  readings: ReadonlyArray<LabResultDto>;
  biomarkerId: string;
}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const labDate = useLabDate();
  const shown = readings.slice(0, LATEST_VALUES_SHOWN);
  if (shown.length === 0) return null;
  return (
    <Card data-slot="lab-latest-values">
      <CardHeader>
        <TileHeader
          icon={ListOrdered}
          title={t("labs.detail.latestValues")}
          right={
            <InlineAction asChild size="sm">
              <Link href={`/labs/${biomarkerId}/values`}>
                {t("labs.detail.allValues")}
              </Link>
            </InlineAction>
          }
        />
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">{t("labs.detail.columnDate")}</th>
              <th scope="col">{t("labs.detail.columnValue")}</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {shown.map((reading) => (
              <tr key={reading.id} data-slot="lab-latest-value">
                <td className="text-muted-foreground py-2 pr-3 text-xs whitespace-nowrap">
                  {labDate(reading.takenAt)}
                </td>
                <td className="py-2 pr-3 font-medium tabular-nums">
                  {reading.value !== null
                    ? labNumber(reading.value, reading.sourceValue)
                    : (reading.valueText ?? "")}
                  {reading.value !== null && labUnitText(reading.unit) ? (
                    <span className="text-muted-foreground ml-1 text-xs font-normal">
                      {labUnitText(reading.unit)}
                    </span>
                  ) : null}{" "}
                  {/* Draws nothing for a reading without usable bounds. */}
                  <ReferenceRangeBadge
                    status={reading.rangeStatus}
                    compact
                    className="ml-1 align-middle"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
