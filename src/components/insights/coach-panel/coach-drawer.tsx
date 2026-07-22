"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Maximize2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  CoachCloseIntent,
  CoachLaunchScope,
} from "@/lib/insights/coach-launch-context";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useIsMobile } from "@/hooks/use-is-mobile";

import { CoachConversation } from "./coach-conversation";

// v1.12.0 — `useResettableValue` + `nextResettableValue` moved into
// `./use-resettable-value` so the shared `<CoachConversation>` surface
// can seed its composer without importing the drawer shell. Re-exported
// here for the existing prefill-controller unit test import path.
export {
  useResettableValue,
  nextResettableValue,
} from "./use-resettable-value";

/**
 * v1.28.52 (Documents R3) — the full-page target the maximize control hands
 * off to, kept pure so the continuity rules are unit-testable.
 *
 * Precedence:
 *   - a live conversation id (a turn has created the thread) → `/coach?c=<id>`
 *     so the exact thread re-opens on the page, scope and all.
 *   - else a document scope (a doc-scoped drawer maximized before its first
 *     turn) → `/coach?doc=<id>` so the fresh page chat stays scoped.
 *   - else a workout scope (v1.31.0, same pre-first-turn case) →
 *     `/coach?workout=<id>`.
 *   - else the plain `/coach` new-chat surface.
 *
 * A document scope wins over a workout scope: the two are never set together
 * by any launch call site, and a fenced document conversation has the stricter
 * transport, so it is the safer arm to prefer if they ever collided.
 */
export function coachMaximizeHref(
  conversationId: string | null,
  documentId?: string | null,
  workoutId?: string | null,
): string {
  if (conversationId) return `/coach?c=${conversationId}`;
  if (documentId) return `/coach?doc=${documentId}`;
  if (workoutId) return `/coach?workout=${workoutId}`;
  return "/coach";
}

/**
 * v1.4.20 phase B2b — AI Coach drawer (right-side `<Sheet>` overlay).
 *
 * Mounts above `/insights` so the user keeps the dashboard context
 * behind it. The drawer is fully-controlled by the parent (`open` /
 * `onOpenChange`). The `prefill` prop lets the hero strip's
 * suggested-prompt chips pre-populate the input on open.
 *
 * v1.12.0 (Coach v2 #6) — the chat surface itself (header actions,
 * body, thread, composer, rails, settings, mobile trays) is now the
 * shared `<CoachConversation>` component, reused verbatim by the
 * full-page Coach route (`/coach`). This file is the drawer
 * CHROME only: the `<Sheet>` wrapper, the close button, and the
 * maximize control that hands the conversation off to the full page.
 */
export interface CoachDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean, closeIntent?: CoachCloseIntent) => void;
  /** Optional pre-fill for the input box (suggested-prompt chip click). */
  prefill?: string | null;
  /**
   * v1.21.0 (C4 H1/H4) — optional launch scope so a conversation opened
   * from a metric surface or insight card is pre-narrowed to the relevant
   * source(s) + window. Null → the route's default all-source snapshot.
   */
  scope?: CoachLaunchScope | null;
  /**
   * When true, the conversation auto-sends `prefill` as its first turn
   * exactly once on open. Used by the assessment hand-off.
   */
  autoSend?: boolean;
  /**
   * v1.28.52 (Documents R3) — the stored document this drawer chat is scoped
   * to (the vault "Ask the Coach" action). Forwarded to `<CoachConversation>`
   * as `initialDocumentId` so the first turn routes through the hardened
   * fenced endpoint; the maximize control preserves the scope when no thread
   * exists yet (`/coach?doc=<id>`).
   */
  documentId?: string | null;
  /**
   * v1.31.0 — the workout this drawer chat is scoped to. Threads onto the
   * FIRST turn only; the maximize control preserves it when no thread exists
   * yet. Unlike `documentId` it does not switch the transport — the workout
   * evidence is a numbers-only server projection on the normal Coach route.
   */
  workoutId?: string | null;
}

export function CoachDrawer({
  open,
  onOpenChange,
  prefill,
  scope,
  autoSend,
  documentId,
  workoutId,
}: CoachDrawerProps) {
  const { t } = useTranslations();
  const router = useRouter();
  // v1.4.27 R3d MB1 — below the `sm` breakpoint (640 px) the Coach
  // drawer slides up from the bottom edge of the viewport instead of
  // sliding in from the right. Right-side slide makes the back-arrow
  // / close-X drift far from the user's thumb on a phone; bottom-up
  // keeps the drawer chrome reachable. Above `sm` the drawer keeps
  // its existing right-side slide and `sm:max-w-[720px]` cap.
  const isPhoneViewport = useIsMobile("sm");

  // The shared surface hands us an imperative reset so closing the
  // drawer can abort an in-flight SSE stream + clear the thread.
  const resetRef = useRef<(() => void) | null>(null);
  const registerReset = useCallback((reset: () => void) => {
    resetRef.current = reset;
  }, []);

  // v1.28.52 (Documents R3) — the live conversation id lives inside the shared
  // surface; this imperative getter (registered parallel to `registerReset`)
  // lets the maximize control read it so it can preserve the thread / doc scope
  // when handing off to the full page.
  const conversationIdGetterRef = useRef<(() => string | null) | null>(null);
  const registerConversationIdGetter = useCallback(
    (getter: () => string | null) => {
      conversationIdGetterRef.current = getter;
    },
    [],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // Abort any in-flight streamed reply + reset the thread so the
        // next open starts on the rail's empty hint.
        resetRef.current?.();
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleMaximize = useCallback(() => {
    // Hand the conversation off to the full-page surface, PRESERVING scope:
    // read the live thread id (or fall back to the document scope) BEFORE the
    // reset clears it, so a doc-scoped drawer maximizes into the same doc /
    // thread instead of a blank `/coach`.
    const href = coachMaximizeHref(
      conversationIdGetterRef.current?.() ?? null,
      documentId,
      workoutId,
    );
    // Close the drawer (aborts any in-flight stream via `handleOpenChange`)
    // then route to the dedicated page.
    onOpenChange(false, "navigate");
    resetRef.current?.();
    router.push(href);
  }, [onOpenChange, router, documentId, workoutId]);

  // v1.21.4 (Coach-UI B) — the drawer's "Conversations" affordance now hands
  // off to the dedicated conversation-history page (`/coach/conversations`),
  // which renders the search + recency-grouped list as a sibling of the
  // Coach page. The former `?view=conversations` in-page slide-in drawer is
  // gone; selecting a row there routes back to `/coach?c=<id>`.
  const handleOpenConversations = useCallback(() => {
    onOpenChange(false, "navigate");
    resetRef.current?.();
    router.push("/coach/conversations");
  }, [onOpenChange, router]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        // v1.4.27 R3d MB1 — below `sm` the drawer slides up from the
        // bottom edge so the header chrome stays near the user's thumb;
        // above `sm` it keeps its existing right-side slide.
        side={isPhoneViewport ? "bottom" : "right"}
        // v1.4.25 W5 — render our own Close button inside the header so
        // X / maximize sit on the same baseline with identical size,
        // color, and hit target.
        showCloseButton={false}
        data-slot="coach-drawer"
        data-variant={isPhoneViewport ? "bottom-sheet" : "side-sheet"}
        className={cn(
          // Drawer keeps the dashboard context behind it. Drop the lg
          // cap to min(960px,75vw) so /insights always retains a
          // readable column; restore the wider layout at xl+.
          "w-full p-0 sm:max-w-[720px]",
          "lg:!max-w-[min(960px,75vw)] xl:!max-w-[1080px]",
          isPhoneViewport
            ? "flex h-[90dvh] max-h-[90dvh] flex-col gap-0 rounded-t-2xl"
            : "flex h-[100dvh] flex-col gap-0",
        )}
      >
        <CoachConversation
          surface="drawer"
          prefill={prefill}
          launchScope={scope}
          autoSend={autoSend}
          // v1.28.52 (Documents R3) — scope a fresh drawer chat to a stored
          // document (vault "Ask the Coach"); the send path is unchanged (the
          // fenced document endpoint), only WHERE it renders (drawer vs page).
          initialDocumentId={documentId}
          initialWorkoutId={workoutId}
          autoFocusComposer
          registerReset={registerReset}
          // Lets the maximize control read the live thread id at hand-off time.
          registerConversationIdGetter={registerConversationIdGetter}
          // v1.16.1 — the "Conversations" affordance hands off to a
          // dedicated route instead of opening the broken in-panel left
          // tray. v1.21.4 (Coach-UI B) — it now navigates to
          // `/coach/conversations`, the standalone search + grouped-list page.
          onRequestFullView={handleOpenConversations}
          // Radix requires an accessible name + description on the
          // dialog content. Mount them through the title/description
          // render-props so the page can swap in a plain heading.
          renderTitle={(title) => (
            <SheetTitle className="min-w-0 truncate text-sm font-semibold">
              {title}
            </SheetTitle>
          )}
          renderDescription={(tagline) => (
            <SheetDescription className="text-muted-foreground truncate text-xs">
              {tagline}
            </SheetDescription>
          )}
          // Maximize control at the leading edge — hands the
          // conversation off to the full-page Coach route.
          leadingHeaderActions={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              onClick={handleMaximize}
              data-slot="coach-drawer-maximize"
              aria-label={t("insights.coach.maximizeAriaLabel")}
              title={t("insights.coach.maximizeAriaLabel")}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          }
          // Close button — the drawer's own, replacing the Sheet's
          // absolutely-positioned default so the action cluster shares
          // one baseline.
          trailingHeaderActions={
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                data-slot="coach-drawer-close"
                aria-label={t("common.close")}
                title={t("common.close")}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
