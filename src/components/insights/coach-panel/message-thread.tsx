"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { scrollBehaviorForUser } from "@/lib/motion";
import { useTranslations } from "@/lib/i18n/context";

import { ChatBubble, type FollowUpOffer, type ReplyOffer } from "./chat-bubble";
import type { SuggestedReply } from "./suggested-replies";
import { CoachMessageDatesProvider } from "./coach-results";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";
import { openAtEnd } from "./open-at-end";
import { focusCoachComposer } from "./composer-focus";
import {
  EMPTY_LIVE_TURN_KEYS,
  messageRenderKey,
  nextLiveTurnKeys,
  type LiveTurnKeys,
} from "./live-turn-keys";
import type {
  CoachConversationDetailDTO,
  CoachOptimisticUserMessage,
  CoachStreamingMessage,
} from "./use-coach";
import type {
  CoachClarification,
  CoachClarificationChoice,
  CoachFollowUp,
  CoachMessageDTO,
} from "@/lib/ai/coach/types";
import {
  COACH_MEMORY_KEYS,
  COACH_PLAN_KEYS,
} from "@/lib/ai/coach/memory/shared";

// v1.28.26 file-size split (pure code motion): the bubble renderer +
// per-message actions live in `chat-bubble.tsx`, the read-aloud stack in
// `read-aloud.tsx`. The previously public names re-export from here so
// external call sites are unchanged.
export {
  TypingDots,
  errorCodeToI18nKey,
  selectCoachChartTokens,
} from "./chat-bubble";

/**
 * v1.4.20 phase B2b — message-thread renderer.
 *
 * Mounted inside the centre column of the Coach drawer. Renders the
 * persisted message history (decrypted server-side and delivered as
 * `CoachMessageDTO[]`) + an optional in-flight assistant bubble fed
 * by the streaming hook.
 *
 * Auto-scroll behaviour: scrolls to the bottom whenever the message
 * list grows OR the streaming-content length changes. The user can
 * scroll up to read history; we suppress auto-scroll until the next
 * "new message" tick if they're not already pinned to the bottom.
 * Away from the end, a round button fades in over the thread's foot and
 * brings the reader back (`ScrollToBottomButton`); a reply streaming in
 * meanwhile never pulls the view down by itself.
 *
 * Visual identity: user bubbles right-aligned, Dracula purple accent;
 * assistant bubbles left-aligned with the gradient sparkle avatar
 * from the artboard.
 */
export interface MessageThreadProps {
  conversation: CoachConversationDetailDTO | null;
  /** Optional in-flight bubble from `useSendCoachMessage()`. */
  streaming?: CoachStreamingMessage;
  /**
   * v1.4.25 W5 — optimistic user message surfaced by the send hook so
   * the user sees their own bubble before the "Thinking…" placeholder.
   * Cleared by the hook once the SSE `done` frame fires (the persisted
   * twin lands via the invalidate-refetch). When the persisted twin is
   * already in `conversation.messages` we suppress the optimistic copy
   * so the user never sees the same bubble twice.
   */
  optimisticUser?: CoachOptimisticUserMessage | null;
  /** Empty-state copy when no conversation is loaded yet. */
  emptyHint?: string;
  /**
   * v1.16.5 — locally-rendered bubbles the guided clarifying-questions
   * flow interleaves with the persisted history (deterministic Coach
   * questions + the closing summary). Items anchored on an answer
   * render immediately before the user message that answered them;
   * unanchored items render at the thread tail. See `placeInterleaved`.
   */
  interleaved?: InterleavedThreadItem[];
  /**
   * v1.22 — "Try again" on an assistant turn. The thread resolves the user
   * message that produced the reply and hands its text up; the surface
   * resubmits it as a fresh turn. Omitted → the regenerate action is hidden.
   */
  onRegenerate?: (userText: string) => void;
  /**
   * v1.39.4 — a follow-up chip was tapped. Omitted → no chips are shown.
   */
  onFollowUp?: (followUp: CoachFollowUp, messageId: string) => void;
  /**
   * v1.41 — a reply pill was tapped: a clarifying question's choice, or an
   * answer to a fact or plan proposal. Omitted → those pills are not shown.
   */
  onReply?: (intent: CoachReplyIntent) => void;
}

/** v1.41 — what a tapped reply pill answers, and how. */
export type CoachReplyIntent =
  | {
      kind: "clarification";
      messageId: string;
      choice: CoachClarificationChoice;
      label: string;
    }
  | {
      kind: "memory";
      messageId: string;
      proposalId: string;
      accept: boolean;
      label: string;
    }
  | {
      kind: "plan";
      messageId: string;
      planId: string;
      accept: boolean;
      label: string;
    };

/**
 * v1.41 — the decision the latest answer waits for, if any: a clarifying
 * question's choices, a fact proposal or a plan proposal. Like the chips, only
 * the latest assistant turn offers one, and none while a turn is in flight.
 */
export interface LatestDecision {
  messageId: string;
  clarification: CoachClarification | null;
  memoryProposalId: string | null;
  planId: string | null;
}

export function latestDecision(
  messages: CoachMessageDTO[],
  streaming: CoachStreamingMessage | undefined,
): LatestDecision | null {
  if (streaming?.inProgress) return null;
  let found: LatestDecision | null = null;
  if (streaming?.messageId) {
    const persisted = messages.find((m) => m.id === streaming.messageId);
    const note = streaming.memoryNote ?? persisted?.metricSource?.memoryNote;
    const plan =
      streaming.planProposal ?? persisted?.metricSource?.planProposal;
    found = {
      messageId: streaming.messageId,
      clarification:
        streaming.clarification ??
        persisted?.metricSource?.clarification ??
        null,
      memoryProposalId:
        note?.proposal && note.proposalId ? note.proposalId : null,
      planId: plan?.planId ?? null,
    };
    const last = messages[messages.length - 1];
    // The streamed turn is the latest only until something follows it.
    if (persisted && last && last.id !== streaming.messageId) found = null;
  } else {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      const note = last.metricSource?.memoryNote;
      found = {
        messageId: last.id,
        clarification: last.metricSource?.clarification ?? null,
        memoryProposalId:
          note?.proposal && note.proposalId ? note.proposalId : null,
        planId: last.metricSource?.planProposal?.planId ?? null,
      };
    }
  }
  if (
    !found ||
    (!found.clarification && !found.memoryProposalId && !found.planId)
  ) {
    return null;
  }
  return found;
}

/**
 * The pills of a decision, in the order they are offered: a question's
 * choices with the assumed one first, then a fact proposal's two answers,
 * then a plan proposal's. Labels in the reader's language.
 */
export function decisionReplies(
  decision: LatestDecision,
  t: (key: string) => string,
  onReply: (intent: CoachReplyIntent) => void,
): SuggestedReply[] {
  const { messageId } = decision;
  const out: SuggestedReply[] = [];
  const choices = decision.clarification?.choices ?? [];
  const assumed = decision.clarification?.assumption;
  const ordered = assumed
    ? [
        ...choices.filter((c) => c.id === assumed),
        ...choices.filter((c) => c.id !== assumed),
      ]
    : choices;
  for (const choice of ordered.slice(0, 4)) {
    const local = t(choice.labelKey);
    const label = local === choice.labelKey ? choice.label : local;
    out.push({
      id: `clarify-${choice.id}`,
      label,
      kind: "clarification",
      data: { "data-choice-id": choice.id },
      onSelect: () =>
        onReply({ kind: "clarification", messageId, choice, label }),
    });
  }
  const proposalId = decision.memoryProposalId;
  if (proposalId) {
    for (const accept of [true, false]) {
      const label = t(
        accept ? COACH_MEMORY_KEYS.accept : COACH_MEMORY_KEYS.decline,
      );
      out.push({
        id: `memory-${accept ? "accept" : "decline"}`,
        label,
        kind: "memory",
        data: { "data-decision": accept ? "accept" : "decline" },
        onSelect: () =>
          onReply({ kind: "memory", messageId, proposalId, accept, label }),
      });
    }
  }
  const planId = decision.planId;
  if (planId) {
    for (const accept of [true, false]) {
      const label = t(
        accept ? COACH_PLAN_KEYS.accept : COACH_PLAN_KEYS.decline,
      );
      out.push({
        id: `plan-${accept ? "accept" : "decline"}`,
        label,
        kind: "plan",
        data: { "data-decision": accept ? "accept" : "decline" },
        onSelect: () =>
          onReply({ kind: "plan", messageId, planId, accept, label }),
      });
    }
  }
  return out;
}

/**
 * v1.39.4 — the open clarifying question: the latest assistant turn's
 * choices, whether it is the just-settled streamed turn or the last
 * persisted message. None while a turn is in flight, and none once the
 * person has answered (their message is then the last one).
 */
export function latestClarification(
  messages: CoachMessageDTO[],
  streaming: CoachStreamingMessage | undefined,
): { messageId: string; clarification: CoachClarification } | null {
  if (streaming?.inProgress) return null;
  if (streaming?.messageId && streaming.clarification) {
    return {
      messageId: streaming.messageId,
      clarification: streaming.clarification,
    };
  }
  const last = messages[messages.length - 1];
  if (streaming?.messageId && streaming.messageId !== last?.id) return null;
  if (last?.role !== "assistant") return null;
  const clarification = last.metricSource?.clarification;
  return clarification ? { messageId: last.id, clarification } : null;
}

/**
 * v1.39.4 — the chips to offer, and the message that offered them: the
 * latest assistant turn only, whether it is the just-settled streamed turn
 * or the last persisted message. None while a turn is in flight.
 */
export function latestFollowUps(
  messages: CoachMessageDTO[],
  streaming: CoachStreamingMessage | undefined,
): { messageId: string; followUps: CoachFollowUp[] } | null {
  if (streaming?.inProgress) return null;
  if (streaming?.messageId && streaming.followUps.length > 0) {
    return { messageId: streaming.messageId, followUps: streaming.followUps };
  }
  const last = messages[messages.length - 1];
  if (streaming?.messageId && streaming.messageId !== last?.id) return null;
  if (last?.role !== "assistant") return null;
  const followUps = last.metricSource?.followUps ?? [];
  return followUps.length > 0 ? { messageId: last.id, followUps } : null;
}

/**
 * v1.16.5 — one locally-rendered thread bubble contributed by the
 * guided clarifying-questions flow. The thread owns only the placement;
 * the node's behaviour lives with the flow in `coach-conversation`.
 */
export interface InterleavedThreadItem {
  key: string;
  /**
   * Content of the user message this item precedes (a guided question
   * renders above its answer). `null` → render at the thread tail
   * (the current question / the summary).
   */
  anchorAnswer: string | null;
  node: React.ReactNode;
}

/**
 * Pure placement for interleaved items, exported for unit tests.
 * Items are chronological by construction (the guided flow emits them
 * in question order), so a single forward pointer suffices: each
 * anchored item consumes the first remaining user message whose
 * content equals its anchor. Anchors that never match (e.g. an errored
 * turn whose message was never persisted) fall through to the tail so
 * no bubble is ever silently dropped.
 */
export function placeInterleaved(
  items: InterleavedThreadItem[],
  messages: { id: string; role: string; content: string }[],
  optimisticContent: string | null,
): {
  before: Map<string, InterleavedThreadItem>;
  beforeOptimistic: InterleavedThreadItem[];
  tail: InterleavedThreadItem[];
} {
  const anchored = items.filter((i) => i.anchorAnswer !== null);
  const before = new Map<string, InterleavedThreadItem>();
  let p = 0;
  for (const m of messages) {
    if (p >= anchored.length) break;
    if (m.role === "user" && m.content === anchored[p].anchorAnswer) {
      before.set(m.id, anchored[p]);
      p += 1;
    }
  }
  const beforeOptimistic: InterleavedThreadItem[] = [];
  if (
    p < anchored.length &&
    optimisticContent !== null &&
    optimisticContent === anchored[p].anchorAnswer
  ) {
    beforeOptimistic.push(anchored[p]);
    p += 1;
  }
  const tail = [
    ...anchored.slice(p),
    ...items.filter((i) => i.anchorAnswer === null),
  ];
  return { before, beforeOptimistic, tail };
}

/**
 * The wrapper every assistant turn renders in, streaming or persisted, so a
 * turn keeps one element through the swap. While it streams it is the live
 * region: role=log + aria-live=polite so screen-reader users hear the prose
 * as tokens land (aria-relevant=text limits announcements to the streamed
 * content; additions covers the bubble-mount edge case), with a soft
 * fade/slide-in so the hand-off from the thinking beat reads as one motion.
 */
function AssistantTurn({
  turnKey,
  live,
  children,
}: {
  turnKey: string;
  live: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="coach-assistant-turn"
      data-turn-key={turnKey}
      {...(live
        ? {
            role: "log",
            "aria-live": "polite" as const,
            "aria-relevant": "additions text" as const,
            className:
              "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
          }
        : {})}
    >
      {children}
    </div>
  );
}

function isPinnedToBottom(el: HTMLElement, slack = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function MessageThread({
  conversation,
  streaming,
  optimisticUser,
  emptyHint,
  interleaved,
  onRegenerate,
  onFollowUp,
  onReply,
}: MessageThreadProps) {
  const { t } = useTranslations();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasPinnedRef = useRef(true);
  // The same pinned state as a render value, for the jump-to-latest button.
  // The ref stays the source for the auto-scroll (it must not wait for a
  // render); the state follows it at most once per frame.
  const [pinned, setPinned] = useState(true);

  const messages: CoachMessageDTO[] = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages],
  );
  // v1.39.4 — when each message was written, so a table copied from an
  // earlier answer can name that answer's date.
  const messageDates = useMemo(
    () => new Map(messages.map((m) => [m.id, m.createdAt])),
    [messages],
  );
  // v1.16.5 — locally-rendered guided bubbles (see `placeInterleaved`).
  const interleavedItems = interleaved ?? [];
  // v1.39.4 — one key per turn from its first streamed frame to its
  // persisted copy (`live-turn-keys.ts`). The persisted twin renders under
  // the key the turn streamed under, in the same place and wrapper, so React
  // keeps the one bubble and the reader's state in it. The streaming copy
  // steps aside the moment the twin is in the history; with a shared key the
  // two never render side by side.
  // Derived from the previous render's keys (React's "store information
  // from previous renders" pattern): the update is idempotent, so it settles
  // after one extra render and never loops.
  const [storedLiveKeys, setLiveKeys] =
    useState<LiveTurnKeys>(EMPTY_LIVE_TURN_KEYS);
  const liveKeys = nextLiveTurnKeys(storedLiveKeys, streaming);
  if (liveKeys !== storedLiveKeys) setLiveKeys(liveKeys);

  const streamingPersisted =
    streaming?.messageId != null &&
    messages.some((m) => m.id === streaming.messageId);
  const streamingActive =
    !streamingPersisted &&
    (!!streaming?.inProgress || !!streaming?.content || !!streaming?.errorCode);

  // v1.4.25 W5 — render the optimistic user bubble only when the
  // persisted twin hasn't landed yet. We match on (role=user, content
  // equality, no later persisted user message). The server is the
  // source of truth — once the persisted user message lands (via the
  // invalidate-refetch the SSE `done` frame triggers), the optimistic
  // copy is dropped so the user never sees their bubble twice.
  const optimisticActive = (() => {
    if (!optimisticUser) return false;
    // Suppress if the persisted history already contains the same
    // user content as the last user message — the twin has landed.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.content === optimisticUser.content) return false;
    return true;
  })();

  // v1.16.5 — slot the guided bubbles around the persisted history,
  // the optimistic user bubble, and the streaming tail. Cheap on every
  // render: at most a handful of items over a single message walk.
  const placement = placeInterleaved(
    interleavedItems,
    messages,
    optimisticActive && optimisticUser ? optimisticUser.content : null,
  );

  // The chips go to the bubble of the message that offered them, so they
  // sit in that answer's column. One object per offer, so the memoised
  // bubble sees the same value until the offer itself changes.
  const latest = latestFollowUps(messages, streaming);
  const chipsMessageId = latest?.messageId ?? null;
  const chipsArray = latest?.followUps ?? null;
  const chips: FollowUpOffer | null = useMemo(
    () =>
      chipsMessageId && chipsArray
        ? { messageId: chipsMessageId, followUps: chipsArray }
        : null,
    [chipsMessageId, chipsArray],
  );
  // v1.41 — a decision the latest answer waits for replaces its chips with
  // the decision's own pills. There is none while a turn streams, so the
  // fresh array per render never re-renders a bubble per token.
  const decision = onReply ? latestDecision(messages, streaming) : null;
  const replyOffer: ReplyOffer | null =
    decision && onReply
      ? {
          messageId: decision.messageId,
          replies: decisionReplies(decision, t, onReply),
        }
      : null;
  const chipsFor = (messageId: string | null | undefined) => ({
    ...(onFollowUp && chips && messageId === chips.messageId
      ? {
          followUps: chips,
          followUpsDisabled: !!streaming?.inProgress,
          onFollowUp,
        }
      : {}),
    ...(replyOffer && messageId === replyOffer.messageId
      ? {
          replies: replyOffer,
          followUpsDisabled: !!streaming?.inProgress,
        }
      : {}),
  });

  const hasThread =
    messages.length > 0 ||
    streamingActive ||
    optimisticActive ||
    interleavedItems.length > 0;

  // Track scroll position so we don't yank the viewport when the user
  // is browsing earlier turns. Re-attached when the thread mounts (the
  // empty state renders no scroller).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      wasPinnedRef.current = isPinnedToBottom(el);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setPinned(isPinnedToBottom(el));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [hasThread]);

  const scrollToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Focus first: pinning hides this button (aria-hidden), and focus must
    // not sit on a control that has left the accessibility tree.
    focusCoachComposer();
    wasPinnedRef.current = true;
    setPinned(true);
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehaviorForUser() });
  }, []);

  // Opening a saved conversation lands on its last answer, and stays there
  // while the answers' charts and tables finish loading (see `open-at-end`).
  // Keyed on the conversation, so switching to another one re-opens at its
  // end even when both have the same number of messages; a layout effect, so
  // the first painted frame is already the end rather than the top.
  const conversationId = conversation?.id ?? null;
  const hasMessages = messages.length > 0;
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !conversationId || !hasMessages) return;
    wasPinnedRef.current = true;
    setPinned(true);
    return openAtEnd(el);
  }, [conversationId, hasMessages]);

  // Auto-scroll on new messages OR streaming-content growth, but only
  // when the user was already at the bottom. v1.4.25 W5 — the
  // optimistic user bubble counts as a new message; scroll on its
  // localId so the user sees their own bubble land at the bottom.
  // v1.16.5 — guided bubbles count as new messages for the auto-scroll.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (wasPinnedRef.current) {
      // v1.4.43 W5-H5 — respect `prefers-reduced-motion`.
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehaviorForUser() });
    }
  }, [
    messages.length,
    streaming?.content,
    optimisticUser?.localId,
    interleavedItems.length,
  ]);

  // v1.4.27 R3d MB4 / CF-74 — re-pin to the bottom when the
  // visual viewport shrinks (typically the soft keyboard opening on
  // a phone). Without this the last bubble drifts behind the keyboard
  // because the scroller's `scrollHeight` references the layout
  // viewport, not the visible region. Listening on
  // `window.visualViewport.resize` and re-issuing the scroll keeps the
  // tail of the thread visible as the keyboard slides in and out.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      const el = scrollerRef.current;
      if (!el) return;
      if (wasPinnedRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      }
    };
    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, []);

  if (!hasThread) {
    return (
      <div
        data-slot="coach-message-thread"
        role="status"
        aria-live="polite"
        className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <div
          aria-hidden="true"
          className="from-primary to-brand-pink flex size-12 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <Sparkles className="text-background size-5" />
        </div>
        <p className="max-w-sm text-sm leading-relaxed">
          {emptyHint ?? t("insights.coach.threadEmpty")}
        </p>
      </div>
    );
  }

  return (
    <CoachMessageDatesProvider dates={messageDates}>
      {/* The positioning frame for the jump-to-latest button. It takes the
          thread's place in the flex column; the scroller inside stays the
          one scroll container. */}
      <div
        data-slot="coach-message-thread-frame"
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={scrollerRef}
          data-slot="coach-message-thread"
          className={cn(
            // v1.18.6.1 — `min-h-0 flex-1` (not `h-full`) so the scroll region
            // resolves its height from the flex parent rather than a 100%-of-auto
            // chain that let the thread grow instead of scroll.
            // v1.18.7 — calmer vertical rhythm (gap-6) and more generous top/
            // bottom breathing room so the conversation reads like a document,
            // not a chat log packed against the chrome.
            "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6",
            // v1.18.6 (CCH-01) / v1.18.7 — on the wide page surface an edge-to-
            // edge thread sprawled the prose past a readable measure. Centre the
            // content on a narrower, calmer Claude/ChatGPT-like column
            // (`max-w-2xl`) via an `mx-auto` inner gutter; the scrollbar still
            // rides the surface edge. The drawer surface is already narrow, so
            // the cap only bites on the wide page surface.
            "[&>*]:mx-auto [&>*]:w-full [&>*]:max-w-2xl",
            "scroll-smooth",
          )}
        >
          {[
            ...messages.map((m, idx) => {
              // v1.16.5 — a guided question renders directly above the user
              // message that answered it.
              const guidedBefore = placement.before.get(m.id);
              // v1.22 — "Try again": resolve the user message that produced this
              // assistant reply (the nearest preceding user turn) so the surface
              // can resubmit it. Null when there is none → no regenerate action.
              let precedingUserContent: string | null = null;
              // v1.41 — a reply to a memory or plan tap is answered without a
              // model (`decision`); there is nothing to try again.
              if (
                m.role === "assistant" &&
                onRegenerate &&
                m.providerType !== "decision"
              ) {
                for (let j = idx - 1; j >= 0; j--) {
                  if (messages[j].role === "user") {
                    precedingUserContent = messages[j].content;
                    break;
                  }
                }
              }
              const bubble = (
                <ChatBubble
                  role={m.role}
                  content={m.content}
                  metricSource={m.metricSource}
                  conversationId={conversation?.id ?? null}
                  providerType={m.providerType}
                  messageId={m.id}
                  tokensUsed={m.tokensUsed}
                  model={m.model}
                  createdAt={m.createdAt}
                  // The turn that just streamed keeps its live tables, so the
                  // swap to the persisted copy does not refetch and remount them.
                  {...(m.id === streaming?.messageId &&
                  streaming.results.length > 0
                    ? { results: streaming.results }
                    : {})}
                  // v1.41 — and its live trail (with the titles and texts
                  // the persisted copy only has behind `…/trail`) and the
                  // words of the fact it kept.
                  {...(m.id === streaming?.messageId
                    ? {
                        ...(streaming.activity.length > 0
                          ? { activity: streaming.activity }
                          : {}),
                        memoryNote: streaming.memoryNote,
                      }
                    : {})}
                  {...(m.role === "assistant" ? chipsFor(m.id) : {})}
                  onRegenerate={
                    precedingUserContent !== null && onRegenerate
                      ? () => onRegenerate(precedingUserContent as string)
                      : undefined
                  }
                />
              );
              const key = messageRenderKey(liveKeys, m.id);
              return (
                <Fragment key={key}>
                  {guidedBefore?.node}
                  {m.role === "assistant" ? (
                    <AssistantTurn turnKey={key} live={false}>
                      {bubble}
                    </AssistantTurn>
                  ) : (
                    bubble
                  )}
                </Fragment>
              );
            }),
            // v1.16.5 — guided question whose answer is still optimistic-only.
            ...placement.beforeOptimistic.map((i) => (
              <Fragment key={i.key}>{i.node}</Fragment>
            )),
            // v1.4.25 W5 — the optimistic user bubble sits between the
            // persisted history and the streaming assistant placeholder, so
            // the visible order matches the person's mental model. The send
            // hook drops it once the persisted twin lands.
            optimisticActive && optimisticUser ? (
              <ChatBubble
                key={optimisticUser.localId}
                role="user"
                content={optimisticUser.content}
              />
            ) : null,
            streamingActive && streaming ? (
              // Same key, fragment and wrapper as its persisted copy above.
              <Fragment key={liveKeys.current ?? "coach-turn-live"}>
                {null}
                <AssistantTurn
                  turnKey={liveKeys.current ?? "coach-turn-live"}
                  live
                >
                  <ChatBubble
                    role="assistant"
                    content={streaming.content}
                    metricSource={streaming.metricSource}
                    suggestion={streaming.suggestion}
                    suggestedAction={streaming.suggestedAction}
                    steps={streaming.steps}
                    results={streaming.results}
                    activity={streaming.activity}
                    memoryNote={streaming.memoryNote}
                    providerType={streaming.inProgress ? "streaming" : null}
                    inProgress={streaming.inProgress}
                    errorCode={streaming.errorCode}
                    // v1.18.9 — live word-fade + the just-landed token footer.
                    streaming
                    usage={streaming.usage}
                    {...chipsFor(streaming.messageId)}
                  />
                </AssistantTurn>
              </Fragment>
            ) : null,
          ]}
          {/* v1.16.5 — thread tail: the current guided question and/or the
          closing summary follow the last completed turn. */}
          {placement.tail.map((i) => (
            <Fragment key={i.key}>{i.node}</Fragment>
          ))}
        </div>
        <ScrollToBottomButton visible={!pinned} onClick={scrollToLatest} />
      </div>
    </CoachMessageDatesProvider>
  );
}
