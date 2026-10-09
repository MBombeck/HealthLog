"use client";

/**
 * `/timeline` (v1.42, #613): years at a glance. Conditions, allergies,
 * medications, vaccinations, visits, documents and the person's own life
 * events in lanes, up to six value lines below them, each in its own
 * colour (`series-colors.ts`), all on one
 * time axis. Nothing on the page draws a connection between them.
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
import { CalendarRange, Plus } from "lucide-react";

import { openDay as openDayLayer } from "@/components/day/day-layer-controller";
import { parseDayParam } from "@/components/day/day-url";
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
  type TimelineBucket,
  type TimelineLaneKey,
  type TimelineZoom,
} from "@/lib/day/contract";
import type { MeasurementType } from "@/generated/prisma/client";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import type { ModuleKey } from "@/lib/modules/registry";

import type { ChronicleGrouping } from "./chronicle-model";
import {
  TIMELINE_BLOOD_PRESSURE_SERIES_KEY,
  TIMELINE_LEGEND_MEAN_KEY,
  TIMELINE_ZOOM_LABEL_KEY,
} from "./label-keys";
import { LifeEventSheet } from "./life-event-sheet";
import { ReadinessCard } from "./readiness-card";
import {
  READINESS_CARD_DISMISSED_KEY,
  showReadinessCard,
} from "./readiness-model";
import { TimelineReadinessSheet } from "./readiness-sheet";
import { Segmented } from "./segmented";
import { SERIES_FALLBACK_COLOR, assignSeriesColors } from "./series-colors";
import { useSeriesValueFormat } from "./use-series-value-format";
import { SelectionBar } from "./selection-bar";
import { TimelineChart } from "./timeline-chart";
import { TimelineChronicle } from "./timeline-chronicle";
import { dayKey, dayNumber, todayKeyIn } from "./timeline-dates";
import { RangeFields } from "./range-fields";
import {
  clampRange,
  parseTimelineUrl,
  timelineSearch,
  type TimelineRange,
} from "./timeline-url";
import { LANE_ORDER, latestDataDate, windowFor } from "./timeline-geometry";
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

export function TimelineView() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const caps = useRecordCapabilities();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = todayKeyIn(user?.timezone);
  const dayParam = parseDayParam(searchParams.get(DAY_QUERY_PARAM), today);
  // Life events are written in one's own record only (owner-only routes).
  const canAddLifeEvent = !caps.inSharedRecord;

  // The zoom and a chosen range live in the URL (`timeline-url.ts`), so Back
  // and a bookmark return to them. Without a `zoom`, an incoming `?day=`
  // opens three months around that day and anything else the whole record.
  const urlState = parseTimelineUrl(searchParams, today);
  const zoom: TimelineZoom = urlState.zoom ?? (dayParam ? "quarter" : "all");
  const range = zoom === "range" ? urlState.range : null;
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
  // One colour per chosen line, shared by the chart, the selection bar, the
  // menu and the phone chronicle; contested colours go by the menu's order.
  const seriesColors = useMemo(
    () => assignSeriesColors(values, VALUE_OPTIONS),
    [values],
  );
  const seriesFormat = useSeriesValueFormat();
  const seriesColor = (key: string) =>
    seriesColors.get(key) ?? SERIES_FALLBACK_COLOR;
  const hidden = useMemo(
    () => new Set(hiddenList as TimelineLaneKey[]),
    [hiddenList],
  );

  const requestWindow =
    zoom === "all"
      ? null
      : zoom === "range"
        ? range
        : windowFor(zoom, today, selected ?? dayParam);
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
  // A pick outside a newly chosen range no longer counts as one.
  const chosen =
    selected !== null &&
    (!requestWindow ||
      (selected >= requestWindow.from && selected <= requestWindow.to))
      ? selected
      : null;
  // Before anyone picks a day, the newest bucket the bar has something for,
  // inside the window that was asked for.
  const effectiveSelected =
    chosen ??
    (data ? latestDataDate(data, today, requestWindow ?? data.range) : null) ??
    (range ? range.to : today);

  function navigate(nextZoom: TimelineZoom, nextRange: TimelineRange | null) {
    const search = timelineSearch(window.location.search, nextZoom, nextRange);
    window.history.pushState(null, "", `${pathname}${search}`);
  }

  function setZoom(next: TimelineZoom) {
    if (next !== "range") {
      navigate(next, null);
      return;
    }
    // A new range starts as what is on screen, up to today.
    const shown = window_ ?? {
      from: dayKey(dayNumber(today) - 29),
      to: today,
    };
    navigate("range", clampRange(shown, today, data?.range.dataFrom ?? null));
  }

  // The shell's day layer owns `?day=` and its history entries; this only
  // asks it to open the day, and keeps the selection on it.
  function openDay(date: string) {
    if (date > today) return;
    setPicked({ date, param: date });
    openDayLayer(date);
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
      ? t(TIMELINE_BLOOD_PRESSURE_SERIES_KEY[key])
      : key === "MOOD"
        ? t("timeline.readiness.lanes.mood")
        : t(MEASUREMENT_TYPE_LABEL_KEYS[key as MeasurementType] ?? key);

  const window_ = data
    ? windowFor(
        zoom,
        today,
        effectiveSelected,
        zoom === "all" || zoom === "range" ? data.range : null,
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
    label: t(TIMELINE_ZOOM_LABEL_KEY[z]),
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

  // The chosen range's fields, under the zoom; on a phone with a way back to
  // the whole record, since the phone has no zoom control to switch with.
  const rangeControls =
    zoom === "range" && range ? (
      <div className="flex flex-wrap items-end gap-3">
        <RangeFields
          range={range}
          today={today}
          dataFrom={data?.range.dataFrom ?? null}
          onChange={(next) => navigate("range", next)}
        />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-10 md:hidden"
          onClick={() => setZoom("all")}
          data-slot="timeline-range-clear"
        >
          {t("timeline.range.clear")}
        </Button>
      </div>
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
      ) : zoom === "range" && (isEmpty || !data || !window_) ? (
        // A chosen stretch with nothing in it: the fields stay, so the next
        // choice is one step away.
        <div className="space-y-4" data-slot="timeline-range-empty">
          {rangeControls}
          <EmptyState
            title={t("timeline.selection.empty")}
            action={
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setZoom("all")}
              >
                {t("timeline.range.clear")}
              </Button>
            }
          />
        </div>
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
                  color={seriesColor}
                  onChange={setStoredValues}
                />
                {layers(false)}
              </div>
            </div>
            {rangeControls}
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
                  seriesColor={seriesColor}
                  seriesFormat={seriesFormat}
                  onSelect={setSelected}
                  onOpenDay={openDay}
                />
                <SelectionBar
                  timeline={data}
                  selected={effectiveSelected}
                  showHint={chosen === null}
                  today={today}
                  seriesLabel={seriesLabel}
                  seriesColor={seriesColor}
                  seriesFormat={seriesFormat}
                  onOpenDay={openDay}
                  onEditLifeEvent={canAddLifeEvent ? editLifeEvent : undefined}
                />
                <Legend
                  bucket={data.bucket}
                  hasSeries={data.series.length > 0}
                />
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
              <div className="flex items-center gap-2">
                <Button
                  variant={zoom === "range" ? "secondary" : "outline"}
                  size="icon"
                  className="size-11"
                  aria-label={t("timeline.range.open")}
                  aria-pressed={zoom === "range"}
                  onClick={() => setZoom(zoom === "range" ? "all" : "range")}
                  data-slot="timeline-range-toggle"
                >
                  <CalendarRange className="size-4" aria-hidden="true" />
                </Button>
                {layers(true)}
              </div>
            </div>
            {rangeControls}
            <TimelineChronicle
              timeline={{
                ...data,
                lanes: data.lanes.filter((l) => !hidden.has(l.key)),
              }}
              today={today}
              grouping={grouping}
              selected={dayParam}
              seriesColor={seriesColor}
              seriesFormat={seriesFormat}
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

function Legend({
  bucket,
  hasSeries,
}: {
  bucket: TimelineBucket;
  hasSeries: boolean;
}) {
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
      {hasSeries && (
        <>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-mean"
            data-bucket={bucket}
          >
            <span className="bg-foreground h-0.5 w-4" aria-hidden="true" />
            {t(TIMELINE_LEGEND_MEAN_KEY[bucket])}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="border-foreground bg-card size-2 rounded-full border"
              aria-hidden="true"
            />
            {t("timeline.legendThin")}
          </span>
        </>
      )}
    </div>
  );
}
