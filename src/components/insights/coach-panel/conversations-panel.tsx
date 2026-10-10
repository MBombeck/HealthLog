"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  Target,
  X,
} from "lucide-react";

import { useOpenDay, yieldDay } from "@/components/day/day-layer-controller";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DOCK_SLIDE,
  DockStrip,
  ShellStrip,
  useLingering,
} from "@/components/layout/shell-dock";
import { ShellSidePanel } from "@/components/layout/shell-side-panel";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
import { TopBarActions } from "@/components/layout/top-bar-actions";
import { useCoachPanelOpen } from "@/hooks/use-coach-panel-open";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { CoachSettingsOverlay } from "./coach-settings-overlay";
import { HistoryRail } from "./history-rail";
import { useDeleteCoachConversationWithUndo } from "./use-coach";

/**
 * The Coach page's conversations panel, on the right of the thread.
 *
 * From 1280 px it is a column beside the thread that slides open and shut
 * (a 200 ms width transition, none under reduced motion). The thread column
 * keeps its width either way; only its centring moves. It is open on a first
 * visit and remembers the last choice per device (`useCoachPanelOpen`).
 * Below 1280 px it is a sheet from the right that opens when asked and
 * closes again when a conversation is picked or a new chat starts.
 *
 * Docked, the panel is a column of the shell beside the content column
 * (top bar and page): it runs the full height of the window, and the top bar
 * ends at its left edge. The panel's header row is the top bar's band, so
 * the two bottom borders draw one line. Its strip stays at the right edge of
 * the window, left of the day's (`shell-dock.tsx`), open or not: a click
 * on the strip opens the panel left of the strips and a second click shuts
 * it. The strip is the docked panel's only fold control; the header carries
 * none. The panel slides open and shut (a 200 ms width transition, none
 * under reduced motion).
 * The header carries the title, a link to Plans, the settings gear and, in
 * the sheet, a close button. New conversation is not here: it floats in the
 * conversation itself (`NewChatFab`).
 *
 * The day docks right of the panel on this page too (page, conversations,
 * day). Below 1600 px only one of the two is open: a day opening folds the
 * list without touching the remembered choice, and opening the list closes
 * the day (`yieldDay`). From 1600 px both stay open.
 *
 * Below 1280 px the panel is a sheet, opened from the toggle at the end of
 * the top bar.
 *
 * Keyboard: Escape folds the docked panel when focus is inside it and
 * nothing inside (a row menu, the rename field, the settings popover) has
 * already claimed the key; focus moves to the strip, and opening from the
 * strip lands on the panel's heading. In the sheet Radix owns Escape, the
 * focus trap and the return.
 */
export const COACH_PANEL_ID = "coach-conversations-panel";

/**
 * The panel header's icon buttons: 28 px beside a fine pointer, the 44 px
 * touch floor otherwise. Keyed on the input, not the viewport width, so a
 * tablet in landscape (touch, docked panel) keeps the touch size.
 */
export const PANEL_HEADER_BUTTON =
  "text-muted-foreground hover:text-foreground size-11 shrink-0 pointer-fine:size-7";
const PANEL_HEADER_ICON = "size-5 pointer-fine:size-4";

const noSubscription = () => () => {};

/** Wide enough for the conversations and a day beside the conversation. */
export const BOTH_PANELS_QUERY = "(min-width: 1600px)";

function subscribeBothPanels(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(BOTH_PANELS_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function useBothPanelsFit(): boolean {
  return useSyncExternalStore(
    subscribeBothPanels,
    () =>
      typeof window !== "undefined" && !!window.matchMedia
        ? window.matchMedia(BOTH_PANELS_QUERY).matches
        : false,
    () => false,
  );
}

/**
 * Whether the docked list gives way to an open day: it does when the day
 * opens, or the window narrows, while both would be open below 1600 px.
 * Only those two moments fold it, so opening the list again beside an open
 * day (which folds the day) is never undone.
 */
export function listYields(state: {
  docked: boolean;
  fitsBoth: boolean;
  listOpen: boolean;
  dayOpened: boolean;
  narrowed: boolean;
  dayOpen: boolean;
}): boolean {
  return (
    state.docked &&
    !state.fitsBoth &&
    state.listOpen &&
    state.dayOpen &&
    (state.dayOpened || state.narrowed)
  );
}

/**
 * Whether opening the docked list closes an open day: below 1600 px only one
 * of the two is open, and the one the person just opened wins.
 */
export function dayYields(state: {
  fitsBoth: boolean;
  dayOpen: boolean;
}): boolean {
  return !state.fitsBoth && state.dayOpen;
}

/**
 * Whether the phone sheet is open. A settings deep link opens it only once
 * the viewport is known: the server and hydration renders take the narrow
 * (sheet) layout, so opening it from the first render flashed the sheet on
 * a desktop before the docked panel replaced it.
 */
export function sheetShown(state: {
  chosen: boolean;
  deepLinkPending: boolean;
  hydrated: boolean;
  docked: boolean;
}): boolean {
  return (
    state.chosen || (state.deepLinkPending && state.hydrated && !state.docked)
  );
}

export interface ConversationsPanelProps {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /**
   * `/coach?settings=data`: reveal the panel and open the settings gear on
   * the "What I can see" section. Read once, on mount.
   */
  openSettingsOnData?: boolean;
}

/**
 * The panel's open/shut toggle, the last item of the top bar. 28 px beside a
 * fine pointer, the 44 px touch floor otherwise; the tooltip names it.
 */
function PanelToggle({
  ref,
  expanded,
  label,
  onToggle,
  className,
}: {
  ref: React.Ref<HTMLButtonElement>;
  expanded: boolean;
  label: string;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = expanded ? PanelRightOpen : PanelRightClose;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-controls={COACH_PANEL_ID}
          aria-expanded={expanded}
          aria-label={label}
          data-slot="coach-panel-toggle"
          className={cn(PANEL_HEADER_BUTTON, className)}
        >
          {/* Mirrored, so the chevron points the way the panel moves on a
              click: right to shut it, left to open it. */}
          <Icon
            className={cn(PANEL_HEADER_ICON, "-scale-x-100")}
            aria-hidden="true"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ConversationsPanel({
  activeId,
  onSelect,
  onNewChat,
  openSettingsOnData = false,
}: ConversationsPanelProps) {
  const { t } = useTranslations();
  const { docked, open: rememberedOpen, setOpen } = useCoachPanelOpen();
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Owned here, not by the list, so a pending delete keeps its undo window
  // when the sheet (and the list inside it) closes.
  const deletion = useDeleteCoachConversationWithUndo();

  // A settings deep-link shows the panel without rewriting the remembered
  // choice; the next toggle settles it.
  const [revealed, setRevealed] = useState(openSettingsOnData);
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const [deepLinkPending, setDeepLinkPending] = useState(openSettingsOnData);
  const [sheetChosen, setSheetChosen] = useState(false);
  const sheetOpen = sheetShown({
    chosen: sheetChosen,
    deepLinkPending,
    hydrated,
    docked,
  });
  // On a docked viewport the deep link is served by `revealed`; it must not
  // open the sheet later if the window narrows.
  if (deepLinkPending && hydrated && docked) setDeepLinkPending(false);
  const setSheetOpen = (next: boolean) => {
    setDeepLinkPending(false);
    setSheetChosen(next);
  };
  const [settingsOpen, setSettingsOpen] = useState(openSettingsOnData);
  const [settingsOnData, setSettingsOnData] = useState(openSettingsOnData);

  // The day beside the list (docked on this page from 1280 px too).
  const openDay = useOpenDay();
  const fitsBoth = useBothPanelsFit();
  // Folded for the day, without rewriting the remembered choice.
  const [yielded, setYielded] = useState(false);
  const dockedOpen = (rememberedOpen || revealed) && !yielded;
  const [seen, setSeen] = useState<{ day: string | null; fitsBoth: boolean }>({
    day: null,
    fitsBoth,
  });
  if (seen.day !== openDay || seen.fitsBoth !== fitsBoth) {
    setSeen({ day: openDay, fitsBoth });
    if (
      listYields({
        docked,
        fitsBoth,
        listOpen: dockedOpen,
        dayOpen: openDay !== null,
        dayOpened: seen.day === null && openDay !== null,
        narrowed: seen.fitsBoth && !fitsBoth,
      })
    ) {
      setYielded(true);
    }
  }

  const expanded = docked ? dockedOpen : sheetOpen;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  // The list keeps painting while it slides shut.
  const shownOpen = useLingering(docked && dockedOpen ? true : null) ?? false;
  // Where focus goes once the docked panel has folded or opened.
  const focusAfter = useRef<"panel" | "strip" | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "panel") headingRef.current?.focus({ preventScroll: true });
    if (target === "strip") expandRef.current?.focus();
  }, [dockedOpen]);

  function toggleSheet() {
    setSheetOpen(!sheetOpen);
  }

  function expandDocked() {
    focusAfter.current = "panel";
    setYielded(false);
    setRevealed(false);
    setOpen(true);
    // Below 1600 px the day makes room: it folds to its edge.
    if (dayYields({ fitsBoth, dayOpen: openDay !== null })) yieldDay();
  }

  function collapseDocked() {
    focusAfter.current = "strip";
    setYielded(false);
    setRevealed(false);
    setOpen(false);
  }

  function afterPick() {
    if (!docked) setSheetOpen(false);
  }

  const toggleLabel = expanded
    ? t("insights.coach.frame.hidePanel")
    : t("insights.coach.frame.showPanel");

  const header = (inSheet: boolean) => (
    <div
      data-slot="coach-conversations-panel-header"
      // No inset of its own: docked, the panel is a column of the app
      // shell, which already starts below the status bar of an installed
      // app (`shell-safe-area` in `auth-shell.tsx`).
      // Docked, the row is the top bar's band (height and bottom border
      // from `SHELL_HEADER_BAND`), so the two borders draw one line.
      // Touch: 44 px buttons already carry their own air, so the row packs
      // them tighter to leave the title room at 390 px.
      className={cn(
        "flex shrink-0 items-center gap-1 pointer-fine:gap-2",
        inSheet
          ? "border-border border-b p-3"
          : cn("border-sidebar-border px-3", SHELL_HEADER_BAND),
      )}
    >
      {inSheet ? (
        <SheetTitle className="min-w-0 flex-1 truncate text-lg leading-tight font-semibold">
          {t("insights.coach.historyTitle")}
        </SheetTitle>
      ) : (
        // Docked, the strip is the panel's only fold control; focus lands on
        // the heading when the panel opens from it.
        <h2
          ref={headingRef}
          tabIndex={-1}
          data-slot="coach-panel-heading"
          className="min-w-0 flex-1 truncate pl-1 text-lg leading-tight font-semibold focus-visible:outline-none"
        >
          {t("insights.coach.historyTitle")}
        </h2>
      )}
      <Button
        asChild
        variant="ghost"
        size="icon"
        className={PANEL_HEADER_BUTTON}
      >
        <Link
          href="/coach/plans"
          data-slot="coach-panel-plans"
          aria-label={t("coach.plans.title")}
          title={t("coach.plans.title")}
        >
          <Target className={PANEL_HEADER_ICON} aria-hidden="true" />
        </Link>
      </Button>
      <CoachSettingsOverlay
        open={settingsOpen}
        onOpenChange={(next) => {
          setSettingsOpen(next);
          if (!next) setSettingsOnData(false);
        }}
        focusData={settingsOnData}
        className="pointer-fine:size-7 [&_svg]:size-5 pointer-fine:[&_svg]:size-4"
      />
      {inSheet ? (
        <SheetClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="coach-panel-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            className={PANEL_HEADER_BUTTON}
          >
            <X className={PANEL_HEADER_ICON} aria-hidden="true" />
          </Button>
        </SheetClose>
      ) : null}
    </div>
  );

  const body = (inSheet: boolean) => (
    <>
      {header(inSheet)}
      <HistoryRail
        hideHeading
        activeId={activeId}
        onSelect={(id) => {
          onSelect(id);
          afterPick();
        }}
        deletion={deletion}
        onDeleteActive={() => onNewChat()}
        onUndoDeleteActive={(id) => onSelect(id)}
        className="min-h-0 flex-1"
      />
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      {docked ? null : (
        <TopBarActions>
          <PanelToggle
            ref={toggleRef}
            expanded={expanded}
            label={toggleLabel}
            onToggle={toggleSheet}
          />
        </TopBarActions>
      )}

      {docked ? (
        <>
          <ShellSidePanel>
            <div
              id={COACH_PANEL_ID}
              data-slot="coach-conversations-panel"
              data-state={dockedOpen ? "open" : "closed"}
              onKeyDown={(event) => {
                if (
                  !dockedOpen ||
                  event.key !== "Escape" ||
                  event.defaultPrevented
                ) {
                  return;
                }
                event.preventDefault();
                collapseDocked();
              }}
              className={cn(
                // A column of the shell's content row (`ShellSidePanel`), so
                // it runs from the top of the window to the bottom beside the
                // top bar, left of a docked day (`order-1`, the day is
                // `order-2`). The width slides between the open column and
                // nothing; the content keeps 18rem, pinned left, so it slides
                // instead of squeezing (`DOCK_SLIDE`).
                DOCK_SLIDE,
                "bg-sidebar text-sidebar-foreground order-1",
                dockedOpen ? "w-72" : "w-0",
              )}
            >
              {shownOpen ? (
                <aside
                  aria-label={t("insights.coach.historyTitle")}
                  // Sliding shut, it paints the list and takes no input.
                  inert={!dockedOpen}
                  className="border-sidebar-border absolute inset-y-0 left-0 flex w-72 flex-col border-l"
                >
                  {body(false)}
                </aside>
              ) : null}
            </div>
          </ShellSidePanel>
          <ShellStrip>
            <DockStrip
              ref={expandRef}
              slot="coach-panel-strip"
              order={1}
              controls={COACH_PANEL_ID}
              expanded={dockedOpen}
              label={t("insights.coach.historyTitle")}
              actionLabel={
                dockedOpen
                  ? t("insights.coach.frame.hidePanel")
                  : t("insights.coach.frame.showPanel")
              }
              icon={MessagesSquare}
              onToggle={dockedOpen ? collapseDocked : expandDocked}
            />
          </ShellStrip>
        </>
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            id={COACH_PANEL_ID}
            side="right"
            showCloseButton={false}
            data-slot="coach-conversations-panel"
            className="w-[22rem] max-w-[90vw] gap-0 p-0 sm:max-w-[22rem]"
            onOpenAutoFocus={(event) => {
              // Land on the sheet itself, not its first control, so opening
              // the sheet does not paint a focus ring on a header button.
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
            onCloseAutoFocus={(event) => {
              // The toggle lives in the top bar, outside the sheet; hand
              // focus back to it explicitly.
              event.preventDefault();
              toggleRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              // The rename field takes Escape for itself (cancel the edit);
              // the sheet stays open. Radix listens in the capture phase, so
              // the field's own handler has not run yet when this fires.
              const target = event.target as Element | null;
              if (
                target?.closest?.(
                  '[data-slot="coach-conversation-rename-form"]',
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <SheetDescription className="sr-only">
              {t("insights.coach.frame.panelDescription")}
            </SheetDescription>
            {body(true)}
          </SheetContent>
        </Sheet>
      )}
    </TooltipProvider>
  );
}
