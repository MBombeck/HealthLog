"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { CoachConversation } from "@/components/insights/coach-panel/coach-conversation";
import { COACH_INTERRUPTED_STORAGE_KEY } from "@/components/insights/coach-panel/use-coach";
import type { CoachNudgeStatus } from "@/components/insights/layout-coach-fab";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAiCapabilityAnswer } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { coachScopeSourceSchema } from "@/lib/ai/coach/types";

/**
 * v1.12.0 (Coach v2 #6) — full-page Coach conversation.
 *
 * Renders the exact same `<CoachConversation>` surface the drawer uses
 * (history + streaming thread + composer + provenance + settings) at
 * full width and height. There is no forked chat logic — the page is a
 * thin chrome wrapper around the shared surface.
 *
 * v1.18.0 — the route is a standalone top-level page (`/coach`), no longer
 * nested under `app/insights/layout.tsx`, so it renders in the standard
 * page chrome WITHOUT the Insights tab strip. It still sits inside the
 * authenticated `<AuthShell>` (which provides the `<CoachLaunchProvider>`
 * the bottom-right FAB drawer reopens through), so the page inherits the
 * same Coach feature gating as every other Coach surface. When the
 * operator's master flag is off or the user opted out, the page redirects
 * back to `/insights` rather than painting a dead chat shell.
 *
 * v1.18.10 (W4) — the page is now a single full-bleed conversation
 * surface: the inner panel chrome (the bordered/rounded card) is gone so
 * the chat is no longer a window-inside-a-window, and the top "back to the
 * drawer" minimize control is removed (pointless on the dedicated page —
 * the separate bottom-right FAB drawer is the compact surface). The chat
 * claims the full content width and the viewport height below the top bar.
 *
 * v1.18.11 (W11) — ChatGPT-style IA: the page drops its own header bar
 * AND the top conversation-history strip entirely. The composer is the
 * single control hub (leading `+` actions menu = new chat + open
 * conversations, settings deep-link, mic, send); conversation history is a
 * left slide-in drawer opened from that menu. The composer keeps one
 * constant, centred, max-width-capped column across the new-chat hero and
 * the active conversation. All of that lives in `<CoachConversation>`'s
 * page branch, so the page stays a thin gating + sizing wrapper.
 *
 * v1.19.1 (C1/C5) — the Coach now DEFAULTS to the new-chat hero, reversing
 * the v1.19.0 (W7) "always resume most-recent" default the maintainer
 * disliked. Resolution order on mount:
 *   - `?c=<id>` → open that specific thread (explicit deep-link, unchanged).
 *     The dedicated conversation-history page (`/coach/conversations`, added
 *     in v1.21.4) routes back here with `?c=<id>` when a row is selected.
 *   - `?c=new` or no param → the new-chat hero.
 *   - EXCEPTION: when the Coach has proactively written an UNREAD message
 *     (`/api/insights/coach/nudge-status` → `unread`), auto-open the
 *     most-recent thread so the user lands on what the Coach said.
 * The search-param read sits in a Suspense child so the client-bailout
 * never de-opts the route.
 *
 * 2026-07-17 UX-flows audit — the route understood only `?c=` / `?doc=`, so
 * every other cross-surface hand-off (a metric card's "ask about this", the
 * Today check-in's "Adjust", a workout detail's coach button) dropped its
 * context at the URL boundary and landed on a blank composer (F1-2 / F4-1 /
 * F6-1). Two additive params close that gap, both seeding the SAME props
 * `<CoachConversation>` already exposes for the drawer's suggested-prompt
 * chips — no new plumbing inside the conversation surface itself:
 *   - `?scope=<CoachScopeSource>` — narrows the snapshot the FIRST turn of a
 *     fresh conversation reads (validated against the closed enum; an
 *     unrecognised value is silently dropped rather than reaching the chat
 *     route with a free-form string).
 *   - `?workout=<id>` — scopes a fresh chat to ONE workout (v1.31.0). The
 *     server narrows by `{ id, userId }` on the first turn only, so an unknown
 *     or foreign id resolves to nothing and the chat proceeds unscoped.
 *   - `?ask=<text>` — seeds the composer prefill (mirrors `prefill` on the
 *     in-app `askCoach()` launch call). The user still reviews/sends it —
 *     this is a prefill, not an auto-send.
 * Both are ignored once `?c=` or `?doc=` pin an existing/scoped thread — scope
 * only ever applies to a fresh conversation's first turn.
 *
 * The conversations panel on the right of the thread carries the history,
 * New chat and the settings gear (the composer's `+` menu is gone). Picking a
 * conversation or starting a new one rewrites `?c=` in place, so a reload
 * stays on the open thread. `?settings=data` (the link from Settings → Coach)
 * opens the gear on "What I can see"; the param is consumed on mount and
 * dropped from the URL so a reload does not reopen the overlay.
 */
function CoachPageBody() {
  const searchParams = useSearchParams();
  // `?c=new` is an explicit "start a fresh chat" escape hatch; any other
  // value is treated as a conversation id to open. A blank/absent param
  // defaults to the new-chat hero.
  const rawC = searchParams.get("c");
  const deepLinkedId = rawC && rawC !== "new" ? rawC : null;
  // v1.28.51 (Documents R3, Design A) — `?doc=<id>` seeds a fresh chat SCOPED
  // to a stored document (the vault detail sheet's "Ask the Coach" action). An
  // explicit `?c=<id>` thread wins over it (that thread carries its own scope).
  const rawDoc = searchParams.get("doc");
  const seedDocumentId = deepLinkedId === null && rawDoc ? rawDoc : null;
  // v1.31.0 — `?workout=<id>` seeds a fresh chat scoped to ONE workout (the
  // workout-detail "Ask why" hand-off, and the drawer's maximize target). An
  // explicit `?c=` thread wins, and a `?doc=` chat wins too: that path is the
  // hardened fenced transport, so it must never be diluted by a second scope.
  // The id is not validated here beyond its presence — the server narrows by
  // `{ id, userId }`, so an unknown or foreign id simply resolves to nothing.
  const rawWorkout = searchParams.get("workout");
  const seedWorkoutId =
    deepLinkedId === null && seedDocumentId === null && rawWorkout
      ? rawWorkout
      : null;

  // A fresh conversation only — an existing thread (`?c=`) or a doc-scoped
  // chat (`?doc=`) keeps its own established scope.
  const freshChat = deepLinkedId === null && seedDocumentId === null;
  const rawScope = freshChat ? searchParams.get("scope") : null;
  const scopeResult = rawScope
    ? coachScopeSourceSchema.safeParse(rawScope)
    : null;
  const launchScope: CoachLaunchScope | null = scopeResult?.success
    ? { metric: scopeResult.data }
    : null;
  const seedPrefill = freshChat ? searchParams.get("ask") : null;

  // Read once: the panel consumes it on mount, then the URL loses it.
  const [openSettingsOnData] = useState(
    () => searchParams.get("settings") === "data",
  );
  useEffect(() => {
    if (!openSettingsOnData) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("settings");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search,
    );
  }, [openSettingsOnData]);

  // #781 — a navigation away mid-reply recorded the interrupted conversation
  // (see `COACH_INTERRUPTED_STORAGE_KEY` in `use-coach.ts`). Returning to the
  // Coach reopens that thread — where the persisted `cancelled` marker shows
  // the turn as interrupted and offers the retry — instead of landing on a
  // blank new chat. Read once per mount (lazy state, SSR-guarded), cleared in
  // an effect so it is consumed exactly once. Every EXPLICIT entry intent
  // wins over the resume: a `?c=` thread or `?c=new`, a `?doc=`/`?workout=`
  // scoped chat, and a `?scope=`/`?ask=` hand-off all carry their own
  // destination.
  const [interruptedResume] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(COACH_INTERRUPTED_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (interruptedResume === null) return;
    try {
      window.sessionStorage.removeItem(COACH_INTERRUPTED_STORAGE_KEY);
    } catch {
      // Best-effort clear; a stale flag only re-opens a conversation once.
    }
  }, [interruptedResume]);
  const interruptedEligible =
    rawC === null &&
    rawDoc === null &&
    rawWorkout === null &&
    launchScope === null &&
    !seedPrefill;
  const interruptedId =
    interruptedEligible && interruptedResume && interruptedResume !== "latest"
      ? interruptedResume
      : null;
  // A first-turn abort never learned its conversation id (it rides the SSE
  // `done` frame) — resolve via the server-authoritative most-recent thread,
  // which the aborted turn's server-side persistence has just bumped to the top.
  const resumeInterruptedLatest =
    interruptedEligible && interruptedResume === "latest";

  // C1 exception — an unread coach-initiated message opens the most-recent
  // conversation (which holds that proactive turn). Only consulted when the
  // entry did not pin a specific thread or ask for a fresh chat.
  // A `?doc=` open is an explicit fresh doc-scoped chat — never override it by
  // resuming the most-recent thread on an unread nudge. A `?scope=`/`?ask=`
  // hand-off is likewise an explicit fresh-chat request.
  const exceptionEligible =
    deepLinkedId === null &&
    rawC !== "new" &&
    seedDocumentId === null &&
    seedWorkoutId === null &&
    launchScope === null &&
    !seedPrefill;
  const { data: nudge } = useQuery({
    queryKey: queryKeys.coachNudgeStatus(),
    queryFn: async (): Promise<CoachNudgeStatus> =>
      apiGet<CoachNudgeStatus>("/api/insights/coach/nudge-status"),
    enabled: exceptionEligible,
    staleTime: 5 * 60 * 1000,
  });
  const hasUnreadCoachMessage = exceptionEligible && nudge?.unread === true;

  return (
    <CoachConversation
      surface="page"
      autoFocusComposer
      // #781 — the interrupted-conversation resume seeds the same prop the
      // `?c=` deep-link drives; the explicit deep-link always wins.
      initialConversationId={deepLinkedId ?? interruptedId}
      // v1.28.51 — seed the document scope for a `?doc=<id>` open so the first
      // turn is created + sent through the hardened fenced document endpoint.
      initialDocumentId={seedDocumentId}
      initialWorkoutId={seedWorkoutId}
      // 2026-07-17 UX-flows audit F1-2/F4-1/F6-1 — seed the scope/prefill a
      // cross-surface hand-off carried in the URL.
      launchScope={launchScope}
      prefill={seedPrefill}
      // Default is the new-chat hero; resume most-recent only for the
      // unread coach-initiated exception and the interrupted first-turn
      // resume (#781, whose conversation id never reached the client).
      autoOpenMostRecent={hasUnreadCoachMessage || resumeInterruptedLatest}
      openSettingsOnData={openSettingsOnData}
    />
  );
}

export default function CoachPageClient() {
  const router = useRouter();
  const launch = useCoachLaunch();
  // The `coach` capability on `/api/auth/me` is the one answer every Coach
  // entry point reads. `null` until `/me` has answered, so a direct visit is
  // never sent away on the loading frame.
  const coach = useAiCapabilityAnswer("coach");
  const { user, isLoading } = useAuth();
  const { inSharedRecord } = useRecordCapabilities();

  const coachUnavailable = coach === null || !coach.available;

  // With the Coach unavailable for any reason (operator switch, Hide Coach,
  // no provider, missing consent) a direct navigator goes back to the
  // Insights overview, so the route is never a dead end. Stored
  // conversations stay reachable under /coach/conversations.
  const canRenderOwnCoach = user !== null && !isLoading && !inSharedRecord;

  useEffect(() => {
    if (canRenderOwnCoach && coach !== null && !coach.available) {
      router.replace("/insights");
    }
  }, [canRenderOwnCoach, coach, router]);

  // Reopening the bottom-right FAB drawer is no longer wired to a page
  // control, but keep the launch context referenced so the lint rule does
  // not flag the unused hook — the drawer the page hands back to lives in
  // the shared `<AuthShell>`.
  void launch;

  if (!canRenderOwnCoach || coachUnavailable) return null;

  return (
    <div
      data-slot="coach-page"
      data-tour-id="coach-hero"
      // Full-bleed conversation surface. The shell renders `/coach` without
      // its centred container, padding or reserved scrollbar gutter, and its
      // `<main>` already clears the top bar and, on phones, the bottom nav,
      // so the page simply fills what is left. No inner card: the
      // conversation paints directly onto the page.
      className="bg-background flex min-h-[32rem] flex-1 flex-col overflow-hidden"
    >
      {/* `useSearchParams` requires a Suspense boundary so the client-search
          bailout never opts the whole route out of static optimisation. */}
      <Suspense fallback={null}>
        <CoachPageBody />
      </Suspense>
    </div>
  );
}
