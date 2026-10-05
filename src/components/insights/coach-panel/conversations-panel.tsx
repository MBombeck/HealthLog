"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { PanelRightClose, PanelRightOpen, Plus, Target, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
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
 * the two bottom borders draw one line. Shut, it is gone entirely (no rail)
 * and the top bar runs to the window's edge. The toggle is the last item of
 * the top bar, so it sits against the open panel and at the window's edge
 * when the panel is shut. The panel header carries the title, a link to
 * Plans, the settings gear and, in the sheet, a close button. The round New
 * chat button sits at the panel's bottom right.
 *
 * Keyboard: Escape closes the docked panel when focus is inside it and
 * nothing inside (a row menu, the rename field, the settings popover) has
 * already claimed the key, then focus returns to the toggle. In the sheet
 * Radix owns Escape, the focus trap and the return.
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

  const dockedOpen = rememberedOpen || revealed;
  const expanded = docked ? dockedOpen : sheetOpen;

  function toggle() {
    if (docked) {
      setRevealed(false);
      setOpen(!dockedOpen);
    } else {
      setSheetOpen(!sheetOpen);
    }
  }

  function closeDocked() {
    setRevealed(false);
    setOpen(false);
    toggleRef.current?.focus();
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
      // Docked, the row reserves the safe-area inset the top bar reserves,
      // so a standalone PWA on a tablet does not tuck it under the status
      // bar; the band keeps its height (border-box), like the top bar.
      style={
        inSheet ? undefined : { paddingTop: "env(safe-area-inset-top, 0px)" }
      }
      // Docked, the row is the top bar's band (height and bottom border
      // from `SHELL_HEADER_BAND`), so the two borders draw one line.
      className={cn(
        "flex shrink-0 items-center gap-2",
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
        <h2 className="min-w-0 flex-1 truncate text-lg leading-tight font-semibold">
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
      {/* New chat: a round filled button floating at the panel's bottom
          right; the list pads its own scroll area so the last row clears it. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            onClick={() => {
              onNewChat();
              afterPick();
            }}
            data-slot="coach-panel-new-chat"
            aria-label={t("insights.coach.newChat")}
            className="absolute right-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] size-12 rounded-full shadow-lg md:right-6 md:bottom-[calc(1.5rem+env(safe-area-inset-bottom,0px))]"
          >
            <Plus className="size-6" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {t("insights.coach.newChat")}
        </TooltipContent>
      </Tooltip>
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <TopBarActions>
        <PanelToggle
          ref={toggleRef}
          expanded={expanded}
          label={toggleLabel}
          onToggle={toggle}
        />
      </TopBarActions>

      {docked ? (
        <ShellSidePanel>
          <aside
            id={COACH_PANEL_ID}
            aria-label={t("insights.coach.historyTitle")}
            data-slot="coach-conversations-panel"
            data-state={dockedOpen ? "open" : "closed"}
            inert={!dockedOpen}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              closeDocked();
            }}
            className={cn(
              // A column of the shell's content row (`ShellSidePanel`), so it
              // runs from the top of the window to the bottom beside the top
              // bar. The width animates (offcanvas: shut, nothing of it
              // shows); the inner column
              // keeps 18rem and is pinned to the panel's left edge, so it
              // slides out to the right instead of squeezing. The thread column
              // keeps its width; only its centring moves.
              "bg-sidebar text-sidebar-foreground relative h-full shrink-0 overflow-hidden",
              "transition-[width] duration-200 ease-linear motion-reduce:transition-none",
              dockedOpen ? "w-72" : "w-0",
            )}
          >
            <div className="border-sidebar-border absolute inset-y-0 left-0 flex w-72 flex-col border-l">
              {body(false)}
            </div>
          </aside>
        </ShellSidePanel>
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            id={COACH_PANEL_ID}
            side="right"
            showCloseButton={false}
            data-slot="coach-conversations-panel"
            className="w-[22rem] max-w-[90vw] gap-0 p-0 sm:max-w-[22rem]"
            onOpenAutoFocus={(event) => {
              // Land on the sheet itself, not its first control: on a phone
              // focusing the search field would raise the keyboard over the
              // list the person opened the sheet to read.
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
