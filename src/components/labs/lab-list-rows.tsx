"use client";

/**
 * One marker of the labs list, in both view shapes: a row of the compact
 * five-column table and a tile of the card grid. `lab-list.tsx` decides which
 * markers show and in what order (flat, or under their categories); these
 * render one marker each.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { MedicationCardHeader } from "@/components/medications/medication-card-header";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { labUnitLabel } from "@/lib/labs/dimensionless";
import { formatLabReading } from "@/lib/labs/format-value";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { cn } from "@/lib/utils";

import { LabConvertedNote } from "./lab-converted-note";
import { LabReferenceRangeBar } from "./lab-reference-range-bar";
import { LabTrendSparkline } from "./lab-trend-sparkline";
import { ReferenceRangeBadge } from "./reference-range-badge";
import { SourceRangeNote } from "./source-range-note";
import type { LabOverviewMarkerDto, LabResultDto } from "./types";
import { useLabDate, useLabNumber } from "./use-lab-format";

export interface MarkerRow {
  /** Stable key: `bm:<biomarkerId>`, or `analyte:<lower>` for legacy rows. */
  key: string;
  /** Link target when the marker is catalog-linked; null for legacy rows. */
  biomarkerId: string | null;
  analyte: string;
  panel: string | null;
  /** The marker's unit as the card names it ("No unit" for a ratio). */
  unit: string;
  /** Every live reading of the marker, counted by the server. */
  count: number;
  /** Values of the newest readings, oldest first, for the sparkline. */
  trend: (number | null)[];
  latest: LabResultDto;
}

/**
 * One row per marker, as the server resolved it over the whole history. A
 * catalog-linked row deep-links to its detail chart; legacy rows render inert
 * until the backfill links them. The server already orders by the newest
 * reading.
 */
export function toMarkerRows(
  markers: LabOverviewMarkerDto[],
  t: (key: string) => string,
): MarkerRow[] {
  return markers.map((marker) => ({
    key: marker.key,
    biomarkerId: marker.latest.biomarkerId,
    analyte: marker.latest.analyte,
    panel: marker.latest.panel,
    unit: labUnitLabel(marker.latest.unit, t),
    count: marker.count,
    trend: marker.trend,
    latest: marker.latest,
  }));
}

/**
 * The compact list is a five-column table from `lg` up: name and reading, range
 * badge, range bar, trend, chevron. Below that the same five cells fold into
 * two lines per row, because the fixed columns alone (badge + 12rem bar + 72px
 * trend + gaps) are wider than a phone, and the only flexible column — the
 * name — was the one that gave way: it collapsed to nothing and the row
 * panned sideways off the card.
 *
 * Phone layout, per row:
 *
 *     name / reading · date      badge   ›
 *     range bar                  trend
 *
 * The placement classes are all `max-lg:` so the desktop table keeps exactly
 * the subgrid it had.
 *
 * `@container` on the card makes the columns follow the width the list has,
 * not the window's: below `@5xl` (64rem of card) the row is the `lg` table it
 * always was (the two tiers exclude each other, so the result does not depend
 * on the order the CSS is emitted in), from there up the range bar takes part
 * of the extra width instead of all of it going to the name. The trend column
 * stays 72px in both tiers: the sparkline is a fixed 72px glyph, and a wider
 * column would only open an empty strip between it and the chevron.
 */
export const LIST_GRID_CLASS =
  "divide-border grid grid-cols-1 divide-y p-0 lg:gap-x-3 lg:@max-5xl:grid-cols-[minmax(0,1fr)_max-content_12rem_72px_auto] @5xl:grid-cols-[minmax(0,1fr)_max-content_minmax(12rem,18rem)_72px_auto]";

/** A block of rows inside the table that keeps the table's five columns. */
export const LIST_SUBGRID_CLASS =
  "divide-border grid min-w-0 grid-cols-1 divide-y lg:col-span-full lg:grid-cols-subgrid";

const ROW_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 lg:col-span-full lg:grid-cols-subgrid lg:gap-y-0";

const MOBILE_CELL = {
  reading: "max-lg:col-start-1 max-lg:row-start-1",
  badge: "max-lg:col-start-2 max-lg:row-start-1 max-lg:justify-self-end",
  rangeBar: "max-lg:col-start-1 max-lg:row-start-2 max-lg:empty:hidden",
  trend:
    "max-lg:col-start-2 max-lg:row-start-2 max-lg:justify-self-end max-lg:empty:hidden",
  end: "max-lg:col-start-3 max-lg:row-start-1",
  notLinked: "max-lg:col-span-full max-lg:row-start-3",
} as const;

/**
 * The badge's grid cell. The badge renders nothing for a reading without a
 * reference range, and a missing cell would pull the range bar and the trend
 * one column to the left; the wrapper keeps every row at five cells.
 */
function RangeBadgeCell({ status }: { status: LabResultDto["rangeStatus"] }) {
  return (
    <div data-slot="lab-list-badge-cell" className={MOBILE_CELL.badge}>
      <ReferenceRangeBadge status={status} compact className="lg:w-full" />
    </div>
  );
}

function LabRangeBarSlot({ reading }: { reading: LabResultDto }) {
  return (
    <div className={cn("w-full", MOBILE_CELL.rangeBar)}>
      {/* A phone keeps the bar's own 12rem cap; from `lg` the bar fills its
          column, which is 12rem until the list is wide enough to grow it. */}
      <LabReferenceRangeBar
        className="lg:max-w-none"
        value={reading.value}
        referenceLow={reading.referenceLow}
        referenceHigh={reading.referenceHigh}
        unit={reading.unit}
      />
    </div>
  );
}

function TrendCell({ row }: { row: MarkerRow }) {
  return (
    <div className={cn("w-[72px]", MOBILE_CELL.trend)}>
      <LabTrendSparkline
        values={row.trend}
        referenceLow={row.latest.referenceLow}
        referenceHigh={row.latest.referenceHigh}
      />
    </div>
  );
}

/** One marker as a row of the compact table. */
export function LabListRow({ row }: { row: MarkerRow }) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const labDate = useLabDate();
  const inner = (
    <div className={cn("min-w-0 flex-1", MOBILE_CELL.reading)}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        {/* One line with an ellipsis on a phone; from `lg` the name wraps
            instead, so a long one (the schema allows 120 characters) always
            reads in full. It wraps between words and hyphenates in the page
            language; a word is only cut when it is wider than the column on
            its own (`anywhere` cut "Hämoglobin" in the middle of the word
            whenever the column was a little short). */}
        <span
          data-slot="lab-list-analyte"
          className="truncate font-medium lg:overflow-visible lg:break-words lg:text-clip lg:hyphens-auto lg:whitespace-normal"
        >
          {row.analyte}
        </span>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
        <span className="text-foreground font-semibold tabular-nums">
          {formatLabReading(row.latest, labNumber)}
        </span>
        <span>{labDate(row.latest.takenAt)}</span>
        <LabConvertedNote reading={row.latest} />
      </div>
    </div>
  );
  // The whole row navigates into the detail (where delete lives).
  if (row.biomarkerId) {
    return (
      <Link
        href={`/labs/${row.biomarkerId}`}
        className={cn(ROW_CLASS, "hover:bg-muted/40 transition-colors")}
      >
        {inner}
        <RangeBadgeCell status={row.latest.rangeStatus} />
        <LabRangeBarSlot reading={row.latest} />
        <TrendCell row={row} />
        {/* With a pointer the row's hover already says it opens; a phone has
            no hover, so the chevron stays there. */}
        <ChevronRight
          className={cn(
            "text-muted-foreground h-4 w-4 shrink-0 lg:invisible",
            MOBILE_CELL.end,
          )}
        />
      </Link>
    );
  }
  // Un-linked marker (not backfilled to a catalog biomarker): render inert
  // but say so, so it doesn't read as a broken link next to its clickable
  // neighbours.
  return (
    <div className={ROW_CLASS}>
      {inner}
      <RangeBadgeCell status={row.latest.rangeStatus} />
      <LabRangeBarSlot reading={row.latest} />
      <TrendCell row={row} />
      <span
        className={cn(
          "text-muted-foreground shrink-0 text-xs italic",
          MOBILE_CELL.notLinked,
        )}
      >
        {t("labs.notLinkedYet")}
      </span>
    </div>
  );
}

/**
 * One marker as a tile. The tile reuses the medication module's
 * `MedicationCardHeader` so a lab tile reads identically to a medication or
 * Vorsorge tile side-by-side: name on line 1, the reference-range badge as the
 * line-1 chip, the panel as the category badge. Under a category heading the
 * panel would say the heading again, so the badge names the unit there. No
 * delete control on the tile; the trash icon lives only on the value detail
 * view.
 */
export function LabCard({
  row,
  underCategory,
}: {
  row: MarkerRow;
  underCategory: boolean;
}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const labDate = useLabDate();
  const latest = row.latest;
  return (
    <li className="contents">
      <Card className="h-full gap-3">
        <MedicationCardHeader
          name={row.analyte}
          dose=""
          categoryLabel={underCategory ? row.unit : (row.panel ?? row.unit)}
          nameChip={<ReferenceRangeBadge status={latest.rangeStatus} compact />}
          href={row.biomarkerId ? `/labs/${row.biomarkerId}` : undefined}
          linkLabel={row.analyte}
        />
        <CardContent>
          <div className="flex items-end justify-between gap-3">
            <div className="text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-sm">
              <span className="text-foreground font-semibold tabular-nums">
                {formatLabReading(latest, labNumber)}
              </span>
              {latest.value !== null &&
              (latest.referenceLow !== null ||
                latest.referenceHigh !== null) ? (
                <span className="text-xs">
                  {t("labs.referenceLabel")}{" "}
                  {formatReferenceRange(
                    latest.referenceLow,
                    latest.referenceHigh,
                    labNumber,
                  )}
                </span>
              ) : null}
              <SourceRangeNote reading={latest} className="text-xs" />
              <span className="text-xs">{labDate(latest.takenAt)}</span>
              <LabConvertedNote reading={latest} />
              {row.count > 1 ? (
                <span className="text-xs">
                  {t("labs.readingsCount", { count: row.count })}
                </span>
              ) : null}
              <LabReferenceRangeBar
                value={latest.value}
                referenceLow={latest.referenceLow}
                referenceHigh={latest.referenceHigh}
                unit={latest.unit}
              />
            </div>
            <LabTrendSparkline
              values={row.trend}
              referenceLow={latest.referenceLow}
              referenceHigh={latest.referenceHigh}
            />
          </div>
          {/* Un-linked marker: the header renders no link, so name the reason
              rather than leaving a card that silently does nothing on tap. */}
          {!row.biomarkerId ? (
            <p className="text-muted-foreground text-xs italic">
              {t("labs.notLinkedYet")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}
