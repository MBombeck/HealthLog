"use client";

/**
 * `/timeline` (v1.42, #613): years at a glance. Conditions, allergies,
 * medications, vaccinations, visits, documents and the person's own life
 * events in lanes, up to three neutral value lines below them, all on one
 * time axis. "Stacked means at the same time, not cause and effect" is said
 * once, in the legend, and nothing on the page draws a connection.
 *
 * The page hands off to the day view through `?day=`: "Open 3 Jan." (and
 * Enter on the chart, a double click, a chip, a chronicle row) pushes the
 * parameter onto the current entry's URL, the day layer opens over the page,
 * and Back closes it. An incoming `?day=` selects that day and zooms to
 * three months, so a day's "In the timeline" lands on itself.
 *
 * At 768 px and up the chart; below it the chronicle, which is also the
 * list form of the chart. The readiness card sits on top while a lane is
 * thin and the person has not closed it; empty lanes are never drawn.
 */
import { useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  DAY_QUERY_PARAM,
  TIMELINE_ZOOMS,
  type LifeEventDTO,
  type TimelineLaneKey,
  type TimelineZoom,
} from "@/lib/day/contract";
import type { MeasurementType } from "@/generated/prisma/client";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import type { ModuleKey } from "@/lib/modules/registry";

import type { ChronicleGrouping } from "./chronicle-model";
import { LifeEventSheet } from "./life-event-sheet";
import { ReadinessCard } from "./readiness-card";
import {
  READINESS_CARD_DISMISSED_KEY,
  showReadinessCard,
} from "./readiness-model";
import { TimelineReadinessSheet } from "./readiness-sheet";
import { Segmented } from "./segmented";
import { SelectionBar } from "./selection-bar";
import { TimelineChart } from "./timeline-chart";
import { TimelineChronicle } from "./timeline-chronicle";
import { acceptableDayParam, todayKeyIn } from "./timeline-dates";
import { LANE_ORDER, windowFor } from "./timeline-geometry";
import {
  LayersMenu,
  MAX_VALUE_SERIES,
  ValueSeriesMenu,
} from "./timeline-menus";
import {
  isBoolean,
  isStringArray,
  useDevicePreference,
} from "./use-device-preference";
import {
  useLifeEvents,
  useTimeline,
  useTimelineReadiness,
} from "./use-timeline";

/**
 * Value lines offered in the selector, in this order, with the module that
 * owns each (null: core, never hidden). Spelled out rather than asked of
 * `moduleForMeasurementType`, whose signal registry would ride into this
 * chunk for eleven answers; `value-options.test.ts` holds the two equal.
 */
export const VALUE_OPTION_MODULE = {
  BLOOD_PRESSURE_SYS: null,
  BLOOD_PRESSURE_DIA: null,
  WEIGHT: null,
  RESTING_HEART_RATE: "recovery",
  PULSE: null,
  SLEEP_DURATION: "sleep",
  BLOOD_GLUCOSE: "glucose",
  BODY_FAT: null,
  HEART_RATE_VARIABILITY: "recovery",
  ACTIVITY_STEPS: null,
  MOOD: "mood",
} as const satisfies Record<string, ModuleKey | null>;

export const VALUE_OPTIONS = Object.keys(VALUE_OPTION_MODULE) as Array<
  keyof typeof VALUE_OPTION_MODULE
>;

export const DEFAULT_VALUES = [
  "BLOOD_PRESSURE_SYS",
  "WEIGHT",
  "RESTING_HEART_RATE",
];

const VALUES_KEY = "healthlog.timeline.values";
const HIDDEN_LANES_KEY = "healthlog.timeline.hiddenLanes";

/** The `?day=` URL for the current page, other parameters kept. */
export function dayHref(
  pathname: string,
  search: string,
  date: string,
): string {
  const next = new URLSearchParams(search);
  next.set(DAY_QUERY_PARAM, date);
  return `${pathname}?${next.toString()}`;
}

/** The latest dated entry on or before today, to select on arrival. */
function latestEntryDate(
  lanes: ReadonlyArray<{
    items: ReadonlyArray<{ start: string; end: string | null }>;
  }>,
  today: string,
): string | null {
  let best: string | null = null;
  for (const lane of lanes) {
    for (const item of lane.items) {
      for (const d of [item.start, item.end]) {
        if (d && d <= today && (!best || d > best)) best = d;
      }
    }
  }
  return best;
}

export function TimelineView() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const caps = useRecordCapabilities();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = todayKeyIn(user?.timezone);
  const dayParam = acceptableDayParam(searchParams.get(DAY_QUERY_PARAM), today);
  // Life events are written in one's own record only (owner-only routes).
  const canAddLifeEvent = !caps.inSharedRecord;

  const [zoom, setZoom] = useState<TimelineZoom>(dayParam ? "quarter" : "all");
  const [grouping, setGrouping] = useState<ChronicleGrouping>("month");
  // The selection follows `?day=` (Back, Forward, the day panel's previous
  // and next) and otherwise the last click or key. A pick remembers the
  // parameter it was made under; once the parameter moves, the parameter wins.
  const [picked, setPicked] = useState<{
    date: string;
    param: string | null;
  } | null>(null);
  const selected =
    picked && picked.param === dayParam
      ? picked.date
      : (dayParam ?? picked?.date ?? null);
  const setSelected = (date: string) => setPicked({ date, param: dayParam });
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [lifeEventOpen, setLifeEventOpen] = useState(false);
  const [editing, setEditing] = useState<LifeEventDTO | null>(null);

  const [storedValues, setStoredValues] = useDevicePreference(
    VALUES_KEY,
    DEFAULT_VALUES,
    isStringArray,
  );
  const [hiddenList, setHiddenList] = useDevicePreference<string[]>(
    HIDDEN_LANES_KEY,
    [],
    isStringArray,
  );
  const [cardDismissed, setCardDismissed] = useDevicePreference(
    READINESS_CARD_DISMISSED_KEY,
    false,
    isBoolean,
  );

  const modules = user?.modules;
  const valueOptions = useMemo(
    () =>
      VALUE_OPTIONS.filter((key) => {
        const owner: ModuleKey | null = VALUE_OPTION_MODULE[key];
        return owner === null || modules?.[owner] !== false;
      }),
    [modules],
  );
  const values = useMemo(
    () =>
      storedValues
        .filter((v) => (valueOptions as readonly string[]).includes(v))
        .slice(0, MAX_VALUE_SERIES),
    [storedValues, valueOptions],
  );
  const hidden = useMemo(
    () => new Set(hiddenList as TimelineLaneKey[]),
    [hiddenList],
  );

  const requestWindow =
    zoom === "all" ? null : windowFor(zoom, today, selected ?? dayParam);
  const timeline = useTimeline(
    zoom,
    requestWindow?.from ?? null,
    requestWindow?.to ?? null,
    values,
  );
  const readiness = useTimelineReadiness();
  const lifeEvents = useLifeEvents(canAddLifeEvent);

  // A readiness link (`?add=lifeEvent`) arrives with the sheet open; closing
  // it takes the parameter out of the URL, so a reload does not reopen it.
  const addRequested =
    searchParams.get("add") === "lifeEvent" && canAddLifeEvent;
  const sheetOpen = lifeEventOpen || addRequested;
  function setSheetOpen(open: boolean) {
    setLifeEventOpen(open);
    if (open) return;
    setEditing(null);
    if (searchParams.has("add")) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("add");
      const search = next.toString();
      window.history.replaceState(
        null,
        "",
        search ? `${pathname}?${search}` : pathname,
      );
    }
  }

  const data = timeline.data;
  const effectiveSelected =
    selected ?? (data ? latestEntryDate(data.lanes, today) : null) ?? today;

  function openDay(date: string) {
    if (date > today) return;
    setPicked({ date, param: date });
    window.history.pushState(
      { __healthlogTimelineDay: date },
      "",
      dayHref(pathname, searchParams.toString(), date),
    );
  }

  function editLifeEvent(id: string) {
    const event = lifeEvents.data?.events.find((e) => e.id === id);
    if (!event) return;
    setEditing(event);
    setLifeEventOpen(true);
  }

  // Blood pressure reads as its own name here; the list labels ("Sys",
  // "Dia") lean on a column header the chart does not have.
  const seriesLabel = (key: string) =>
    key === "BLOOD_PRESSURE_SYS" || key === "BLOOD_PRESSURE_DIA"
      ? t(`timeline.values.series.${key}`)
      : key === "MOOD"
        ? t("timeline.readiness.lanes.mood")
        : t(MEASUREMENT_TYPE_LABEL_KEYS[key as MeasurementType] ?? key);

  const window_ = data
    ? windowFor(
        zoom,
        today,
        effectiveSelected,
        zoom === "all" ? data.range : null,
      )
    : null;
  const presentLanes = (data?.lanes ?? [])
    .filter((l) => l.items.length > 0)
    .map((l) => l.key)
    .sort((a, b) => LANE_ORDER.indexOf(a) - LANE_ORDER.indexOf(b));
  const isEmpty =
    !!data &&
    presentLanes.length === 0 &&
    data.standing.length === 0 &&
    data.series.every((s) => s.points.length === 0);

  const zoomOptions = TIMELINE_ZOOMS.map((z) => ({
    value: z,
    label: t(`timeline.zoom.${z}`),
  }));
  const groupingOptions: Array<{ value: ChronicleGrouping; label: string }> = [
    { value: "year", label: t("timeline.chronicle.years") },
    { value: "month", label: t("timeline.chronicle.months") },
  ];

  const addButton = canAddLifeEvent ? (
    <Button
      variant="outline"
      size="sm"
      className="min-h-11 sm:min-h-9"
      onClick={() => {
        setEditing(null);
        setSheetOpen(true);
      }}
      aria-label={t("lifeEvents.add")}
      data-slot="timeline-add-life-event"
    >
      <Plus className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">{t("lifeEvents.add")}</span>
    </Button>
  ) : null;

  const layers = (iconOnly: boolean) => (
    <LayersMenu
      lanes={presentLanes}
      hidden={hidden}
      iconOnly={iconOnly}
      onToggle={(lane, visible) =>
        setHiddenList(
          visible
            ? hiddenList.filter((l) => l !== lane)
            : [...hiddenList.filter((l) => l !== lane), lane],
        )
      }
      onOpenReadiness={() => setReadinessOpen(true)}
    />
  );

  return (
    <div className="space-y-6" data-slot="timeline-page">
      <PageHeader
        title={t("timeline.title")}
        description={t("timeline.subtitle")}
        actions={addButton}
      />

      {readiness.data && showReadinessCard(readiness.data, cardDismissed) && (
        <ReadinessCard
          readiness={readiness.data}
          onDismiss={() => setCardDismissed(true)}
        />
      )}

      {timeline.isPending ? (
        <Card data-slot="timeline-loading">
          <CardContent className="space-y-3">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      ) : timeline.isError ? (
        <QueryErrorCard
          description={t("timeline.loadFailed")}
          onRetry={() => void timeline.refetch()}
        />
      ) : isEmpty || !data || !window_ ? (
        <EmptyState
          title={t("timeline.empty.title")}
          description={t("timeline.empty.description")}
          action={addButton}
        />
      ) : (
        <>
          {/* Desktop and tablet: the chart. */}
          <div
            className="hidden space-y-4 md:block"
            data-slot="timeline-desktop"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented
                options={zoomOptions}
                value={zoom}
                onChange={setZoom}
                label={t("timeline.zoomLabel")}
                slot="timeline-zoom"
              />
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ValueSeriesMenu
                  options={valueOptions}
                  selected={values}
                  label={seriesLabel}
                  onChange={setStoredValues}
                />
                {layers(false)}
              </div>
            </div>
            <Card className="md:gap-4">
              <CardContent className="space-y-4">
                <TimelineChart
                  timeline={data}
                  window={window_}
                  zoom={zoom}
                  today={today}
                  selected={effectiveSelected}
                  hiddenLanes={hidden}
                  seriesLabel={seriesLabel}
                  onSelect={setSelected}
                  onOpenDay={openDay}
                />
                <SelectionBar
                  timeline={data}
                  selected={effectiveSelected}
                  today={today}
                  onOpenDay={openDay}
                  onEditLifeEvent={canAddLifeEvent ? editLifeEvent : undefined}
                />
                <Legend />
              </CardContent>
            </Card>
          </div>

          {/* Phone: the chronicle. */}
          <div className="space-y-4 md:hidden" data-slot="timeline-mobile">
            <div className="flex items-center justify-between gap-3">
              <Segmented
                options={groupingOptions}
                value={grouping}
                onChange={setGrouping}
                label={t("timeline.chronicle.groupingLabel")}
                slot="timeline-grouping"
              />
              {layers(true)}
            </div>
            <TimelineChronicle
              timeline={{
                ...data,
                lanes: data.lanes.filter((l) => !hidden.has(l.key)),
              }}
              today={today}
              grouping={grouping}
              selected={dayParam}
              onOpenDay={openDay}
              onEditLifeEvent={canAddLifeEvent ? editLifeEvent : null}
            />
          </div>
        </>
      )}

      <TimelineReadinessSheet
        open={readinessOpen}
        onOpenChange={setReadinessOpen}
        showOpenTimeline={false}
      />
      {canAddLifeEvent && (
        <LifeEventSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          event={editing}
        />
      )}
    </div>
  );
}

function Legend() {
  const { t } = useTranslations();
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs"
      data-slot="timeline-legend"
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="bg-muted-foreground h-1.5 w-4 rounded-full"
          aria-hidden="true"
        />
        {t("timeline.legendSpan")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="bg-muted-foreground size-2 rounded-full"
          aria-hidden="true"
        />
        {t("timeline.legendEvent")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="bg-foreground h-0.5 w-4" aria-hidden="true" />
        {t("timeline.legendMean")}
      </span>
      <span className="sm:ml-auto" data-slot="timeline-legend-causality">
        {t("timeline.legend")}
      </span>
    </div>
  );
}
