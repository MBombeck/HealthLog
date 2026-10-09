"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { PanelRightOpen } from "lucide-react";

import { ShellSidePanel } from "@/components/layout/shell-side-panel";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DAY_QUERY_PARAM, type DateKey } from "@/lib/day/contract";
import {
  readLastDay,
  subscribeLastDay,
  writeLastDay,
} from "@/lib/day/last-day";
import { getRecordScope } from "@/lib/query-keys/record-scope";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  closeDay,
  openDay,
  peekDayTriggerAt,
  publishOpenDay,
  stepDay,
  takeDayTrigger,
  useDayFocus,
} from "./day-layer-controller";
import { parseDayParam, shiftDateKey, withDayHref } from "./day-url";
import {
  DayView,
  PANEL_TOGGLE,
  PANEL_TOGGLE_ICON,
  useLongDayLabel,
} from "./day-view";
import { usePrefetchDay } from "./use-day";
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
 *     landmark (`complementary`) named by the date. It collapses like a
 *     sidebar instead of going away: hidden, a narrow edge stays on the
 *     right with a button that brings the last day back, on this page or any
 *     other (`last-day.ts` remembers it per browser and account).
 *   - from 768 px, a sheet from the right, modal.
 *   - on a phone, a sheet from the bottom at a bit over half the height, so
 *     the chart stays in view above it; dragging the handle up (or tapping
 *     it) takes it to full height, dragging it down closes it.
 *
 * On `/coach` the conversations panel already holds the side column, and
 * there is never more than one docked panel: the day opens as a sheet there.
 *
 * The parameter is the state. A date that is not a calendar date, or lies in
 * the future, is removed from the URL without a word. Collapsing the docked
 * day removes the parameter like closing does; only the remembered date
 * stays, and expanding opens it again.
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

  // The last open day, bound to the account and the record it belongs to.
  const { user } = useAuth();
  const owner = user ? `${user.id}:${getRecordScope() ?? "own"}` : null;
  useEffect(() => {
    if (date !== null && owner !== null) writeLastDay(owner, date);
  }, [date, owner]);
  const lastDay = useSyncExternalStore(
    subscribeLastDay,
    () => readLastDay(owner),
    () => null,
  );

  const wide = useWideViewport();
  const phone = useIsMobile();
  const shell: "docked" | "sheet" | "bottom" = phone
    ? "bottom"
    : wide && !pathname.startsWith("/coach")
      ? "docked"
      : "sheet";

  // The docked column narrows the page beside it, and the page reflows. Keep
  // what opened the day where it was on screen, through the open and the
  // close, so the chart under the pointer does not jump away from it.
  useKeepAnchorInView(date !== null && shell === "docked");

  const prefetchDay = usePrefetchDay();
  const focus = useDayFocus(date);
  const longLabel = useLongDayLabel();
  const shortLabel = useLongDayLabel("short");
  const { t } = useTranslations();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  // Set by the collapse control: focus then lands on the control that
  // brings the day back, in the same place, as a sidebar's toggle does.
  const collapsing = useRef(false);

  // The collapsed edge: the docked frame only, and only with a day to bring
  // back that is still a day the layer would open.
  const railDay =
    shell === "docked" && date === null && lastDay !== null
      ? parseDayParam(lastDay, today)
      : null;

  const collapse = useCallback(() => {
    collapsing.current = true;
    closeDay();
  }, []);

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
    if (before !== null && shell === "docked") {
      const rail = expandRef.current;
      if (collapsing.current && rail) {
        takeDayTrigger();
        rail.focus({ preventScroll: true });
      } else {
        returnFocus(rail);
      }
    }
    collapsing.current = false;
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
      // Alt is the first half of the step shortcut: read both neighbours
      // while the arrow is still on its way, so the step paints a day.
      if (event.key === "Alt") {
        prefetchDay(shiftDateKey(date, -1));
        if (date < today) prefetchDay(shiftDateKey(date, 1));
        return;
      }
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
  }, [date, shell, onStep, prefetchDay, today]);

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

  if (date === null) {
    if (railDay === null) return live;
    const label = t("day.showPanel", { date: longLabel(railDay) });
    const expand = () =>
      openDay(railDay, { trigger: expandRef.current ?? undefined });
    return (
      <>
        {live}
        <ShellSidePanel>
          <div
            data-slot="day-rail"
            data-day={railDay}
            className="bg-card text-card-foreground border-border flex h-full w-12 shrink-0 flex-col border-l"
          >
            {/* The top bar's band, so the two bottom borders draw one line;
                the control sits where the open day keeps its own. */}
            <div
              className={cn(
                SHELL_HEADER_BAND,
                "border-border flex shrink-0 items-center justify-center",
              )}
            >
              <Button
                ref={expandRef}
                type="button"
                variant="ghost"
                size="icon"
                data-slot="day-expand"
                aria-expanded={false}
                aria-label={label}
                title={label}
                onClick={expand}
                className={PANEL_TOGGLE}
              >
                <PanelRightOpen
                  className={cn(PANEL_TOGGLE_ICON, "-scale-x-100")}
                  aria-hidden="true"
                />
              </Button>
            </div>
            {/* The rest of the edge takes a click too and names the day it
                holds; the keyboard has the button above. */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={expand}
              className="hover:bg-muted/60 text-muted-foreground flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-start pt-4 text-xs transition-colors"
            >
              <span className="[writing-mode:vertical-rl]">
                {shortLabel(railDay)}
              </span>
            </button>
          </div>
        </ShellSidePanel>
      </>
    );
  }

  const view = (
    Title: Parameters<typeof DayView>[0]["Title"],
    extra?: Partial<Parameters<typeof DayView>[0]>,
  ) => (
    <DayView
      date={date}
      today={today}
      focus={focus}
      shell={shell}
      onClose={shell === "docked" ? collapse : closeDay}
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
            // A short fade, not a slide: the column takes its width at once
            // (the page beside it reflows in the same frame either way), so
            // only its content eases in. None under reduced motion.
            className="bg-card text-card-foreground border-border motion-safe:animate-in motion-safe:fade-in-0 flex h-full w-105 shrink-0 flex-col border-l motion-safe:duration-150"
          >
            {view(DockedTitle, {
              // No status-bar inset here: the docked column sits inside
              // the app shell, which takes it (`shell-safe-area`).
              headerClassName: cn(SHELL_HEADER_BAND, "border-border"),
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

/**
 * Keep the element that opened the day at the same place on screen while the
 * page beside the docked column reflows (the column taking or giving back its
 * width). Chromium does this itself (CSS scroll anchoring); Safari does not,
 * and there the chart the person clicked slid away under the pointer by the
 * height the reflow added above it. Measured after layout, so where the
 * browser already anchored, the correction is zero and nothing moves twice.
 */
function useKeepAnchorInView(active: boolean) {
  const anchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const wasActive = useRef(false);

  // Before paint, so the corrected position is the first one drawn.
  useLayoutEffect(() => {
    if (active === wasActive.current) return;
    wasActive.current = active;
    const main = document.getElementById("main-content");
    if (!main) return;
    if (active) {
      // Where the opener was when it was clicked, before the column came.
      const opened = peekDayTriggerAt();
      anchor.current =
        opened && main.contains(opened.el)
          ? { el: opened.el, top: opened.top }
          : null;
    }
    const a = anchor.current;
    if (a && a.el.isConnected) {
      const delta = a.el.getBoundingClientRect().top - a.top;
      if (Math.abs(delta) > 1) main.scrollTop += delta;
      a.top = a.el.getBoundingClientRect().top;
    }
    if (!active) anchor.current = null;
  }, [active]);

  // While the column is open, the page may scroll; the anchor follows.
  useEffect(() => {
    if (!active) return;
    const main = document.getElementById("main-content");
    if (!main) return;
    const record = () => {
      const a = anchor.current;
      if (a && a.el.isConnected) a.top = a.el.getBoundingClientRect().top;
    };
    main.addEventListener("scroll", record, { passive: true });
    return () => main.removeEventListener("scroll", record);
  }, [active]);
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

/**
 * Return focus to whatever opened the day; failing that, to `fallback` (the
 * collapsed edge's control), or to the page.
 */
function returnFocus(fallback?: HTMLElement | null) {
  const trigger = takeDayTrigger();
  if (trigger && trigger.isConnected) {
    trigger.focus({ preventScroll: true });
    return;
  }
  if (fallback && fallback.isConnected) {
    fallback.focus({ preventScroll: true });
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
          // Quicker than the primitive's 500 ms, which read as lag on a
          // layer opened from a tap; no slide at all under reduced motion.
          "bg-card gap-0 p-0 data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:animate-none",
          bottom
            ? cn(
                "rounded-t-2xl transition-[height] duration-200 motion-reduce:transition-none",
                // Full height leaves a strip of the page above the
                // sheet, and never less than the status bar of an
                // installed app plus a margin: a 2.5rem strip put the
                // handle under a 59 px Dynamic Island.
                full
                  ? "h-[calc(100dvh-max(2.5rem,env(safe-area-inset-top,0px)+0.75rem))]"
                  : "h-[58dvh]",
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
