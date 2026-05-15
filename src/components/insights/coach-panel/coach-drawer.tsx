"use client";

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Plus, Settings, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useCoachPrefs } from "@/hooks/use-coach-prefs";
import { useIsMobile } from "@/hooks/use-is-mobile";

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
  // v1.4.20.1 — scope picker state (per-source checkboxes + window
  // selector). Resets to the all-source last30days default each time
  // the drawer mounts; no conversation-level persistence in this
  // hotfix per the v1.4.20.1 plan.
  //
  // v1.4.25 W5 — the scope.window field is now a two-layer override:
  //   • the user's saved `coachPrefs.defaultWindow` is the base
  //   • the header pill drops a per-conversation override into
  //     `windowOverride`; null = "use the saved default"
  // The override resets to null on drawer close so the next session
  // starts on the user's saved preference.
  const [scope, setScope] = useState<{
    sources: CoachScopeSource[];
    window: CoachScopeWindow;
  }>(() => ({
    sources: [...DEFAULT_COACH_SCOPE.sources],
    window: DEFAULT_COACH_SCOPE.window,
  }));
  const [windowOverride, setWindowOverride] = useState<CoachScopeWindow | null>(
    null,
  );

  // v1.4.25 W5 — load the user's saved Coach prefs so the default
  // window picks up the cog's saved selection. The hook gates the
  // fetch on `enabled` so the network call only fires while the
  // drawer is open. Falls through to the legacy "last30days" default
  // when the row is missing or the request is in flight.
  const { data: coachPrefs } = useCoachPrefs({ enabled: open });
  const savedDefaultWindow: CoachScopeWindow =
    coachPrefs?.defaultWindow ?? DEFAULT_COACH_SCOPE.window;
  const effectiveWindow: CoachScopeWindow =
    windowOverride ?? savedDefaultWindow;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // Reset thread + composer on close so the next open starts on
        // the rail's empty hint instead of re-rendering the previous
        // conversation by accident. v1.4.25 W5 — also drop the
        // per-conversation window override so the next session starts
        // on the user's saved `coachPrefs.defaultWindow` again.
        setCurrentConversationId(null);
        setInputValue("");
        setWindowOverride(null);
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
    //
    // v1.4.25 W5 — `scope.window` now reflects the per-conversation
    // override (header pill / rail picker) layered on top of the saved
    // `coachPrefs.defaultWindow`. Send the override only when the user
    // explicitly diverged from the saved default; otherwise the route
    // re-applies the saved preference itself.
    const allSourcesSelected =
      scope.sources.length === DEFAULT_COACH_SCOPE.sources.length &&
      DEFAULT_COACH_SCOPE.sources.every((s) => scope.sources.includes(s));
    const isDefault = allSourcesSelected && windowOverride === null;
    const scopePayload: CoachScope | undefined = isDefault
      ? undefined
      : {
          sources: scope.sources,
          window: effectiveWindow,
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
            ? // Bottom-sheet caps at 95 dvh so a sliver of the underlying
              // /insights page remains visible — clear "this is a
              // sheet, not a takeover" signal. The rounded top corners
              // match the iOS bottom-sheet feel.
              "flex h-[95dvh] max-h-[95dvh] flex-col gap-0 rounded-t-2xl"
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
          {/* v1.4.25 W5 — per-conversation window override. The pill
              defaults to the user's saved `coachPrefs.defaultWindow`
              and resets to it on drawer close. Changing the pill flips
              `windowOverride`; the rail's window picker mirrors the
              same source-of-truth so the user can drive the override
              from either surface.

              v1.4.27 R3d MB4 — on `<sm` viewports the bottom-sheet
              header already carries the avatar, title, new-chat,
              settings, and close buttons; one more pill there shrinks
              the title to a single character before truncation. The
              same override is still reachable from the sources-rail's
              window picker, which is what the user opens via the
              right-edge chevron tray on phone-class viewports. */}
          <div
            data-slot="coach-drawer-window-pill-wrap"
            className="hidden sm:block"
          >
            <Select
              value={effectiveWindow}
              onValueChange={(value) => {
                const next = value as CoachScopeWindow;
                setWindowOverride(next === savedDefaultWindow ? null : next);
              }}
            >
              <SelectTrigger
                data-slot="coach-drawer-window-pill"
                aria-label={t("insights.coach.windowLabel")}
                className={cn(
                  "border-border/60 bg-muted/40 text-foreground h-11 shrink-0 gap-1 rounded-full px-3 text-xs",
                  "hover:bg-muted/60 focus-visible:ring-ring/40 focus-visible:ring-2",
                  windowOverride !== null &&
                    "border-dracula-purple/40 bg-dracula-purple/10 text-dracula-purple",
                )}
              >
                <SelectValue
                  placeholder={t(`insights.coach.window.${effectiveWindow}`)}
                />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="last7days" className="text-xs">
                  {t("insights.coach.window.last7days")}
                </SelectItem>
                <SelectItem value="last30days" className="text-xs">
                  {t("insights.coach.window.last30days")}
                </SelectItem>
                <SelectItem value="last90days" className="text-xs">
                  {t("insights.coach.window.last90days")}
                </SelectItem>
                <SelectItem value="allTime" className="text-xs">
                  {t("insights.coach.window.allTime")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
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
          sourcesRail={
            sourcesRail ?? (
              <SourcesRail
                // v1.4.25 W5 — overlay the effective window on the rail
                // so the picker mirrors the per-conversation override
                // (or the saved default when no override is active).
                // The rail's own onChange flips `windowOverride` so the
                // rail picker is just another way to set the override.
                scope={{ sources: scope.sources, window: effectiveWindow }}
                onScopeChange={(next) => {
                  setScope((prev) => ({ ...prev, sources: next.sources }));
                  setWindowOverride(
                    next.window === savedDefaultWindow ? null : next.window,
                  );
                }}
              />
            )
          }
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
                <SourcesRail
                  scope={{
                    sources: scope.sources,
                    window: effectiveWindow,
                  }}
                  onScopeChange={(next) => {
                    setScope((prev) => ({ ...prev, sources: next.sources }));
                    setWindowOverride(
                      next.window === savedDefaultWindow ? null : next.window,
                    );
                  }}
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
      </SheetContent>
    </Sheet>
  );
}
