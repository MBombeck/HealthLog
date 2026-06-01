"use client";

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Plus, Settings, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useIsMobile } from "@/hooks/use-is-mobile";

import { CoachDrawerBody } from "./coach-drawer-body";
import { CoachInput } from "./coach-input";
import { CoachSettingsSheet } from "./coach-settings-sheet";
import { HistoryRail } from "./history-rail";
import { MessageThread } from "./message-thread";
import { MobileRailTray } from "./mobile-rail-tray";
import { SourcesRail } from "./sources-rail";
import { useCoachConversation, useSendCoachMessage } from "./use-coach";

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
  // v1.4.27 R3d MB1 — below the `sm` breakpoint (640 px) the Coach
  // drawer slides up from the bottom edge of the viewport instead of
  // sliding in from the right. Right-side slide makes the back-arrow
  // / close-X drift far from the user's thumb on a phone; bottom-up
  // keeps the drawer chrome reachable. Above `sm` the drawer keeps
  // its existing right-side slide and `sm:max-w-[720px]` cap.
  const isPhoneViewport = useIsMobile("sm");

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

  // v1.7.2 — the data-source scope is no longer ephemeral drawer state.
  // Both the chat-side sources rail and the settings cog now drive the
  // persisted `coachPrefsJson` row (clusters + default window) through
  // `PUT /api/auth/me/coach-prefs`. The chat request carries no `scope`
  // override at all, so the snapshot builder expands the saved clusters
  // and folds the saved window server-side — "what the rail shows" and
  // "what the model receives" cannot drift.

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
    // v1.7.2 — no `scope` override on the wire. The route resolves the
    // source set and window from the user's persisted `coachPrefsJson`
    // (the same row the sources rail + settings cog edit), so the chat
    // request stays minimal and the prompt scope is guaranteed to match
    // what the rail displays.
    await send.send({
      conversationId: currentConversationId ?? undefined,
      message: trimmed,
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
        // v1.4.27 R3d MB1 — below `sm` the drawer slides up from the
        // bottom edge so the header chrome stays near the user's thumb;
        // above `sm` it keeps its existing right-side slide.
        side={isPhoneViewport ? "bottom" : "right"}
        // v1.4.25 W5 — render our own Close button inside the header so
        // X / cog / new-chat sit on the same baseline with identical
        // size, color, and hit target. The Sheet's default close-X is
        // absolutely positioned with `opacity-70` + tiny `rounded-xs`,
        // which Marc flagged as misaligned with the rest of the header
        // cluster.
        showCloseButton={false}
        data-slot="coach-drawer"
        data-variant={isPhoneViewport ? "bottom-sheet" : "side-sheet"}
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
          isPhoneViewport
            ? // Bottom-sheet caps at 90 dvh so a 10 % slice of the
              // underlying /insights page stays visible — same
              // convention as every other mobile sheet on the app via
              // <ResponsiveSheet>'s phone branch (v1.4.28 R3c BK-M5
              // alignment; previously 95 dvh, which left only a 5 %
              // sliver and read as a takeover instead of a sheet).
              // Rounded top corners match the iOS bottom-sheet feel.
              "flex h-[90dvh] max-h-[90dvh] flex-col gap-0 rounded-t-2xl"
            : "flex h-[100dvh] flex-col gap-0",
        )}
      >
        {/* Header (full width). Avatar + title + new-chat button +
            settings cog + close X. v1.4.25 W5 — the three header
            actions (new chat, settings, close) all use the same
            `ghost / size-icon / size-9` shape so they share a single
            visual cluster instead of feeling like three different
            controls. The close X used to be the Sheet's absolutely
            positioned default; bringing it inline normalises the row
            and frees the `pr-*` reservation. */}
        <SheetHeader
          data-slot="coach-drawer-header"
          className="border-border/70 flex-row items-center gap-2 border-b p-3 sm:gap-3 sm:p-4"
        >
          <div
            aria-hidden="true"
            className="from-dracula-purple to-dracula-pink flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
          >
            <Sparkles className="text-background size-4" />
          </div>
          <div className="min-w-0 flex-1">
            {/* v1.4.27 R3d MB4 / CF-73 — pin `min-w-0` on the title
                node itself in addition to the wrapper so the
                truncate clipping survives any flex-shrink quirk
                with very long conversation titles. */}
            <SheetTitle className="min-w-0 truncate text-sm font-semibold">
              {drawerTitle}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground truncate text-[11px]">
              {t("insights.coach.tagline")}
            </SheetDescription>
          </div>
          {/* v1.7.2 — the per-conversation window override pill was
              retired. The analysis window now persists alongside the
              data-source clusters via the sources rail (and the
              settings cog), so a single, sticky window control replaces
              the ephemeral header override. */}
          {/* v1.4.25 W5 — header action cluster. All three buttons
              share the same `ghost / size-icon / size-9` shape so they
              visually belong together. 36×36 px hit target meets the
              WCAG 2.1 AA touch-target minimum on mobile; the icons
              themselves stay 18 px to match the avatar's optical
              weight. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleNewChat}
            data-slot="coach-drawer-new-chat"
            aria-label={t("insights.coach.newChat")}
            title={t("insights.coach.newChat")}
            className="text-muted-foreground hover:text-foreground size-11 shrink-0"
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            data-slot="coach-drawer-settings"
            aria-label={t("insights.coach.settingsAriaLabel")}
            title={t("insights.coach.settingsAriaLabel")}
            className="text-muted-foreground hover:text-foreground size-11 shrink-0"
          >
            <Settings className="size-4" aria-hidden="true" />
          </Button>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-slot="coach-drawer-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              className="text-muted-foreground hover:text-foreground size-11 shrink-0"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </SheetClose>
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
          sourcesRail={sourcesRail ?? <SourcesRail />}
          thread={
            <MessageThread
              conversation={conversation ?? null}
              streaming={send.streaming}
              optimisticUser={send.optimisticUser}
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
                // v1.4.27 MB3 / CF-30 — the composer mounts on drawer
                // open and unmounts on close (the body collapses with
                // the sheet), so a one-shot mount focus matches the
                // "drawer just opened" semantic without any re-render
                // gymnastics.
                autoFocusOnOpen
              />
            )
          }
          onOpenHistoryTray={() => setHistoryTrayOpen(true)}
          onOpenSourcesTray={() => setSourcesTrayOpen(true)}
        />

        {/* v1.4.23 H4 — Coach prompt-tuning sheet. Right-edge sheet so
            it doesn't conflict with the existing rail trays (those are
            <lg / <xl only; the settings sheet works on every
            viewport). */}
        <CoachSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
        {/* v1.4.28 R3c (BK-F-M6) — mobile-only rail trays carved out of
            the drawer shell. Each tray surfaces the same HistoryRail /
            SourcesRail instance the desktop layout uses; the parent
            still owns the open/closed state + the rail callbacks so
            the carve-out is pure render. */}
        <MobileRailTray
          historyOpen={historyTrayOpen}
          onHistoryOpenChange={setHistoryTrayOpen}
          historyRail={
            historyRail ?? (
              <HistoryRail
                activeId={currentConversationId}
                onSelect={(id) => {
                  setCurrentConversationId(id);
                  setHistoryTrayOpen(false);
                }}
              />
            )
          }
          sourcesOpen={sourcesTrayOpen}
          onSourcesOpenChange={setSourcesTrayOpen}
          sourcesRail={sourcesRail ?? <SourcesRail />}
        />
      </SheetContent>
    </Sheet>
  );
}
