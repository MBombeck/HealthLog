"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  PanelRightClose,
  PanelRightOpen,
  SquarePen,
  Target,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { TopBarActions } from "@/components/layout/top-bar-actions";
import { useCoachPanelOpen } from "@/hooks/use-coach-panel-open";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

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
 * The toggle sits at the trailing edge of the top bar and, while the docked
 * panel is open, beside the panel's leading edge. The panel header
 * carries the title, a link to Plans, the settings gear and, in the sheet,
 * a close button. The round New chat button sits at the bottom right.
 *
 * Keyboard: Escape closes the docked panel when focus is inside it and
 * nothing inside (a row menu, the rename field, the settings popover) has
 * already claimed the key, then focus returns to the toggle. In the sheet
 * Radix owns Escape, the focus trap and the return.
 */
export const COACH_PANEL_ID = "coach-conversations-panel";

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
      className="border-border flex shrink-0 items-center gap-2 border-b p-3"
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
        className="text-muted-foreground hover:text-foreground size-11 shrink-0 md:size-7"
      >
        <Link
          href="/coach/plans"
          data-slot="coach-panel-plans"
          aria-label={t("coach.plans.title")}
          title={t("coach.plans.title")}
        >
          <Target className="size-5 md:size-4" aria-hidden="true" />
        </Link>
      </Button>
      <CoachSettingsOverlay
        open={settingsOpen}
        onOpenChange={(next) => {
          setSettingsOpen(next);
          if (!next) setSettingsOnData(false);
        }}
        focusData={settingsOnData}
        className="md:size-7 [&_svg]:size-5 md:[&_svg]:size-4"
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
            className="text-muted-foreground hover:text-foreground size-11 shrink-0 md:size-7"
          >
            <X className="size-5 md:size-4" aria-hidden="true" />
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
      <Button
        type="button"
        size="icon"
        onClick={() => {
          onNewChat();
          afterPick();
        }}
        data-slot="coach-panel-new-chat"
        aria-label={t("insights.coach.newChat")}
        title={t("insights.coach.newChat")}
        className="absolute right-4 bottom-4 size-12 rounded-full shadow-md"
      >
        <SquarePen className="size-5" aria-hidden="true" />
      </Button>
    </>
  );

  return (
    <>
      <TopBarActions>
        <Button
          ref={toggleRef}
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-controls={COACH_PANEL_ID}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
          data-slot="coach-panel-toggle"
          className={cn(
            "text-muted-foreground hover:text-foreground size-11",
            // Docked and open, the toggle keeps the panel's width as its
            // right margin, so it stays beside the panel's leading edge and
            // travels with it as the panel opens and shuts.
            "transition-[margin] duration-200 ease-linear motion-reduce:transition-none",
            docked && dockedOpen && "mr-72",
          )}
        >
          {/* Mirrored, so the chevron points the way the panel moves on a
              click: right to shut it, left to open it. */}
          {expanded ? (
            <PanelRightOpen
              className="size-5 -scale-x-100"
              aria-hidden="true"
            />
          ) : (
            <PanelRightClose
              className="size-5 -scale-x-100"
              aria-hidden="true"
            />
          )}
        </Button>
      </TopBarActions>

      {docked ? (
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
            // The width animates; the inner column keeps 18rem and is pinned
            // to the panel's left edge, so it slides out to the right instead
            // of squeezing. The thread column beside it never changes width.
            "bg-background relative shrink-0 overflow-hidden",
            "transition-[width] duration-200 ease-linear motion-reduce:transition-none",
            dockedOpen ? "w-72" : "w-0",
          )}
        >
          <div className="border-border absolute inset-y-0 left-0 flex w-72 flex-col border-l">
            {body(false)}
          </div>
        </aside>
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
    </>
  );
}
