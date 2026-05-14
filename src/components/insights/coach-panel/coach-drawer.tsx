"use client";

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { CoachDrawerBody } from "./coach-drawer-body";
import { CoachInput } from "./coach-input";
import { CoachSettingsSheet } from "./coach-settings-sheet";
import { HistoryRail } from "./history-rail";
import { MessageThread } from "./message-thread";
import { DEFAULT_COACH_SCOPE, SourcesRail } from "./sources-rail";
import { useCoachConversation, useSendCoachMessage } from "./use-coach";
import type {
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";

/**
 * v1.4.20 phase B2b — AI Coach drawer (right-side `<Sheet>` overlay).
 *
 * Mounts above `/insights` so the user keeps the dashboard context
 * behind it. Single-column on `<lg`; on desktop the history rail and
 * sources rail mount alongside the message thread (delivered in
 * commit 3, this file lays out the slots).
 *
 * The drawer is fully-controlled by the parent (`open` /
 * `onOpenChange`). The `prefill` prop lets the hero strip's
 * suggested-prompt chips pre-populate the input on open.
 *
 * History rail + sources rail import-load asynchronously to keep the
 * drawer's first-paint cheap. Until commit 3 lands, those slots
 * render as visual placeholders that match the column widths.
 */
export interface CoachDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Optional pre-fill for the input box (suggested-prompt chip click). */
  prefill?: string | null;
  /**
   * Optional rail slots — passed by the parent so commit-3 can mount
   * the history + sources rails without coupling them to the drawer
   * shell. Falls through to a no-op when omitted.
   */
  historyRail?: React.ReactNode;
  sourcesRail?: React.ReactNode;
  /**
   * Composer slot — the parent wires `<CoachInput>` here in commit 3
   * so this shell stays presentational. The shell renders its own
   * minimal input fallback when no slot is supplied (used during the
   * commit-2 boundary to keep the drawer functional in isolation).
   */
  composer?: React.ReactNode;
}

/**
 * v1.4.23 H3 — local state seeded from a controlled prop, reset on
 * prop change. Same render-phase pattern React's docs recommend in
 * place of `useEffect(() => setState(prop), [prop])` (which the
 * `react-hooks/set-state-in-effect` ESLint rule banned). The reset
 * runs during render: React detects the queued setState, restarts
 * the render with the new value, and commits a single coherent
 * snapshot — no double paint, no flash of stale state.
 *
 * Exported so the drawer's prefill-reset behaviour can be unit-
 * tested in isolation without standing up the whole Sheet portal.
 */
export function useResettableValue<T>(
  controlledValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(controlledValue);
  // Mirror the last observed controlled value via a sibling useState
  // pair (per React docs:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  // useRef is the wrong tool here — ESLint rejects ref read+write
  // during render, and useState already gives us identity tracking
  // with no extra cost.
  const [lastSeen, setLastSeen] = useState<T>(controlledValue);
  if (!Object.is(controlledValue, lastSeen)) {
    setLastSeen(controlledValue);
    setValue(controlledValue);
  }
  return [value, setValue];
}

/**
 * v1.4.23 H3 — pure decision function behind `useResettableValue`.
 * Given the previous controlled value the hook recorded and the
 * incoming controlled value, returns either `{ reset: true, value }`
 * (the next render must seed local state with `value`) or
 * `{ reset: false }` (local state survives — the user's edits are
 * preserved). Pure + dependency-free so it tests cleanly without a
 * React renderer — pin the contract here and trust the hook
 * implementation to wire the same comparison.
 */
export function nextResettableValue<T>(
  previous: T,
  incoming: T,
): { reset: true; value: T } | { reset: false } {
  return Object.is(previous, incoming)
    ? { reset: false }
    : { reset: true, value: incoming };
}

export function CoachDrawer({
  open,
  onOpenChange,
  prefill,
  historyRail,
  sourcesRail,
  composer,
}: CoachDrawerProps) {
  const { t } = useTranslations();

  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  // v1.4.20 phase B4 — mobile rail trays. The history + sources rails
  // are hidden on `<lg` from B2b; the chevron buttons below toggle them
  // as side-sheets so the user can browse conversations + see what
  // data the Coach is using without losing the message thread context.
  const [historyTrayOpen, setHistoryTrayOpen] = useState(false);
  const [sourcesTrayOpen, setSourcesTrayOpen] = useState(false);
  // v1.4.23 H4 — Coach prompt-tuning sheet. The v1.4.22 B5 audit had
  // removed the placeholder cog from the drawer header; v1.4.23 H4
  // returns it with a real surface backed by `/api/auth/me/coach-prefs`.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v1.4.23 H3 — `prefill` is now a fully-controlled prop. The
  // v1.4.20 implementation used `key={prefill}` on the parent mount
  // to force a fresh `useState()` initialiser run on every prefill
  // transition (the "weaponise-React-keys" pattern senior-dev
  // review flagged as Sr-HIGH-4). The replacement is a tiny
  // `useResettableValue` hook below: tracks the last observed
  // prefill in a ref and schedules a same-render state update when
  // the prop changes — a textbook React render-phase update,
  // ESLint-clean against `react-hooks/set-state-in-effect`. The
  // user can still type freely; the drawer only resets the composer
  // when the parent changes which suggested-prompt chip is active.
  const [inputValue, setInputValue] = useResettableValue(prefill ?? "");
  // v1.4.20.1 — scope picker state (per-source checkboxes + window
  // selector). Resets to the all-source last30days default each time
  // the drawer mounts; no conversation-level persistence in this
  // hotfix per the v1.4.20.1 plan.
  const [scope, setScope] = useState<{
    sources: CoachScopeSource[];
    window: CoachScopeWindow;
  }>(() => ({
    sources: [...DEFAULT_COACH_SCOPE.sources],
    window: DEFAULT_COACH_SCOPE.window,
  }));

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // Reset thread + composer on close so the next open starts on
        // the rail's empty hint instead of re-rendering the previous
        // conversation by accident.
        setCurrentConversationId(null);
        setInputValue("");
      }
      onOpenChange(next);
    },
    [onOpenChange, setInputValue],
  );

  const { data: conversation } = useCoachConversation(currentConversationId);
  const send = useSendCoachMessage({
    onDone: (resolvedId) => {
      setCurrentConversationId(resolvedId);
    },
  });

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || send.isStreaming) return;
    setInputValue("");
    // Pass the scope only when the user has narrowed it from the
    // defaults — keeps the wire payload minimal and lets the route
    // tell "no opinion" apart from "intentionally narrow".
    const isDefault =
      scope.window === DEFAULT_COACH_SCOPE.window &&
      scope.sources.length === DEFAULT_COACH_SCOPE.sources.length &&
      DEFAULT_COACH_SCOPE.sources.every((s) => scope.sources.includes(s));
    const scopePayload: CoachScope | undefined = isDefault
      ? undefined
      : {
          sources: scope.sources,
          window: scope.window,
        };
    await send.send({
      conversationId: currentConversationId ?? undefined,
      message: trimmed,
      scope: scopePayload,
    });
  }

  function handleNewChat() {
    setCurrentConversationId(null);
    setInputValue("");
    send.reset();
  }

  const drawerTitle = conversation?.title ?? t("insights.coach.newChat");

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        data-slot="coach-drawer"
        className={cn(
          // Drawer keeps the dashboard context behind it. On laptops
          // (1280-1366px viewports) the previous lg:max-w-[1080px] cap
          // left only ~200-286px of underlying /insights visible — a
          // takeover, not a sheet. Drop the lg cap to min(960px,75vw)
          // so /insights always retains a readable column; restore
          // the wider three-column layout at xl+ (≥1280px sources rail
          // is hidden below xl by the body's lg:hidden chevron rules).
          "w-full p-0 sm:max-w-[720px]",
          "lg:!max-w-[min(960px,75vw)] xl:!max-w-[1080px]",
          "flex h-[100dvh] flex-col gap-0",
        )}
      >
        {/* Header (full width). Avatar + title + new-chat button +
            settings cog (v1.4.23 H4 — real per-user prompt-tuning
            surface, replacing the v1.4.22 B5 dead-button cleanup).
            pr-12 keeps the buttons clear of the Sheet's close-X on
            narrower viewports. */}
        <SheetHeader
          data-slot="coach-drawer-header"
          className="border-border/70 flex-row items-center gap-3 border-b p-3 pr-12 sm:p-4 sm:pr-14"
        >
          <div
            aria-hidden="true"
            className="from-dracula-purple to-dracula-pink flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
          >
            <Sparkles className="text-background size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-sm font-semibold">
              {drawerTitle}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground truncate text-[11px]">
              {t("insights.coach.tagline")}
            </SheetDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleNewChat}
            data-slot="coach-drawer-new-chat"
            className="shrink-0 gap-1.5"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">
              {t("insights.coach.newChat")}
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            data-slot="coach-drawer-settings"
            aria-label={t("insights.coach.settingsAriaLabel")}
            className="size-8 shrink-0"
          >
            <Settings className="size-3.5" aria-hidden="true" />
          </Button>
        </SheetHeader>

        {/* Body — three columns on lg+, single column on smaller.
            The body slot is a separate component so the SSR test
            harness can pin the mobile rail-tray triggers without
            rendering the Sheet portal. */}
        <CoachDrawerBody
          historyRail={
            historyRail ?? (
              <HistoryRail
                activeId={currentConversationId}
                onSelect={(id) => setCurrentConversationId(id)}
              />
            )
          }
          sourcesRail={
            sourcesRail ?? (
              <SourcesRail scope={scope} onScopeChange={setScope} />
            )
          }
          thread={
            <MessageThread
              conversation={conversation ?? null}
              streaming={send.streaming}
            />
          }
          composer={
            composer ?? (
              <CoachInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={() => handleSubmit(inputValue)}
                disabled={send.isStreaming}
                isStreaming={send.isStreaming}
              />
            )
          }
          onOpenHistoryTray={() => setHistoryTrayOpen(true)}
          onOpenSourcesTray={() => setSourcesTrayOpen(true)}
        />

        {/* v1.4.20 phase B4 — mobile-only rail trays. Each renders a
            slide-in panel from the matching edge and surfaces the same
            HistoryRail / SourcesRail instance the desktop layout uses,
            so a `>=lg` viewport never shows them but a `<lg` viewport
            can summon either rail without leaving the message thread. */}
        <Sheet open={historyTrayOpen} onOpenChange={setHistoryTrayOpen}>
          <SheetContent
            side="left"
            data-slot="coach-drawer-history-tray"
            className="w-[88vw] max-w-[320px] p-0 lg:hidden"
          >
            <SheetHeader className="border-border/70 border-b p-3">
              <SheetTitle className="text-sm">
                {t("insights.coach.historyTitle")}
              </SheetTitle>
            </SheetHeader>
            <div className="h-full min-h-0 overflow-y-auto">
              {historyRail ?? (
                <HistoryRail
                  activeId={currentConversationId}
                  onSelect={(id) => {
                    setCurrentConversationId(id);
                    setHistoryTrayOpen(false);
                  }}
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
        {/* v1.4.23 H4 — Coach prompt-tuning sheet. Right-edge sheet so
            it doesn't conflict with the existing left/right rail
            trays (those are <lg / <xl only; the settings sheet works
            on every viewport). */}
        <CoachSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
        <Sheet open={sourcesTrayOpen} onOpenChange={setSourcesTrayOpen}>
          <SheetContent
            side="right"
            data-slot="coach-drawer-sources-tray"
            // Sources rail is xl+ inline; on lg it's only available
            // via this tray to match the narrowed drawer cap.
            className="w-[88vw] max-w-[320px] p-0 xl:hidden"
          >
            <SheetHeader className="border-border/70 border-b p-3">
              <SheetTitle className="text-sm">
                {t("insights.coach.sourcesTitle")}
              </SheetTitle>
            </SheetHeader>
            <div className="h-full min-h-0 overflow-y-auto">
              {sourcesRail ?? (
                <SourcesRail scope={scope} onScopeChange={setScope} />
              )}
            </div>
          </SheetContent>
        </Sheet>
      </SheetContent>
    </Sheet>
  );
}
