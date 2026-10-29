"use client";

/**
 * `/timeline` (v1.42, #613): years at a glance. Conditions, allergies,
 * medications, vaccinations, visits, documents and the person's own life
 * events in lanes, the value lines the person picks below them (as many as
 * the record has kinds of value), each in its own colour
 * (`series-colors.ts`), all on one time axis. Nothing on the page draws a
 * connection between them.
 *
 * The page hands off to the day view through `?day=`: "Open 3 Jan." (and
 * Enter on the chart, a double click, a chip, a chronicle row) pushes the
 * parameter onto the current entry's URL, the day layer opens over the page,
 * and Back closes it. An incoming `?day=` selects that day and zooms to
 * three months, so a day's "In the timeline" lands on itself.
 *
 * Lab markers the record has values for are offered beside the measurements
 * (#1299): a chosen marker is stored and requested like any other line, as
 * `lab:<biomarkerId>`, and drawn as its single readings, never as means.
 *
 * At 768 px and up the chart; below it the chronicle, which is also the
 * list form of the chart. The readiness card sits on top while a lane is
 * thin and the person has not closed it; empty lanes are never drawn.
 */
import { useCallback, useMemo, useState } from "react";
import { setAllParams, useUrlSearch, writeUrlState } from "@/lib/url-state";
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
  timelineLabMarkerId,
  type LifeEventDTO,
  type TimelineLaneKey,
  type TimelineResponse,
  type TimelineZoom,
} from "@/lib/day/contract";
import type { MeasurementType } from "@/generated/prisma/client";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import type { ModuleKey } from "@/lib/modules/registry";

import type { ChronicleGrouping } from "./chronicle-model";
import {
  TIMELINE_BLOOD_PRESSURE_SERIES_KEY,
  TIMELINE_ZOOM_LABEL_KEY,
} from "./label-keys";
import { LabExcludedNote } from "./lab-lines";
import { TimelineLegend } from "./timeline-legend";
import { LifeEventSheet } from "./life-event-sheet";
import { ReadinessCard } from "./readiness-card";
import {
  READINESS_CARD_DISMISSED_KEY,
  showReadinessCard,
} from "./readiness-model";
import { TimelineReadinessSheet } from "./readiness-sheet";
import { Segmented } from "@/components/ui/segmented";
import { SERIES_PALETTE, assignSeriesColors } from "./series-colors";
import { useSeriesValueFormat } from "./use-series-value-format";
import { SelectionBar } from "./selection-bar";
import { TimelineChart } from "./timeline-chart";
import { TimelineChronicle } from "./timeline-chronicle";
import { dayKey, dayNumber, todayKeyIn } from "./timeline-dates";
import { RangeFields } from "./range-fields";
import { RangeSheet, ZoomControl } from "./range-picker";
import {
  clampRange,
  DEFAULT_ZOOM,
  hasDataBeforeWindow,
  parseTimelineUrl,
  resolveDefaultWindow,
  timelineSearch,
  type TimelineRange,
} from "./timeline-url";
import { LANE_ORDER, latestDataDate, windowFor } from "./timeline-geometry";
import {
  LayersMenu,
  TimelineValuesMenu,
  labMarkerNames,
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

/**
 * Every series name the page can ask for: each measurement type, and the
 * mood score. A stored choice outside it is dropped before it reaches the
 * request, so a stale entry never turns the page into a 422.
 */
const KNOWN_SERIES: ReadonlySet<string> = new Set([
  ...Object.keys(MEASUREMENT_TYPE_LABEL_KEYS),
  "MOOD",
]);

/** The order colours are handed out in: the selector's own, then the rest. */
const SERIES_RANK: readonly string[] = [
  ...new Set([...VALUE_OPTIONS, ...KNOWN_SERIES]),
];

export const DEFAULT_VALUES = [
  "BLOOD_PRESSURE_SYS",
  "WEIGHT",
  "RESTING_HEART_RATE",
];

/** Nothing to draw: no lane item, nothing standing, no reading. */
function timelineIsEmpty(data: TimelineResponse): boolean {
  return (
    data.lanes.every((l) => l.items.length === 0) &&
    data.standing.length === 0 &&
    data.series.every((s) => s.points.length === 0) &&
    data.labSeries.every((s) => s.points.length === 0)
  );
}

const VALUES_KEY = "healthlog.timeline.values";
const HIDDEN_LANES_KEY = "healthlog.timeline.hiddenLanes";

/**
 * The value lines asked for: the stored choice, minus anything unknown and
 * minus a line whose module is off, and one colour per chosen line.
 */
function useValueLines(
  modules: Partial<Record<ModuleKey, boolean>> | undefined,
) {
  const [storedValues, setStoredValues] = useDevicePreference(
    VALUES_KEY,
    DEFAULT_VALUES,
    isStringArray,
  );
  // What is asked for: the stored choice, minus anything unknown and minus
  // a line whose module is off. The server narrows it further to what the
  // caller may see.
  const allowed = useCallback(
    (key: string) => {
      // A lab line belongs to the labs module; whether the record has the
      // marker is the server's to say.
      if (timelineLabMarkerId(key) !== null) return modules?.labs !== false;
      if (!KNOWN_SERIES.has(key)) return false;
      const owner: ModuleKey | null | undefined =
        VALUE_OPTION_MODULE[key as keyof typeof VALUE_OPTION_MODULE];
      return !owner || modules?.[owner] !== false;
    },
    [modules],
  );
  const values = useMemo(
    () => storedValues.filter(allowed),
    [storedValues, allowed],
  );
  // One colour per chosen line, shared by the chart, the selection bar, the
  // menu and the phone chronicle; contested colours go by the menu's order.
  const seriesColors = useMemo(
    () => assignSeriesColors(values, SERIES_RANK),
    [values],
  );
  const seriesColor = (key: string) =>
    seriesColors.get(key) ?? SERIES_PALETTE[0];
  return { values, allowed, setStoredValues, seriesColor };
}

export function TimelineView() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const caps = useRecordCapabilities();
  // Read live (`@/lib/url-state`): the router's copy trails a write by a
  // render, and the zoom, the range and `?day=` are all written here.
  const searchParams = useUrlSearch();
  const today = todayKeyIn(user?.timezone);
  const dayParam = parseDayParam(searchParams.get(DAY_QUERY_PARAM), today);
  // Life events are written in one's own record only (owner-only routes).
  const canAddLifeEvent = !caps.inSharedRecord;

  // The zoom and a chosen range live in the URL (`timeline-url.ts`), so Back
  // and a bookmark return to them. Without a `zoom` the page opens on three
  // months: around an incoming `?day=`, otherwise up to today.
  const urlState = parseTimelineUrl(searchParams, today);
  const askedZoom: TimelineZoom = urlState.zoom ?? DEFAULT_ZOOM;
  const range = askedZoom === "range" ? urlState.range : null;
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
  const [rangeSheetOpen, setRangeSheetOpen] = useState(false);
  const [lifeEventOpen, setLifeEventOpen] = useState(false);
  const [editing, setEditing] = useState<LifeEventDTO | null>(null);

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
  const { values, allowed, setStoredValues, seriesColor } =
    useValueLines(modules);
  const seriesFormat = useSeriesValueFormat();
  const hidden = useMemo(
    () => new Set(hiddenList as TimelineLaneKey[]),
    [hiddenList],
  );

  const askedWindow =
    askedZoom === "all"
      ? null
      : askedZoom === "range"
        ? range
        : windowFor(askedZoom, today, selected ?? dayParam);
  // Opened without a zoom on three months that hold nothing, while the
  // record has entries from before them: open on everything instead of a
  // dead end. The URL stays as it is, so choosing a zoom still works. Once
  // decided it holds until the URL names a zoom, so picking or opening a
  // day on the full view does not snap it back to three months.
  const [opensOnAll, setOpensOnAll] = useState(false);
  if (opensOnAll && urlState.zoom !== null) setOpensOnAll(false);
  const asked = useTimeline(
    askedZoom,
    askedWindow?.from ?? null,
    askedWindow?.to ?? null,
    values,
    !opensOnAll,
  );
  // Without a zoom the window adapts to the record (`resolveDefaultWindow`):
  // decided from the three months' answer, before anything is drawn, so the
  // page never draws one window and then jumps to another.
  const defaultWindow =
    urlState.zoom === null &&
    !opensOnAll &&
    askedWindow &&
    asked.data &&
    !asked.isPlaceholderData
      ? resolveDefaultWindow({
          dataFrom: asked.data.range.dataFrom,
          window: askedWindow,
          windowHasData: !timelineIsEmpty(asked.data),
          today,
        })
      : null;
  if (defaultWindow?.zoom === "all") setOpensOnAll(true);
  const youngFrom =
    defaultWindow?.zoom === "quarter" ? defaultWindow.from : null;
  const everything = useTimeline("all", null, null, values, opensOnAll);
  const zoom: TimelineZoom = opensOnAll ? "all" : askedZoom;
  const requestWindow = opensOnAll ? null : askedWindow;
  const timeline = opensOnAll ? everything : asked;
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
      writeUrlState((params) => params.delete("add"));
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
    writeUrlState(
      (params) => {
        const next = timelineSearch(`?${params}`, nextZoom, nextRange);
        setAllParams(next)(params);
      },
      { mode: "push" },
    );
  }

  function setZoom(next: Exclude<TimelineZoom, "range">) {
    navigate(next, null);
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

  const labNames = labMarkerNames(data);
  // Blood pressure reads as its own name here; the list labels ("Sys",
  // "Dia") lean on a column header the chart does not have. A lab marker
  // reads by its own name, as on the labs list.
  const seriesLabel = (key: string) =>
    key === "BLOOD_PRESSURE_SYS" || key === "BLOOD_PRESSURE_DIA"
      ? t(TIMELINE_BLOOD_PRESSURE_SERIES_KEY[key])
      : key === "MOOD"
        ? t("timeline.readiness.lanes.mood")
        : (labNames.get(key) ??
          t(MEASUREMENT_TYPE_LABEL_KEYS[key as MeasurementType] ?? key));

  const shownWindow = data
    ? windowFor(
        zoom,
        today,
        effectiveSelected,
        zoom === "all" || zoom === "range" ? data.range : null,
      )
    : null;
  // A young record's three months start at its first entry.
  const window_ =
    shownWindow && youngFrom && youngFrom > shownWindow.from
      ? { from: youngFrom, to: shownWindow.to }
      : shownWindow;
  // A new range starts as the chosen one, or as what is on screen, up to
  // today.
  const rangeDraft = clampRange(
    range ??
      window_ ?? {
        from: dayKey(dayNumber(today) - 29),
        to: today,
      },
    today,
    data?.range.dataFrom ?? null,
  );
  const valuesMenu = (iconOnly: boolean) => (
    <TimelineValuesMenu
      timeline={data}
      values={values}
      allowed={allowed}
      rank={SERIES_RANK}
      labsOn={modules?.labs !== false}
      label={seriesLabel}
      color={seriesColor}
      onChange={setStoredValues}
      iconOnly={iconOnly}
    />
  );
  const presentLanes = (data?.lanes ?? [])
    .filter((l) => l.items.length > 0)
    .map((l) => l.key)
    .sort((a, b) => LANE_ORDER.indexOf(a) - LANE_ORDER.indexOf(b));
  const isEmpty = !!data && timelineIsEmpty(data);
  // An empty window with entries before it offers everything.
  const showEverything =
    !!data &&
    zoom !== "all" &&
    hasDataBeforeWindow(data.range.dataFrom, requestWindow);

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

  // A chosen stretch with nothing in it keeps its fields on the page, so the
  // next choice is one step away; everywhere else they open in a popover
  // (or a sheet on a phone) and never push the chart down.
  const emptyRangeFields =
    zoom === "range" && range ? (
      <RangeFields
        range={range}
        today={today}
        dataFrom={data?.range.dataFrom ?? null}
        onChange={(next) => navigate("range", next)}
      />
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
          error={timeline.error}
          description={t("timeline.loadFailed")}
          onRetry={() => void timeline.refetch()}
        />
      ) : zoom === "range" && (isEmpty || !data || !window_) ? (
        // A chosen stretch with nothing in it: the fields stay, so the next
        // choice is one step away.
        <div className="space-y-4" data-slot="timeline-range-empty">
          {emptyRangeFields}
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
      ) : showEverything && (isEmpty || !window_) ? (
        // A window with nothing in it while the record has older entries:
        // one step to all of them.
        <EmptyState
          data-slot="timeline-window-empty"
          title={t("timeline.selection.empty")}
          action={
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={() => setZoom("all")}
              data-slot="timeline-show-everything"
            >
              {t("timeline.range.clear")}
            </Button>
          }
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
            data-zoom={zoom}
            data-from={range?.from}
            data-to={range?.to}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ZoomControl
                options={zoomOptions}
                zoom={zoom}
                label={t("timeline.zoomLabel")}
                initialRange={rangeDraft}
                today={today}
                dataFrom={data.range.dataFrom}
                onZoom={setZoom}
                onApply={(next) => navigate("range", next)}
              />
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {valuesMenu(false)}
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
                <TimelineLegend
                  bucket={data.bucket}
                  hasSeries={data.series.length > 0}
                  labSeries={data.labSeries}
                  label={seriesLabel}
                />
              </CardContent>
            </Card>
          </div>

          {/* Phone: the chronicle. */}
          <div
            className="space-y-4 md:hidden"
            data-slot="timeline-mobile"
            data-zoom={zoom}
            data-from={range?.from}
            data-to={range?.to}
          >
            <div className="flex items-center justify-between gap-3">
              <Segmented
                options={groupingOptions}
                value={grouping}
                onChange={setGrouping}
                label={t("timeline.chronicle.groupingLabel")}
                slot="timeline-grouping"
              />
              <div className="flex items-center gap-2">
                {valuesMenu(true)}
                <Button
                  variant={zoom === "range" ? "secondary" : "outline"}
                  size="icon"
                  className="size-11"
                  aria-label={t("timeline.range.open")}
                  aria-pressed={zoom === "range"}
                  onClick={() => setRangeSheetOpen(true)}
                  data-slot="timeline-range-toggle"
                >
                  <CalendarRange className="size-4" aria-hidden="true" />
                </Button>
                {layers(true)}
              </div>
            </div>
            <RangeSheet
              open={rangeSheetOpen}
              onOpenChange={setRangeSheetOpen}
              initialRange={rangeDraft}
              today={today}
              dataFrom={data.range.dataFrom}
              onApply={(next) => navigate("range", next)}
              onClear={zoom === "range" ? () => setZoom("all") : null}
            />
            <LabExcludedNote
              labSeries={data.labSeries}
              label={seriesLabel}
              block
            />
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
