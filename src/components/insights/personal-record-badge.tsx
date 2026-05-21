"use client";

/**
 * v1.4.25 W16c — Personal-record "PR" pill.
 *
 * Renders a small, text-only "PR" tag next to a metric label when the
 * given metric reached an all-time best in the last 30 days. Pulls
 * directly from `GET /api/personal-records?metricType=<type>` so the
 * server's `PersonalRecord` rows are the single source of truth — no
 * client-side recomputation, no risk of drift against the doctor
 * report's PR list.
 *
 * Design choices:
 *   - Text-only (no celebratory emoji / no animation). The badge is
 *     informational and the same Recharts-restrained aesthetic the
 *     rest of the trend tiles use.
 *   - Tooltip is opt-in via the `withTooltip` prop. The dashboard's
 *     tile strip already runs a `TooltipProvider`, so the badge can
 *     drop straight in. Standalone uses (correlation cards, doctor
 *     report) pass `withTooltip={false}` to keep the DOM minimal.
 *   - Query is per-metric — 14 PR-trackable metrics × ~1 KB response =
 *     small enough that 14 idle queries on the dashboard cost less
 *     than one Recharts re-render. TanStack Query coalesces.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { MeasurementType } from "@/generated/prisma/client";
import { cn } from "@/lib/utils";

interface PersonalRecordRow {
  id: string;
  metricType: MeasurementType;
  metricSlot: string | null;
  value: number;
  unit: string;
  achievedAt: string;
}

interface PersonalRecordBadgeProps {
  metricType: MeasurementType;
  /** Render a wrapping Tooltip with the PR value + date. Default true. */
  withTooltip?: boolean;
  /** Optional className passthrough so callers can position the pill. */
  className?: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pure freshness check kept out of the component body so the React
 * purity linter doesn't trip on the `Date.now()` reference; callers
 * pass `now` from the surrounding query refetch boundary where one
 * stale-time tick = one new clock reading.
 */
function isPRWithin30Days(achievedAtIso: string, now: number): boolean {
  const ts = new Date(achievedAtIso).getTime();
  return Number.isFinite(ts) && now - ts <= THIRTY_DAYS_MS;
}

export function PersonalRecordBadge({
  metricType,
  withTooltip = true,
  className,
}: PersonalRecordBadgeProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, dataUpdatedAt } = useQuery({
    // Per-metric queryKey so two tiles for two different metrics never
    // share a cache slot (HealthLog convention — see
    // `feedback_react_query_key_collision`).
    queryKey: ["personal-records", "by-metric", metricType],
    queryFn: async () => {
      const res = await fetch(
        `/api/personal-records?metricType=${encodeURIComponent(metricType)}`,
      );
      if (!res.ok) return [] as PersonalRecordRow[];
      return ((await res.json()).data ?? []) as PersonalRecordRow[];
    },
    // Per-tile data: stale-while-revalidate cadence matches the
    // dashboard's existing trend queries. 5 minutes is enough to
    // absorb the worker's 30-minute fallback cadence without
    // surfacing stale state for long.
    staleTime: 5 * 60 * 1000,
  });

  // `dataUpdatedAt` is TanStack Query's per-query refetch timestamp
  // — a deterministic clock reading that React's purity linter
  // accepts because it's hook-derived. Each refetch advances it,
  // shifting the freshness window forward by exactly the stale time.
  // On the very first render (before the query has resolved)
  // `dataUpdatedAt` is 0, so the freshness filter rejects everything
  // until the response lands — desired behaviour for the SSR path.
  const fresh = (data ?? []).find(
    (row) =>
      row.metricSlot === null && isPRWithin30Days(row.achievedAt, dataUpdatedAt),
  );

  if (!fresh) return null;

  const pill = (
    <span
      data-slot="insights-pr-badge"
      data-metric-type={metricType}
      className={cn(
        // `--success` resolves to the AA-tuned green per theme: a deep
        // forest green on the light card (#14720a) and Dracula's neon
        // green on the dark card (#50fa7b). Both clear 4.5:1 against
        // their card background — the previous `text-dracula-green` on
        // `bg-dracula-green/10` measured ~2.6:1 in dark mode.
        "border-success/40 bg-success/15 text-success inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-wide tabular-nums uppercase",
        className,
      )}
      aria-label={t("insights.personalRecord.badge")}
    >
      {t("insights.personalRecord.badge")}
    </span>
  );

  if (!withTooltip) return pill;

  const formattedDate = fmt.date(new Date(fresh.achievedAt));
  const tooltipText = t("insights.personalRecord.tooltip", {
    value: fmt.number(fresh.value, 1),
    unit: fresh.unit,
    date: formattedDate,
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent
        className="bg-muted border-border text-foreground"
        data-slot="insights-pr-badge-tooltip"
      >
        <span className="text-xs">{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  );
}
