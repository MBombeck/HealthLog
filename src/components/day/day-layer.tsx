"use client";

import dynamic from "next/dynamic";
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

import { CalendarDays } from "lucide-react";

import {
  DOCK_SLIDE,
  DOCK_SLIDE_MS,
  DockStrip,
  ShellStrip,
  useLingering,
} from "@/components/layout/shell-dock";
import { ShellSidePanel } from "@/components/layout/shell-side-panel";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
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
  readDayOpen,
  readLastDay,
  subscribeLastDay,
  writeDayClosed,
  writeLastDay,
} from "@/lib/day/last-day";
import { getRecordScope } from "@/lib/query-keys/record-scope";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  closeDay,
  jumpDay,
  openDay,
  peekDayTriggerAt,
  publishOpenDay,
  stepDay,
  takeDayTrigger,
  takeDayYield,
  useDayFocus,
} from "./day-layer-controller";
import {
  parseDayParam,
  shiftDateKey,
  stripDayOf,
  withDayHref,
} from "./day-url";
import { useLongDayLabel } from "./day-label";
import type { DayViewProps } from "./day-view";
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
 *     landmark (`complementary`) named by the date. Its strip stays at the
 *     right edge of the window whether the day is open or not
 *     (`shell-dock.tsx`): it names the day and opens or closes it, on this
 *     page or any other (`last-day.ts` remembers the day per browser and
 *     account; with nothing remembered the strip holds today). The column
 *     slides open and shut left of the strip the way the conversations do.
 *   - from 768 px, a sheet from the right, modal.
 *   - on a phone, a sheet from the bottom at a bit over half the height, so
 *     the chart stays in view above it; dragging the handle up (or tapping
 *     it) takes it to full height, dragging it down closes it.
 *
 * On `/coach` the day docks too, right of the Coach's conversations: page,
 * conversations, day. Below 1600 px only one of the two is open at a time;
 * opening the day closes the conversations, and opening the conversations
 * closes the day (`yieldDay`).
 *
 * The parameter is the state. A date that is not a calendar date, or lies in
 * the future, is removed from the URL without a word. Collapsing the docked
 * day removes the parameter like closing does; only the remembered date
 * stays, and expanding opens it again.
 */
export const DAY_PANEL_ID = "day-docked-panel";

/**
 * The day's content loads when a day first opens (or when the pointer
 * reaches the strip), not with the shell: the scores, the calendar and the
 * sections are no part of a page until a day is open. Until it arrives the
 * frame shows its header band and nothing else.
 */
const loadDayView = () => import("./day-view").then((m) => m.DayView);
function preloadDayView() {
  void loadDayView();
}
const DayView = dynamic(loadDayView, {
  ssr: false,
  loading: () => (
    <div
      data-slot="day-view-loading"
      className={cn(SHELL_HEADER_BAND, "border-border shrink-0")}
    />
  ),
});

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
  const leftOpen = useSyncExternalStore(
    subscribeLastDay,
    () => readDayOpen(owner),
    () => false,
  );
  // Every way the person folds or closes the day goes through here, so a page
  // change (which drops `?day=` too) is never mistaken for one.
  const closeByPerson = useCallback(() => {
    if (owner !== null) writeDayClosed(owner);
    closeDay();
  }, [owner]);

  // `?day=` gone while the page stayed the same is the person leaving the
  // day (Back past the step that opened it); gone with a page change is
  // only the URL of another page, and the day comes with it. Declared
  // before the effects that read the flag, so they see the close.
  const pathname = usePathname();
  const openOn = useRef<string | null>(null);
  useEffect(() => {
    if (date !== null) {
      openOn.current = pathname;
      return;
    }
    if (openOn.current !== null && openOn.current === pathname) {
      if (owner !== null) writeDayClosed(owner);
    }
    openOn.current = null;
  }, [date, pathname, owner]);

  const wide = useWideViewport();
  const phone = useIsMobile();
  const shell: "docked" | "sheet" | "bottom" = phone
    ? "bottom"
    : wide
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
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  // Focus asked for before the day's content had loaded: the heading takes
  // it the moment it mounts.
  const titleFocusPending = useRef(false);
  const attachTitle = useCallback((el: HTMLHeadingElement | null) => {
    titleRef.current = el;
    if (el && titleFocusPending.current) {
      titleFocusPending.current = false;
      el.focus({ preventScroll: true });
    }
  }, []);
  const focusTitle = useCallback(() => {
    const el = titleRef.current;
    if (el) el.focus({ preventScroll: true });
    else titleFocusPending.current = true;
  }, []);
  const panelRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  // Set by a fold (the header's control, the strip): focus then lands on the
  // strip, which brings the day back from the same place.
  const collapsing = useRef(false);

  // The remembered day, while the docked day is shut, if it is still a day
  // the layer would open.
  const railDay =
    shell === "docked" && date === null && lastDay !== null
      ? parseDayParam(lastDay, today)
      : null;
  // A page change drops `?day=` before the new page puts the remembered day
  // back (below); a day left open stays open through that gap instead of
  // sliding shut and open again.
  const heldOpen = shell === "docked" && date === null && leftOpen;
  const dockedDay =
    shell === "docked" ? (date ?? (heldOpen ? railDay : null)) : null;
  // The docked column keeps painting the day it showed while it slides shut.
  const shownDay = useLingering(dockedDay);
  // No slide on arrival: a day restored with the page is simply there.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const collapse = useCallback(() => {
    collapsing.current = true;
    closeByPerson();
  }, [closeByPerson]);

  // Open stays open across pages: a page reached without `?day=` while the
  // day was left open puts the remembered day back in its URL, on every page
  // that docks it. Restoring is not opening, so focus stays with the page.
  const restoring = useRef(false);
  useEffect(() => {
    if (shell !== "docked" || raw !== null || !leftOpen || railDay === null) {
      return;
    }
    // Read again, not from the render: a Back on this page has just closed it.
    if (!readDayOpen(owner)) return;
    restoring.current = true;
    window.history.replaceState(
      null,
      "",
      withDayHref(window.location.pathname, window.location.search, railDay),
    );
  }, [shell, raw, leftOpen, railDay, owner]);

  // What the polite region says: the day that just opened or was stepped to.
  const announcement = date !== null ? longLabel(date) : "";
  const previous = useRef<DateKey | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = date;
    if (date !== null) {
      // Opening moves focus to the day's heading; a step keeps it where it is
      // (on the arrow the person pressed), and so does a day restored on a
      // new page.
      if (before === null && shell === "docked" && !restoring.current) {
        focusTitle();
      }
      restoring.current = false;
      return;
    }
    if (before !== null && shell === "docked") {
      // Collapsed for a neighbouring panel: focus stays where it was, and the
      // day counts as folded by the person, who opened the other panel.
      if (takeDayYield()) {
        if (owner !== null) writeDayClosed(owner);
        collapsing.current = false;
        return;
      }
      // Gone from the URL by a page change, not by the person: the day comes
      // back on the new page, and focus stays with the page.
      if (readDayOpen(owner)) {
        collapsing.current = false;
        return;
      }
      const rail = stripRef.current;
      if (collapsing.current && rail) {
        takeDayTrigger();
        rail.focus({ preventScroll: true });
      } else {
        returnFocus(rail);
      }
    }
    collapsing.current = false;
  }, [date, shell, owner, focusTitle]);

  const onStep = useCallback(
    (delta: number) => {
      if (date === null) return;
      if (delta > 0 && date >= today) return;
      stepDay(date, delta);
    },
    [date, today],
  );

  const onPick = useCallback(
    (next: DateKey) => {
      if (next > today) return;
      jumpDay(next);
    },
    [today],
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
        closeByPerson();
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
  }, [date, shell, onStep, prefetchDay, today, closeByPerson]);

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

  const view = (
    shown: DateKey,
    Title: DayViewProps["Title"],
    extra?: Partial<DayViewProps>,
  ) => (
    <DayView
      date={shown}
      today={today}
      focus={focus}
      shell={shell}
      onClose={shell === "docked" ? collapse : closeByPerson}
      onStep={onStep}
      onPick={onPick}
      Title={Title}
      titleId={titleId}
      titleRef={attachTitle}
      {...extra}
    />
  );

  if (shell === "docked") {
    // What the strip holds: the open day, else the remembered one, else today.
    const stripDay = stripDayOf(date, railDay, today);
    const open = dockedDay !== null;
    const toggle = () => {
      if (open) {
        collapse();
        return;
      }
      openDay(stripDay, { trigger: stripRef.current ?? undefined });
    };
    return (
      <>
        {live}
        <ShellSidePanel>
          <div
            id={DAY_PANEL_ID}
            data-slot="day-dock"
            data-state={open ? "open" : "closed"}
            className={cn(
              DOCK_SLIDE,
              "order-2",
              open ? "w-105" : "w-0",
              !settled && "transition-none",
            )}
          >
            {shownDay !== null ? (
              <aside
                ref={panelRef}
                aria-labelledby={titleId}
                data-slot="day-panel"
                data-shell="docked"
                data-state={open ? "open" : "closing"}
                // Sliding shut, it paints the day it showed and takes no
                // input.
                inert={!open}
                className="bg-card text-card-foreground border-border absolute inset-y-0 left-0 flex w-105 flex-col border-l"
              >
                {view(shownDay, DockedTitle, {
                  // No status-bar inset here: the docked column sits inside
                  // the app shell, which takes it (`shell-safe-area`).
                  headerClassName: cn(SHELL_HEADER_BAND, "border-border"),
                })}
              </aside>
            ) : null}
          </div>
        </ShellSidePanel>
        <ShellStrip>
          <DockStrip
            ref={stripRef}
            slot="day-strip"
            order={2}
            controls={DAY_PANEL_ID}
            expanded={open}
            label={shortLabel(stripDay)}
            actionLabel={
              open
                ? t("day.hidePanel")
                : t("day.showPanel", { date: longLabel(stripDay) })
            }
            icon={CalendarDays}
            onToggle={toggle}
            onPreload={preloadDayView}
            data={{ "data-day": stripDay }}
          />
        </ShellStrip>
      </>
    );
  }

  if (date === null) return live;

  return (
    <>
      {live}
      <DaySheet
        shell={shell}
        panelRef={panelRef}
        focusTitle={focusTitle}
        onDismiss={closeByPerson}
        render={(extra) => view(date, SheetTitle, extra)}
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
 * The column slides, so the page reflows on every frame of the slide; the
 * correction follows it frame by frame until the slide has run.
 */
function useKeepAnchorInView(active: boolean) {
  const anchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const wasActive = useRef(false);
  const frame = useRef(0);

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
    const held = anchor.current;
    if (!active) anchor.current = null;
    if (!held) return;
    const correct = () => {
      if (!held.el.isConnected) return;
      const delta = held.el.getBoundingClientRect().top - held.top;
      if (Math.abs(delta) > 1) main.scrollTop += delta;
      held.top = held.el.getBoundingClientRect().top;
    };
    correct();
    cancelAnimationFrame(frame.current);
    const until = performance.now() + DOCK_SLIDE_MS + 50;
    const tick = () => {
      correct();
      if (performance.now() < until)
        frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [active]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

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
  focusTitle,
  onDismiss,
  render,
}: {
  shell: "sheet" | "bottom";
  panelRef: React.RefObject<HTMLElement | null>;
  /** Focus the day's heading, now or as soon as it has loaded. */
  focusTitle: () => void;
  /** The person closed the sheet (a swipe down, Escape, the overlay). */
  onDismiss: () => void;
  render: (extra: Partial<DayViewProps>) => React.ReactNode;
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
          else onDismiss();
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
        if (!open) onDismiss();
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
          focusTitle();
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
