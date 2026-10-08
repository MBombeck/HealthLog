"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ShellSidePanel } from "@/components/layout/shell-side-panel";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DAY_QUERY_PARAM, type DateKey } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  closeDay,
  publishOpenDay,
  stepDay,
  takeDayTrigger,
  useDayFocus,
} from "./day-layer-controller";
import { parseDayParam, withDayHref } from "./day-url";
import { DayView, useLongDayLabel } from "./day-view";
import { useTodayKey } from "./use-today-key";

/**
 * The day layer, mounted once by the shell so `?day=` opens a day over any
 * page.
 *
 * Three frames, one content (`DayView`):
 *
 *   - from 1280 px, a column docked beside the page, the same place and the
 *     same breakpoint as the Coach's conversations panel. Not modal: the
 *     chart beside it stays usable, and another point swaps the day. It is a
 *     landmark (`complementary`) named by the date.
 *   - from 768 px, a sheet from the right, modal.
 *   - on a phone, a sheet from the bottom at a bit over half the height, so
 *     the chart stays in view above it; dragging the handle up (or tapping
 *     it) takes it to full height, dragging it down closes it.
 *
 * On `/coach` the conversations panel already holds the side column, and
 * there is never more than one docked panel: the day opens as a sheet there.
 *
 * The parameter is the state. A date that is not a calendar date, or lies in
 * the future, is removed from the URL without a word.
 */
export function DayLayerMount() {
  // `useSearchParams` suspends a statically rendered route until the client
  // has the URL; the boundary keeps that from blanking the page around it.
  return (
    <Suspense fallback={null}>
      <DayLayer />
    </Suspense>
  );
}

const DOCKED_QUERY = "(min-width: 1280px)";

function subscribeDocked(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(DOCKED_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function useWideViewport(): boolean {
  return useSyncExternalStore(
    subscribeDocked,
    () =>
      typeof window !== "undefined" && !!window.matchMedia
        ? window.matchMedia(DOCKED_QUERY).matches
        : false,
    () => false,
  );
}

/** True when a modal surface (a dialog, a menu) has the keyboard. */
function modalSurfaceOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
    ) !== null
  );
}

function DayLayer() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const today = useTodayKey();
  const raw = searchParams.get(DAY_QUERY_PARAM);
  const date = parseDayParam(raw, today);

  // A parameter the layer cannot open leaves the URL quietly.
  useEffect(() => {
    if (raw === null || date !== null) return;
    window.history.replaceState(
      null,
      "",
      withDayHref(window.location.pathname, window.location.search, null),
    );
  }, [raw, date]);

  useEffect(() => {
    publishOpenDay(date);
  }, [date]);
  useEffect(() => () => publishOpenDay(null), []);

  const wide = useWideViewport();
  const phone = useIsMobile();
  const shell: "docked" | "sheet" | "bottom" = phone
    ? "bottom"
    : wide && !pathname.startsWith("/coach")
      ? "docked"
      : "sheet";

  const focus = useDayFocus(date);
  const longLabel = useLongDayLabel();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // What the polite region says: the day that just opened or was stepped to.
  const announcement = date !== null ? longLabel(date) : "";
  const previous = useRef<DateKey | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = date;
    if (date !== null) {
      // Opening moves focus to the day's heading; a step keeps it where it is
      // (on the arrow the person pressed).
      if (before === null && shell === "docked") {
        titleRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (before !== null && shell === "docked") returnFocus();
  }, [date, shell]);

  const onStep = useCallback(
    (delta: number) => {
      if (date === null) return;
      if (delta > 0 && date >= today) return;
      stepDay(date, delta);
    },
    [date, today],
  );

  // Keyboard: Escape closes the docked column (a sheet's own Escape is the
  // dialog's), Alt with an arrow steps a day. Bare arrows stay with scrolling.
  useEffect(() => {
    if (date === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const inside =
        panelRef.current?.contains(event.target as Node | null) ?? false;
      if (event.key === "Escape" && shell === "docked") {
        if (modalSurfaceOpen() && !inside) return;
        event.preventDefault();
        closeDay();
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        (inside || shell === "docked")
      ) {
        event.preventDefault();
        onStep(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [date, shell, onStep]);

  const live = (
    <p
      className="sr-only"
      role="status"
      aria-live="polite"
      data-slot="day-announcement"
    >
      {announcement}
    </p>
  );

  if (date === null) return live;

  const view = (
    Title: Parameters<typeof DayView>[0]["Title"],
    extra?: Partial<Parameters<typeof DayView>[0]>,
  ) => (
    <DayView
      date={date}
      today={today}
      focus={focus}
      shell={shell}
      onClose={closeDay}
      onStep={onStep}
      Title={Title}
      titleId={titleId}
      titleRef={titleRef}
      {...extra}
    />
  );

  if (shell === "docked") {
    return (
      <>
        {live}
        <ShellSidePanel>
          <aside
            ref={panelRef}
            aria-labelledby={titleId}
            data-slot="day-panel"
            data-shell="docked"
            className="bg-card text-card-foreground border-border flex h-full w-105 shrink-0 flex-col border-l"
          >
            {view(DockedTitle, {
              headerClassName: cn(
                SHELL_HEADER_BAND,
                "border-border pt-[env(safe-area-inset-top,0px)]",
              ),
            })}
          </aside>
        </ShellSidePanel>
      </>
    );
  }

  return (
    <>
      {live}
      <DaySheet
        shell={shell}
        panelRef={panelRef}
        titleRef={titleRef}
        render={(extra) => view(SheetTitle, extra)}
      />
    </>
  );
}

function DockedTitle({
  ref,
  ...props
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
  ref?: React.Ref<HTMLHeadingElement>;
  tabIndex?: number;
}) {
  return <h2 ref={ref} {...props} />;
}

/** Return focus to whatever opened the day, or to the page. */
function returnFocus() {
  const trigger = takeDayTrigger();
  if (trigger && trigger.isConnected) {
    trigger.focus({ preventScroll: true });
    return;
  }
  document.getElementById("main-content")?.focus({ preventScroll: true });
}

/**
 * The modal frames. The bottom sheet opens at a bit over half the height and
 * grows to full height from its handle: drag it up or tap it. Dragging down
 * shrinks a full sheet, then closes it.
 */
function DaySheet({
  shell,
  panelRef,
  titleRef,
  render,
}: {
  shell: "sheet" | "bottom";
  panelRef: React.RefObject<HTMLElement | null>;
  titleRef: React.RefObject<HTMLHeadingElement | null>;
  render: (extra: Partial<Parameters<typeof DayView>[0]>) => React.ReactNode;
}) {
  const { t } = useTranslations();
  const [full, setFull] = useState(false);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const bottom = shell === "bottom";

  const grabber = bottom ? (
    <button
      type="button"
      data-slot="day-sheet-handle"
      aria-label={full ? t("day.sheetShrink") : t("day.sheetExpand")}
      aria-expanded={full}
      onPointerDown={(event) => {
        drag.current = { y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        if (Math.abs(event.clientY - start.y) > 8) start.moved = true;
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        drag.current = null;
        if (!start) return;
        const dy = event.clientY - start.y;
        if (!start.moved) return;
        if (dy < -40) setFull(true);
        else if (dy > 60) {
          if (full) setFull(false);
          else closeDay();
        }
      }}
      onClick={() => {
        // A drag ends in a click as well; only a tap toggles.
        if (drag.current?.moved) return;
        setFull((value) => !value);
      }}
      className="focus-visible:ring-ring/50 mx-auto flex h-6 w-16 shrink-0 touch-none items-center justify-center rounded-full focus-visible:ring-[3px] focus-visible:outline-none"
    >
      <span
        className="bg-muted-foreground/40 h-1.5 w-9 rounded-full"
        aria-hidden="true"
      />
    </button>
  ) : null;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) closeDay();
      }}
    >
      <SheetContent
        ref={panelRef as React.Ref<HTMLDivElement>}
        side={bottom ? "bottom" : "right"}
        showCloseButton={false}
        data-slot="day-panel"
        data-shell={shell}
        data-full={bottom && full ? "true" : undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
        className={cn(
          "bg-card gap-0 p-0",
          bottom
            ? cn(
                "rounded-t-2xl transition-[height] duration-200 motion-reduce:transition-none",
                full ? "h-[calc(100dvh-2.5rem)]" : "h-[58dvh]",
              )
            : "w-105 max-w-[90vw] sm:max-w-105",
        )}
      >
        <SheetDescription className="sr-only">
          {t("day.description")}
        </SheetDescription>
        {render({
          above: grabber,
          headerClassName: bottom ? undefined : "py-3",
        })}
      </SheetContent>
    </Sheet>
  );
}
