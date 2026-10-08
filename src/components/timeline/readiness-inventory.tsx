"use client";

/**
 * The readiness inventory (v1.42, #613): one row per lane with what it holds
 * ("carries", "thin", "empty"), exactly one link per gap, and the verdict as
 * a plain count — never a score. Shown in the sheet that opens when the
 * module is switched on, and in the timeline's "Data coverage" entry.
 *
 * Every word comes from the bundle, keyed by what the server sent. A key the
 * bundle does not know is left out rather than shown raw.
 */
import Link from "next/link";
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Contrast,
} from "lucide-react";

import type {
  TimelineReadinessLane,
  TimelineReadinessResponse,
  TimelineReadinessStatus,
} from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";
import { isCalendarDateKey } from "@/lib/tz/date-only";
import { cn } from "@/lib/utils";

import { formatMonthYear } from "./timeline-dates";
import { orderedReadinessLanes, readinessTally } from "./readiness-model";

type Translate = ReturnType<typeof useTranslations>["t"];
type TranslateCount = ReturnType<typeof useTranslations>["tCount"];

/** Params with every calendar date worded as "March 2019". */
function wordedParams(
  params: Record<string, string | number>,
  intl: string,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] =
      typeof v === "string" && isCalendarDateKey(v)
        ? formatMonthYear(v, intl)
        : v;
  }
  return out;
}

/**
 * Word a key under `base`: through the plural tiers when the bundle has them
 * and a `count` is given, else as one string; null when the bundle has
 * neither.
 */
export function wordKey(
  t: Translate,
  tCount: TranslateCount,
  base: string,
  params: Record<string, string | number>,
): string | null {
  const count = typeof params.count === "number" ? params.count : null;
  if (count !== null && t(`${base}Other`) !== `${base}Other`) {
    return tCount(base, count, params);
  }
  const single = t(base, params);
  return single === base ? null : single;
}

export function laneLabel(t: Translate, key: TimelineReadinessLane["key"]) {
  if (
    key === "values" ||
    key === "mood" ||
    key === "environment" ||
    key === "life"
  ) {
    return t(`timeline.readiness.lanes.${key}`);
  }
  return t(`timeline.lanes.${key}`);
}

const STATUS_ICON: Record<TimelineReadinessStatus, typeof CircleCheck> = {
  carries: CircleCheck,
  thin: Contrast,
  empty: CircleDashed,
};

const STATUS_CLASS: Record<TimelineReadinessStatus, string> = {
  carries: "text-success",
  thin: "text-warning",
  empty: "text-muted-foreground",
};

export function VerdictMeter({
  readiness,
}: {
  readiness: Pick<TimelineReadinessResponse, "lanes" | "verdict" | "since">;
}) {
  const { t, locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  const { carrying, total } = readinessTally(readiness);
  const label = t("timeline.readiness.meter", { carrying, total });
  return (
    <div
      className="bg-muted/60 flex flex-col items-start gap-2 rounded-lg px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3"
      data-slot="timeline-readiness-verdict"
      data-verdict={readiness.verdict}
    >
      <div className="flex shrink-0 gap-1" role="img" aria-label={label}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 w-4 rounded-full",
              i < carrying ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </div>
      <p className="text-sm">
        <span className="font-semibold">
          {t(`timeline.readiness.verdict.${readiness.verdict}`)}
        </span>
        {readiness.verdict === "carries" && (
          <>
            {" "}
            {readiness.since
              ? t("timeline.readiness.carriesDetail", {
                  carrying,
                  total,
                  since: formatMonthYear(readiness.since, intl),
                })
              : t("timeline.readiness.meter", { carrying, total })}
          </>
        )}
      </p>
    </div>
  );
}

export function ReadinessInventory({
  readiness,
  onNavigate,
}: {
  readiness: TimelineReadinessResponse;
  onNavigate?: () => void;
}) {
  const { t, tCount, locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  return (
    <ul className="divide-border divide-y" data-slot="timeline-readiness-lanes">
      {orderedReadinessLanes(readiness).map((lane) => {
        const Icon = STATUS_ICON[lane.status];
        const detail =
          lane.key === "life" && lane.status === "empty"
            ? t("lifeEvents.emptyHint")
            : lane.detail
              ? wordKey(
                  t,
                  tCount,
                  `timeline.readiness.detail.${lane.detail.key}`,
                  wordedParams(lane.detail.params, intl),
                )
              : null;
        const gap = lane.gaps[0];
        const gapLabel = gap
          ? wordKey(t, tCount, `timeline.readiness.gap.${gap.key}`, {
              count: gap.count,
            })
          : null;
        return (
          <li
            key={lane.key}
            className="grid grid-cols-[1.25rem_1fr_auto] items-start gap-x-3 py-3"
            data-slot="timeline-readiness-lane"
            data-lane={lane.key}
            data-status={lane.status}
          >
            <Icon
              className={cn("mt-0.5 size-4", STATUS_CLASS[lane.status])}
              aria-label={t(`timeline.readiness.status.${lane.status}`)}
              role="img"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">{laneLabel(t, lane.key)}</p>
              {detail && (
                <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>
              )}
            </div>
            {gap && gapLabel ? (
              <Link
                href={gap.href}
                onClick={onNavigate}
                data-slot="timeline-readiness-gap"
                data-gap={gap.key}
                className="text-foreground hover:bg-accent focus-visible:ring-ring/50 -my-2 inline-flex min-h-11 items-center gap-0.5 rounded-md px-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 sm:min-h-9"
              >
                {gapLabel}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Link>
            ) : (
              <span />
            )}
          </li>
        );
      })}
    </ul>
  );
}
