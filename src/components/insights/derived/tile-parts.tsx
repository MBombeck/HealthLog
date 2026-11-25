"use client";

import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { TileHeader } from "@/components/insights/tile-header";
import { InfoPopover } from "@/components/ui/info-popover";
import { TrendTile } from "@/components/ui/trend-tile";
import { resolveTileLayout, type InsightsLayout } from "@/lib/insights-layout";
import type { DerivedProvenance } from "@/lib/insights/derived/types";
import { CoverageMeter } from "./coverage-meter";
import { METRIC_PROVENANCE, type MetricProvenanceMeta } from "./standards";
import { type DerivedBatchRead } from "./use-derived-metric";

/**
 * The pieces every tile of the vitals dashboard shares: the layout
 * visibility check, the (i) provenance trigger, the still-building tile and
 * the props a tile reads the batch through. Their own module so the
 * dashboard and the "Today so far" tile (`same-time-tile.tsx`) use one copy.
 */

/**
 * `true` when the layout marks this tile id visible (or the layout does not
 * enumerate the id, in which case the tile is always-on). A `null` layout
 * (caller passed none) is treated as everything-visible.
 */
export function tileVisible(
  layout: InsightsLayout | undefined,
  tileId: string,
): boolean {
  if (!layout) return true;
  return resolveTileLayout(layout, tileId).visible;
}

export interface TileProps {
  read: DerivedBatchRead;
  isLoading: boolean;
  /** The headline of a metric tile: its latest reading (`headlineValue`). */
  headline: (type: string) => number | null;
}

/**
 * The (i) info-tip trigger for one derived metric, wired from the map.
 * `provenance` (inputs / source / window / asOf) isn't rendered here — the
 * shared `InfoPopover` carries only the method/caveat + cited standard,
 * mirroring what `ProvenanceExplainer` itself renders today — but the param
 * is kept so every call site (which already reads `data.provenance` off the
 * derived batch) doesn't need touching if a future pass restores the detail.
 */
export function MetricProvenance({
  metric,
  meta: metaOverride,
}: {
  metric: keyof typeof METRIC_PROVENANCE;
  provenance: DerivedProvenance;
  /** A method of its own for one form of the metric (the day-total form). */
  meta?: MetricProvenanceMeta;
}) {
  const { t } = useTranslations();
  const meta = metaOverride ?? METRIC_PROVENANCE[metric];
  const method = (
    <>
      {meta.caveatKey ? (
        <span className="text-warning block font-medium">
          {t(meta.caveatKey)}
        </span>
      ) : null}
      {t(meta.methodKey)}
    </>
  );
  return (
    <InfoPopover
      content={method}
      link={meta.standard}
      label={t("insights.derived.vitals.infoLabel")}
    />
  );
}

/**
 * A tile whose band is still being built: the header, one sentence saying how
 * far the history has come, and the coverage meter. The baseline, same-time
 * and HRV tiles each spelled this out by hand.
 */
export function BuildingTile({
  slot,
  metric,
  state,
  icon,
  title,
  message,
  messageSlot,
  coverage,
}: {
  slot: string;
  metric: string;
  state: string;
  icon: LucideIcon;
  title: string;
  message: string;
  messageSlot: string;
  coverage: ComponentProps<typeof CoverageMeter>["coverage"];
}) {
  return (
    <TrendTile
      data-slot={slot}
      data-metric={metric}
      data-state={state}
      className="gap-3"
    >
      <TileHeader icon={icon} title={title} titleAs="h2" reserveLines={2} />
      <p className="text-muted-foreground text-sm" data-slot={messageSlot}>
        {message}
      </p>
      <CoverageMeter coverage={coverage} />
    </TrendTile>
  );
}
