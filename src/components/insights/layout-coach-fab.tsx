"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RAIL_ICONS } from "@/components/layout/destination-icons/rail";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { queryKeys } from "@/lib/query-keys";

import { apiGet, apiPost } from "@/lib/api/api-fetch";

const CoachIcon = RAIL_ICONS.coach;

/**
 * v1.16.8 — the Coach FAB is a permanent launcher again, now on EVERY
 * authenticated page (mounted once in `<AuthShell>`, no longer scoped
 * to `/insights/**`). The v1.16.1 nudge-only bubble folded into it: the
 * FAB always renders, and an unread proactive Coach message (surfaced
 * by `/api/insights/coach/nudge-status`) paints a small unread dot on
 * its corner instead of toggling the whole button.
 *
 * v1.18.6 — the proactive nudge now lands as a real
 * ASSISTANT message in the conversation rail, not a notification-only
 * dispatch, so the unread signal moved onto the server-authoritative
 * `User.coachLastSeenAt` stamp: `status.unread` is true while a Coach
 * message is newer than the last time the user opened the Coach. Opening
 * the Coach (this FAB, or the `/coach` page) fires
 * `POST /api/insights/coach/seen`, which stamps the server and clears
 * the dot everywhere (web + iOS). A local "seen" stamp is kept only as
 * an instant-paint optimisation so the dot disappears the moment the
 * user taps, before the mutation round-trips.
 *
 * The FAB hides inside the Coach view itself (`/coach`) — a
 * launcher pointing at the page the user is already on is noise.
 *
 * It yields while a data-list selection bar is mounted (CSS `:has()`
 * gate) so it never covers the bar's delete action. The v1.4.33
 * chart-tooltip auto-hide is gone: blinking out on every chart hover
 * read as a glitch, and a hover tooltip under the cursor never reaches
 * the lower-right corner anyway.
 */

const NUDGE_SEEN_STORAGE_KEY = "healthlog-coach-nudge-seen";

export interface CoachNudgeStatus {
  nudgedAt: string | null;
  unread: boolean;
  /**
   * v1.22 — the conversation holding the newest assistant message, so
   * the FAB can deep-link into the proactive thread on the unread path
   * instead of opening a blank new chat. Null when no Coach reply exists.
   */
  conversationId: string | null;
}

/**
 * Pure unread derivation — the server signal is authoritative
 * (`status.unread` already compares the newest Coach message against the
 * persisted `coachLastSeenAt`). The local seen-stamp only suppresses the
 * dot for an instant after the user taps, before the mark-seen mutation
 * + status refetch land. Exported so the unit test pins the contract
 * without a QueryClient round-trip.
 */
export function isNudgeUnread(
  status: CoachNudgeStatus | undefined,
  seenStamp: string | null,
): boolean {
  if (!status?.unread || status.nudgedAt === null) return false;
  return seenStamp !== status.nudgedAt;
}

/**
 * The seizure diary is an emergency surface: a carer reads the threshold
 * alert and taps the call button there, and the launcher covered the end of
 * that alert on a phone.
 */
function isEmergencySurface(pathname: string | null): boolean {
  return pathname?.startsWith("/seizures") ?? false;
}

export function LayoutCoachFab() {
  const { t } = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const launch = useCoachLaunch();
  // One answer for every Coach entry point: the `coach` capability on
  // `/api/auth/me` (operator switch, Hide Coach, provider, consent).
  const coach = useAiCapability("coach");

  // Local "seen on this device" stamp — the nudge timestamp the user
  // last dismissed by opening the chat. Lazy initialiser per the
  // `react-hooks/set-state-in-effect` rule.
  const [seenStamp, setSeenStamp] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(NUDGE_SEEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const coachAvailable = !!launch && coach.available;
  const onCoachPage = pathname?.startsWith("/coach") ?? false;
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: queryKeys.coachNudgeStatus(),
    queryFn: async (): Promise<CoachNudgeStatus> => {
      return apiGet<CoachNudgeStatus>("/api/insights/coach/nudge-status");
    },
    enabled: coachAvailable && !onCoachPage,
    staleTime: 5 * 60 * 1000,
  });

  // v1.18.6 — stamp `coachLastSeenAt` server-side when the user
  // opens the Coach so the dot clears across every device. Fire-and-
  // forget from the UI's perspective (the local seen-stamp already
  // suppressed the dot); on success the status query refetches so the
  // server-authoritative `unread` re-resolves to false.
  const markSeen = useMutation({
    mutationKey: queryKeys.coachMarkSeen(),
    mutationFn: async () =>
      apiPost<{ seenAt: string }>("/api/insights/coach/seen", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachNudgeStatus(),
      });
    },
  });

  const nudgedAt = status?.nudgedAt ?? null;
  // ONE source for the dot: an assistant message the user has not opened yet.
  //
  // v1.22 added a second arm — a separate "any due reminder?" query — and that
  // is the arm that produced a badge over an empty Coach. The sweep flipped a
  // reminder to `due` without writing anything into a conversation, so the dot
  // promised a message that did not exist; opening the Coach showed the empty
  // state and did not clear the dot either, because only resolving the reminder
  // in Settings could. The sweep now writes the reminder into the thread as a
  // real assistant message (`coach-reminder-sweep.ts`), which the nudge status
  // already reports — so the reminder still lights the dot, through the message
  // it actually wrote, and opening the Coach clears it like any other.
  const unread = isNudgeUnread(status, seenStamp);
  const showDot = unread;

  // The unread dot is visual-only (`aria-hidden`) and the swapped
  // `aria-label` is not announced on mutation — a screen-reader user
  // never hears about a fresh nudge. The polite live region below the
  // button emits the nudge copy once on the unread rising edge and
  // clears when the nudge is read, so the announcement fires exactly
  // once per nudge.
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const prevUnreadRef = useRef(false);
  useEffect(() => {
    if (unread && !prevUnreadRef.current) {
      setLiveAnnouncement(t("insights.coach.nudgeBubbleLabel"));
    } else if (!unread && prevUnreadRef.current) {
      setLiveAnnouncement("");
    }
    prevUnreadRef.current = unread;
  }, [unread, t]);

  // Visiting the Coach page itself counts as reading the nudge — persist
  // the local instant-paint stamp AND stamp the server so the dot stays
  // gone after leaving, on every device. Fired once per page entry: the
  // ref guards against the effect re-running on unrelated re-renders.
  const seenStampedRef = useRef(false);
  useEffect(() => {
    if (!onCoachPage) {
      seenStampedRef.current = false;
      return;
    }
    if (seenStampedRef.current) return;
    seenStampedRef.current = true;
    if (nudgedAt !== null) {
      try {
        window.localStorage.setItem(NUDGE_SEEN_STORAGE_KEY, nudgedAt);
      } catch {
        // Storage unavailable (private mode) — the server stamp below
        // still clears the dot once it round-trips.
      }
    }
    markSeen.mutate();
    // `markSeen` is a stable mutation object; excluding it keeps the
    // effect from re-firing on its internal state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCoachPage, nudgedAt]);

  if (!coachAvailable) return null;
  // The Coach chat page IS the destination — no launcher on top of it.
  if (onCoachPage || isEmergencySurface(pathname)) return null;

  const accessibleLabel = unread
    ? t("insights.coach.nudgeBubbleLabel")
    : t("insights.coach.fabLabel");

  const handleOpen = () => {
    if (nudgedAt !== null) {
      setSeenStamp(nudgedAt);
      try {
        window.localStorage.setItem(NUDGE_SEEN_STORAGE_KEY, nudgedAt);
      } catch {
        // Best effort — see above.
      }
    }
    // v1.18.6 — stamp the server so the dot clears on every
    // device, not just this one. The local stamp above already hid the
    // dot for an instant paint; the mutation makes it durable.
    if (unread) markSeen.mutate();
    // v1.22 — when the Coach has written an UNREAD proactive message,
    // deep-link straight into that conversation (`/coach?c=<id>`) so the
    // user lands on what the Coach said, rather than opening a blank new
    // chat in the drawer. The full page honours `?c=` →
    // `initialConversationId`. Fall back to the in-place drawer for the
    // ordinary launcher case (no unread, or no conversation id yet).
    const conversationId = status?.conversationId ?? null;
    if (unread && conversationId) {
      router.push(`/coach?c=${conversationId}`);
      return;
    }
    // v1.16.11 — open the side drawer in place (the launch context the
    // layout mount consumes) instead of navigating to the chat page;
    // the conversation arrives without losing the page underneath.
    launch?.askCoach();
  };

  return (
    <>
      <Button
        type="button"
        size="icon"
        data-slot="coach-fab"
        // Steps aside while the on-screen keyboard is open (globals.css).
        data-keyboard-hide=""
        data-unread={showDot ? "true" : undefined}
        onClick={handleOpen}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        className={cn(
          // Size and bottom are the shell's floating-action tokens
          // (globals.css): `--floating-action-bottom` stands the button 1rem
          // above the bottom nav and the home indicator in the phone shell
          // and 2rem above the window's edge in the desktop shell, and the
          // page frame clears the same tokens, so the last line scrolls out
          // from under the button. The right inset is `right-6` on a phone
          // and `md:right-8` from `md`, plus the side inset of a phone held
          // sideways.
          "fixed right-[calc(var(--safe-area-right)+1.5rem)] bottom-(--floating-action-bottom) z-40 size-(--floating-action-size) rounded-full shadow-lg md:right-[calc(var(--safe-area-right)+2rem)]",
          // The accent ink with the page colour as its glyph: the one
          // floating action is ink like every other primary (1.50).
          "bg-primary text-background hover:bg-primary/90",
          // The default ring alone is hard to see against the fill;
          // the offset ring draws a clear halo around the circle.
          "focus-visible:ring-offset-background focus-visible:ring-offset-2",
          "transition-[opacity,right] duration-150 motion-reduce:transition-none",
          // v1.42 — from 1280 px the day's 2.5 rem strip stays at the right
          // edge; the launcher stays clear of it. While the day is open, the
          // launcher moves left with the page's own edge, so it stays over
          // the page and never over the day's footer actions. The `:has()`
          // gates key off the strip's state, so exactly one of them holds.
          "[body:has([data-slot=day-strip][data-state=closed])_&]:right-[calc(2.5rem+2rem)]",
          "[body:has([data-slot=day-strip][data-state=open])_&]:right-[calc(26.25rem+2.5rem+2rem)]",
          // Yield to the data-list selection bar: its delete action lands
          // in the same lower-right band, and the destructive control
          // wins. The `:has()` gate keys off the bar's `data-slot`.
          // `invisible` (visibility:hidden) removes the hidden button
          // from the tab order + accessibility tree — `opacity-0`
          // alone left it focusable and operable while unseeable.
          "[body:has([data-slot=selection-action-bar])_&]:pointer-events-none",
          "[body:has([data-slot=selection-action-bar])_&]:opacity-0",
          "[body:has([data-slot=selection-action-bar])_&]:invisible",
          // Same yield while the onboarding tour overlay is up — the
          // tour dims the page and drives focus itself; a floating
          // launcher on top of the spotlight is noise.
          "[body:has([data-testid=onboarding-tour])_&]:pointer-events-none",
          "[body:has([data-testid=onboarding-tour])_&]:opacity-0",
          "[body:has([data-testid=onboarding-tour])_&]:invisible",
        )}
      >
        <CoachIcon className="text-background size-6" aria-hidden="true" />
        {showDot ? (
          // v1.18.6 — discreet "the Coach said something" dot.
          // Deliberately NOT an alarming red (the medication-card rule:
          // status via calm signal, never an alarm tint): a small cyan
          // dot ringed against the FAB background reads as informative,
          // not urgent.
          <span
            data-slot="coach-fab-unread"
            aria-hidden="true"
            className="border-background bg-info absolute top-0.5 right-0.5 size-3 rounded-full border-2"
          />
        ) : null}
      </Button>
      {/* Polite announcement for the unread-nudge arrival — see the
          rising-edge effect above. */}
      <span data-slot="coach-fab-live" aria-live="polite" className="sr-only">
        {liveAnnouncement}
      </span>
    </>
  );
}
