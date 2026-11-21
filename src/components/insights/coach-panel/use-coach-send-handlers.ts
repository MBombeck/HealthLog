"use client";

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { QueryClient, UseMutationResult } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import type { CoachFollowUp, CoachScope } from "@/lib/ai/coach/types";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";

import type { GuidedEvent, GuidedState } from "./guided-questions-machine";
import type { CoachReplyIntent, latestClarification } from "./message-thread";
import type { useSendCoachMessage } from "./use-coach";

/**
 * Collapse a UI launch scope ({ metric, also, window }) into the chat route's
 * wire scope ({ sources, window }). Returns undefined when there is nothing to
 * narrow, so the request falls back to the route's default all-source
 * snapshot. Exported for the unit test that pins the source-dedup + window
 * contract.
 */
export function launchScopeToCoachScope(
  launchScope: CoachLaunchScope | null | undefined,
): CoachScope | undefined {
  if (!launchScope?.metric) return undefined;
  const sources = Array.from(
    new Set([launchScope.metric, ...(launchScope.also ?? [])]),
  );
  return {
    sources,
    ...(launchScope.window ? { window: launchScope.window } : {}),
  };
}

/** The request field that says which offer a reply pill answers. */
function replyIntentFields(intent: CoachReplyIntent) {
  return intent.kind === "clarification"
    ? {
        clarification: {
          messageId: intent.messageId,
          choiceId: intent.choice.id,
        },
      }
    : intent.kind === "memory"
      ? {
          memoryDecision: {
            messageId: intent.messageId,
            proposalId: intent.proposalId,
            accept: intent.accept,
          },
        }
      : {
          planDecision: {
            messageId: intent.messageId,
            planId: intent.planId,
            accept: intent.accept,
          },
        };
}

export interface PendingAdopt {
  question: string;
  answer: string;
  guidedIndex: number;
}

export interface CoachSendHandlersInput {
  send: ReturnType<typeof useSendCoachMessage>;
  currentConversationId: string | null;
  fenced: boolean;
  anyPendingUnindexed: boolean;
  openClarification: ReturnType<typeof latestClarification>;
  guided: GuidedState;
  dispatchGuided: Dispatch<GuidedEvent>;
  dismissQuestions: UseMutationResult<
    { questions: string[] },
    Error,
    string | undefined
  >;
  setInputValue: (value: string) => void;
  setPendingAdopt: Dispatch<SetStateAction<PendingAdopt | null>>;
  pendingAttachmentIds: string[];
  setPendingAttachmentIds: Dispatch<SetStateAction<string[]>>;
  launchScope: CoachLaunchScope | null | undefined;
  activeWorkoutId: string | null;
  queryClient: QueryClient;
  autoSend: boolean | undefined;
  prefill: string | null | undefined;
}

/**
 * The turn-sending handlers of the Coach conversation: the composer submit,
 * a follow-up chip, a reply pill, "Try again", and the one-shot auto-send of
 * a launch prefill. The state they read and write stays owned by
 * `CoachConversation`; this hook only holds the behaviour.
 */
export function useCoachSendHandlers(input: CoachSendHandlersInput) {
  const {
    send,
    currentConversationId,
    fenced,
    anyPendingUnindexed,
    openClarification,
    guided,
    dispatchGuided,
    dismissQuestions,
    setInputValue,
    setPendingAdopt,
    pendingAttachmentIds,
    setPendingAttachmentIds,
    launchScope,
    activeWorkoutId,
    queryClient,
    autoSend,
    prefill,
  } = input;

  // A follow-up chip: its label is the message, and the server resolves what
  // it asks for from the message that offered it.
  function handleFollowUp(followUp: CoachFollowUp, messageId: string) {
    if (send.isStreaming || fenced || currentConversationId === null) return;
    void send.send({
      conversationId: currentConversationId,
      message: followUp.label,
      followUp: { messageId, id: followUp.id },
    });
  }

  // A reply pill under the latest answer: a clarifying question's choice, or
  // an answer to a fact or plan proposal. Its label goes out as the person's
  // own message; the request says which offer it answers, and the server
  // resolves the rest from what it stored on that message.
  function handleReply(intent: CoachReplyIntent) {
    if (send.isStreaming || fenced || currentConversationId === null) return;
    const sent = send.send({
      conversationId: currentConversationId,
      message: intent.label,
      ...replyIntentFields(intent),
    });
    // A decision changes what the Coach remembers or which plans run; the
    // lists elsewhere read it fresh once the turn is through.
    if (intent.kind !== "clarification") {
      void sent.then(() =>
        queryClient.invalidateQueries({
          queryKey:
            intent.kind === "memory"
              ? queryKeys.coachFacts()
              : queryKeys.coachPlansAll(),
        }),
      );
    }
  }

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || send.isStreaming) return;
    // A fenced turn cannot go out while a staged attachment is still being
    // indexed: the fenced endpoint 422s on an un-indexed document, so mirror
    // that gate client-side (the composer shows the "still indexing" hint).
    // The server edge is the real wall; this is the honest UI mirror.
    if (fenced && anyPendingUnindexed) return;
    // In the guided flow the composer message IS the answer to the current
    // question. Mark it answered before the send so the question bubble
    // anchors above the user's message, and dismiss the question server-side
    // — answered questions never return.
    const guidedQuestion =
      guided.phase === "asking" ? guided.questions[guided.index] : null;
    const guidedIndex = guided.phase === "asking" ? guided.index : null;
    if (guidedQuestion !== null) {
      dispatchGuided({ type: "ANSWER_SUBMITTED", answer: trimmed });
      dismissQuestions.mutate(guidedQuestion);
    }
    setInputValue("");
    // Attach the launch scope to the FIRST turn of a fresh conversation so a
    // chat opened from a metric surface / insight card reads a snapshot
    // narrowed to the relevant source(s). A continued thread (existing id)
    // keeps its own established scope, so we omit it.
    const scope =
      currentConversationId === null
        ? launchScopeToCoachScope(launchScope)
        : undefined;
    // Hand the question to the turn so the Coach reaction is contextual (the
    // question bubble itself is never persisted).
    // `fenced` + `pendingAttachmentIds` route a fenced turn through the
    // hardened `/api/insights/chat/fenced` endpoint (see
    // `resolveCoachSendTarget`); the tool-mode fields (`scope`,
    // `guidedQuestion`) are suppressed on a fenced turn — that endpoint has no
    // snapshot and no guided flow. `pendingAttachmentIds` travels ONLY on a
    // brand-new conversation (first-turn attach).
    // Same first-turn gate as `scope` — see `initialWorkoutId`.
    const workoutId =
      currentConversationId === null
        ? (activeWorkoutId ?? undefined)
        : undefined;
    const wasFreshFenced = currentConversationId === null && fenced;
    const resolvedId = await send.send({
      conversationId: currentConversationId ?? undefined,
      message: trimmed,
      guidedQuestion: fenced ? undefined : (guidedQuestion ?? undefined),
      scope: fenced ? undefined : scope,
      workoutId: fenced ? undefined : workoutId,
      // A typed message answers an open clarifying question.
      clarification: openClarification
        ? { messageId: openClarification.messageId }
        : undefined,
      fenced,
      pendingAttachmentIds:
        currentConversationId === null ? pendingAttachmentIds : undefined,
    });
    // A fresh fenced chat's first turn created the conversation server-side and
    // persisted the attachments; the server now owns them via the conversation
    // detail, so drop the local staging set to avoid duplicate "indexing" pills.
    if (wasFreshFenced && resolvedId) {
      setPendingAttachmentIds([]);
    }
    if (guidedQuestion !== null && guidedIndex !== null) {
      setPendingAdopt({
        question: guidedQuestion,
        answer: trimmed,
        guidedIndex,
      });
      // Sequence per answer: answer → Coach reaction (streamed above) →
      // adopt offer → next question. A resolved id means the reaction
      // landed; the machine then advances when the adopt offer settles
      // (ADOPTION_SETTLED). A null id is the provider-less / errored turn —
      // no reaction is coming, so keep the original silent flow and advance
      // immediately.
      if (resolvedId === null) {
        dispatchGuided({ type: "TURN_COMPLETE" });
      }
    }
  }

  // Auto-send the prefill as the conversation's first turn, exactly once.
  // A card hand-off (e.g. the assessment "ask about this") opens the Coach
  // with `autoSend` so the answer lands without a manual send. Ref-guarded so
  // it fires a single time per mount; only for a fresh conversation with a
  // non-empty prefill and no stream in flight.
  const autoSentRef = useRef(false);
  // Latest-handler ref so the auto-send effect never lists `handleSubmit` (it
  // re-creates each render) and never calls it synchronously in the effect
  // body — the dispatch is deferred to a microtask so the composer state it
  // touches settles outside the effect.
  const handleSubmitRef = useRef(handleSubmit);
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  });
  useEffect(() => {
    if (!autoSend) return;
    if (autoSentRef.current) return;
    if (currentConversationId !== null) return;
    if (send.isStreaming) return;
    const seed = (prefill ?? "").trim();
    if (!seed) return;
    autoSentRef.current = true;
    queueMicrotask(() => {
      void handleSubmitRef.current(seed);
    });
  }, [autoSend, prefill, currentConversationId, send.isStreaming]);

  // "Try again": regenerate an assistant reply by resubmitting the user turn
  // that produced it as a FRESH turn. The composer value is left untouched
  // (unlike `handleSubmit`, which clears it) so a half-typed follow-up
  // survives a regenerate. The existing thread is the conversation context,
  // so the new turn continues it rather than forking.
  function handleRegenerate(userText: string) {
    const trimmed = userText.trim();
    if (!trimmed || send.isStreaming) return;
    if (fenced && anyPendingUnindexed) return;
    const scope =
      currentConversationId === null
        ? launchScopeToCoachScope(launchScope)
        : undefined;
    void send.send({
      conversationId: currentConversationId ?? undefined,
      message: trimmed,
      scope: fenced ? undefined : scope,
      workoutId:
        fenced || currentConversationId !== null
          ? undefined
          : (activeWorkoutId ?? undefined),
      fenced,
      pendingAttachmentIds:
        currentConversationId === null ? pendingAttachmentIds : undefined,
    });
  }

  return { handleFollowUp, handleReply, handleSubmit, handleRegenerate };
}
