"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode, type Ref } from "react";
import {
  ChevronLeft,
  ChevronRight,
  History,
  MessageCircle,
  PanelBottomClose,
  PanelRightClose,
  Plus,
} from "lucide-react";

import {
  CAPTURE_KIND_ORDER,
  CapturePicker,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { useModuleEnabled } from "@/hooks/use-module-enabled";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { DAY_QUERY_PARAM, type DateKey } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import type { DayFocus } from "./day-layer-controller";
import {
  DayEvents,
  DayFocusCard,
  DayNotableLines,
  DayRunning,
  DayValues,
} from "./day-sections";
import { curateDayValues, tileKeyOf } from "./day-values-model";
import { shiftDateKey } from "./day-url";
import { useDay, usePrefetchDay } from "./use-day";
import { useDayValueFormat } from "./use-day-value-format";

/**
 * One day, as the layer shows it in every shell: a header with the date and
 * the way to the neighbouring days, the sections, and a footer with the two
 * ways onward.
 *
 * The shell decides only the frame (docked column, sheet from the right,
 * sheet from the bottom). Header, body and footer are this component, so the
 * three frames cannot drift apart.
 */

/** "Saturday, 3 January 2026", for the header and the spoken name. */
export function useLongDayLabel(
  length: "long" | "short" = "long",
): (date: DateKey) => string {
  const { locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  return (date: DateKey) =>
    new Intl.DateTimeFormat(intl, {
      weekday: length,
      day: "numeric",
      month: length,
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T12:00:00.000Z`));
}

export interface DayViewProps {
  date: DateKey;
  today: DateKey;
  focus: DayFocus | null;
  shell: "docked" | "sheet" | "bottom";
  onClose: () => void;
  onStep: (delta: number) => void;
  /** The heading element: an `h2`, or the sheet primitive's title. */
  Title: ComponentType<{
    id?: string;
    className?: string;
    children: ReactNode;
    ref?: Ref<HTMLHeadingElement>;
    tabIndex?: number;
  }>;
  titleId: string;
  titleRef?: Ref<HTMLHeadingElement>;
  /** Shell chrome above the header (the bottom sheet's grabber). */
  above?: ReactNode;
  /** Classes for the header row, which the docked shell aligns to the top bar. */
  headerClassName?: string;
}

const ICON_BUTTON =
  "text-muted-foreground hover:text-foreground size-11 shrink-0 pointer-fine:size-9";

/**
 * The close control is the Coach panel's own toggle, in the same place: the
 * panel's top-left corner, the panel icon mirrored so it points the way the
 * panel goes. Same size and glyph as `PANEL_HEADER_BUTTON` there (kept as a
 * copy so the day layer does not pull the Coach's panel into the shell).
 */
const PANEL_TOGGLE =
  "text-muted-foreground hover:text-foreground size-11 shrink-0 pointer-fine:size-7";
const PANEL_TOGGLE_ICON = "size-5 pointer-fine:size-4";

export function DayView({
  date,
  today,
  focus,
  shell,
  onClose,
  onStep,
  Title,
  titleId,
  titleRef,
  above,
  headerClassName,
}: DayViewProps) {
  const { t, tCount } = useTranslations();
  const longLabel = useLongDayLabel();
  // "Mo., 5. Okt. 2026" in the phone sheet's header: a September Thursday
  // spelled out in full does not fit beside the arrows at 360 px, and a
  // date cut off before its year reads as the wrong day.
  const shortLabel = useLongDayLabel("short");
  const pathname = usePathname();
  const day = useDay(date);
  const { labelFor, formatTile } = useDayValueFormat();
  const timelineOn = useModuleEnabled("timeline");
  const coach = useAiCapability("coach");
  const capabilities = useRecordCapabilities();
  const { user } = useAuth();
  const [captureOpen, setCaptureOpen] = useState(false);
  // The neighbouring day is read while the pointer rests on its arrow (or
  // the keyboard reaches it, or a finger lands on it), so the step paints a
  // day, not a skeleton.
  const prefetchDay = usePrefetchDay();
  const warm = (delta: number) => () => {
    const next = shiftDateKey(date, delta);
    if (delta > 0 && next > today) return;
    prefetchDay(next);
  };

  const canCapture =
    visibleCaptureKinds(capabilities, CAPTURE_KIND_ORDER, user?.modules)
      .length > 0;
  const onTimeline = pathname.startsWith("/timeline");
  const data = day.data;
  const focusTypes = focus?.types ?? [];
  const focusKeys = new Set(focusTypes.map(tileKeyOf));
  const focusNotables =
    data?.notable.filter(
      (n) => n.type !== null && focusKeys.has(tileKeyOf(n.type)),
    ) ?? [];
  const otherNotables =
    data?.notable.filter(
      (n) => !(n.type !== null && focusKeys.has(tileKeyOf(n.type))),
    ) ?? [];
  const focusTile =
    focus && data
      ? curateDayValues(data.values, focusTypes).curated.find((tile) =>
          focusKeys.has(tile.key),
        )
      : undefined;
  const isEmpty =
    data !== undefined &&
    data.values.length === 0 &&
    data.events.length === 0 &&
    data.running.length === 0;
  const notShared = data
    ? Object.values(data.sections).some((s) => s?.reason === "not_shared")
    : false;
  const meta = data
    ? [
        tCount("day.countValues", data.counts.values),
        tCount("day.countEntries", data.counts.entries),
      ].join(" · ")
    : null;
  const compact = shell === "bottom";

  return (
    <div
      data-slot="day-view"
      data-day={date}
      className="flex min-h-0 flex-1 flex-col"
    >
      {above}
      <div
        data-slot="day-header"
        className={cn(
          "flex shrink-0 items-center gap-1",
          compact ? "pt-0.5 pr-2 pb-2 pl-2" : "border-border border-b px-3",
          headerClassName,
        )}
      >
        {/* Top left, where the Coach panel keeps its toggle: the way out. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="day-close"
          aria-label={t("day.close")}
          title={t("day.close")}
          onClick={onClose}
          className={PANEL_TOGGLE}
        >
          {compact ? (
            <PanelBottomClose
              className={PANEL_TOGGLE_ICON}
              aria-hidden="true"
            />
          ) : (
            <PanelRightClose
              className={cn(PANEL_TOGGLE_ICON, "-scale-x-100")}
              aria-hidden="true"
            />
          )}
        </Button>
        {/* One line, centred in the band: the date and nothing under it. */}
        <Title
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate px-1 text-base leading-snug font-semibold focus-visible:outline-none"
        >
          {compact ? (
            <>
              <span aria-hidden="true">{shortLabel(date)}</span>
              <span className="sr-only">{longLabel(date)}</span>
            </>
          ) : (
            longLabel(date)
          )}
        </Title>
        <Button
          type="button"
          variant={compact ? "ghost" : "outline"}
          size="icon"
          data-slot="day-prev"
          aria-label={t("day.previousDay")}
          title={t("day.previousDayShortcut")}
          onPointerEnter={warm(-1)}
          onPointerDown={warm(-1)}
          onFocus={warm(-1)}
          onClick={() => onStep(-1)}
          className={ICON_BUTTON}
        >
          <ChevronLeft
            className="size-5 pointer-fine:size-4"
            aria-hidden="true"
          />
        </Button>
        <Button
          type="button"
          variant={compact ? "ghost" : "outline"}
          size="icon"
          data-slot="day-next"
          aria-label={t("day.nextDay")}
          title={t("day.nextDayShortcut")}
          disabled={date >= today}
          onPointerEnter={warm(1)}
          onPointerDown={warm(1)}
          onFocus={warm(1)}
          onClick={() => onStep(1)}
          className={ICON_BUTTON}
        >
          <ChevronRight
            className="size-5 pointer-fine:size-4"
            aria-hidden="true"
          />
        </Button>
      </div>

      <div
        data-slot="day-body"
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain",
          compact ? "gap-6 px-4 pt-0.5 pb-4" : "gap-6 px-6 pt-5 pb-6",
        )}
      >
        {/* What the day holds, as meta under the header. The line keeps its
            height while the day loads, so nothing below it moves. */}
        <p
          className="text-muted-foreground -mb-3 text-xs tabular-nums"
          data-slot="day-meta"
        >
          {meta ?? <span className="invisible">·</span>}
        </p>
        {focus ? (
          <div className="space-y-2.5">
            <DayFocusCard
              focus={focus}
              usual={focusTile ? formatTile(focusTile).usual : null}
            />
            <DayNotableLines
              notables={focusNotables}
              labelFor={labelFor}
              withMetric={false}
            />
          </div>
        ) : null}

        {day.isError ? (
          <QueryErrorRow
            message={t("day.loadFailed")}
            onRetry={() => void day.refetch()}
            slot="day-error"
          />
        ) : data === undefined ? (
          <DaySkeleton />
        ) : isEmpty ? (
          <p className="text-muted-foreground text-sm" data-slot="day-empty">
            {t("day.empty")}
          </p>
        ) : (
          <>
            <DayRunning items={data.running} />
            {data.values.length > 0 ? (
              <div className="space-y-2.5">
                <DayValues values={data.values} focusTypes={focusTypes} />
                <DayNotableLines
                  notables={otherNotables}
                  labelFor={labelFor}
                  withMetric
                />
              </div>
            ) : (
              <DayNotableLines
                notables={otherNotables}
                labelFor={labelFor}
                withMetric
              />
            )}
            <DayEvents events={data.events} />
          </>
        )}

        {notShared ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="day-not-shared"
          >
            {t("day.notShared")}
          </p>
        ) : null}

        {coach.available && !capabilities.inSharedRecord ? (
          <Link
            href={`/coach?ask=${encodeURIComponent(
              t("day.askCoachPrompt", { date: longLabel(date) }),
            )}`}
            data-slot="day-ask-coach"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-2 self-start rounded-md text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none sm:min-h-9"
          >
            <MessageCircle className="size-4" aria-hidden="true" />
            {t("day.askCoach")}
          </Link>
        ) : null}
      </div>

      {canCapture || (timelineOn && !onTimeline) ? (
        <div
          data-slot="day-footer"
          className={cn(
            "border-border flex shrink-0 items-center justify-between gap-2 border-t",
            compact
              ? "px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]"
              : "px-6 py-3.5",
          )}
        >
          {timelineOn && !onTimeline ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className={cn("min-h-11 sm:min-h-9", compact && "flex-1")}
            >
              <Link
                href={`/timeline?${DAY_QUERY_PARAM}=${date}`}
                data-slot="day-in-timeline"
              >
                <History className="size-4" aria-hidden="true" />
                {compact ? t("day.inTimelineShort") : t("day.inTimeline")}
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {canCapture ? (
            <Button
              type="button"
              size="sm"
              data-slot="day-capture"
              onClick={() => setCaptureOpen(true)}
              className={cn("min-h-11 sm:min-h-9", compact && "flex-1")}
            >
              <Plus className="size-4" aria-hidden="true" />
              {compact ? t("day.captureShort") : t("day.captureForDay")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {canCapture ? (
        <CapturePicker
          open={captureOpen}
          onOpenChange={setCaptureOpen}
          defaultDate={date}
        />
      ) : null}
    </div>
  );
}

function DaySkeleton() {
  return (
    <div className="space-y-6" data-slot="day-loading" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}
