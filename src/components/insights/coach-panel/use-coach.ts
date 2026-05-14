"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CoachConversationDetailDTO,
  CoachConversationDTO,
  CoachConversationsPage,
  CoachProvenance,
  CoachScope,
  CoachStreamEvent,
} from "@/lib/ai/coach/types";

/**
 * v1.4.20 phase B2b — TanStack Query + SSE client for the AI Coach
 * drawer.
 *
 * The shape mirrors the backend wire format from `phase-B2a-report.md`:
 * `GET /api/insights/chat`, `GET /api/insights/chat/[id]`,
 * `DELETE /api/insights/chat/[id]`, and the SSE-streaming
 * `POST /api/insights/chat`.
 *
 * Streaming is implemented with `fetch` + `getReader()` — no third-party
 * SSE lib pulled in. The byte stream is decoded with `TextDecoder` and
 * scanned for the `\n\n` frame separator; each frame is JSON-parsed and
 * dispatched to the event callback. We also export `parseSseChunk` as a
 * pure helper so the parser can be unit-tested without spinning up a
 * real network stream.
 */

const QUERY_KEYS = {
  list: () => ["coachConversations"] as const,
  one: (id: string) => ["coachConversation", id] as const,
};

interface ConversationsApiResponse {
  data: CoachConversationsPage;
}

interface ConversationApiResponse {
  data: CoachConversationDetailDTO;
}

/**
 * List of conversations for the rail. Cursor pagination is exposed via
 * `loadMore` — the rail can call it when the user scrolls past the
 * end. v1.4.20 lands with default-page-only; cursors are pre-wired so
 * v1.4.21 / v1.5 can add infinite scroll without reshaping the hook.
 */
export function useCoachConversations(enabled = true) {
  const query = useQuery({
    queryKey: QUERY_KEYS.list(),
    queryFn: async (): Promise<CoachConversationsPage> => {
      const res = await fetch("/api/insights/chat", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ConversationsApiResponse;
      return json.data;
    },
    enabled,
    staleTime: 30 * 1000,
  });

  return {
    conversations: query.data?.conversations ?? [],
    nextCursor: query.data?.nextCursor ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/**
 * Fetch one conversation with every message decrypted server-side.
 * `id === null` disables the query so the drawer can mount without a
 * selection.
 */
export function useCoachConversation(id: string | null) {
  return useQuery({
    // The query is gated on `enabled: id !== null`, so the queryFn
    // never fires when `id` is null. Key directly on `id` (TanStack
    // Query accepts `null` in the array) — the previous "null"
    // placeholder branch was structurally equivalent dead code.
    queryKey: ["coachConversation", id] as const,
    queryFn: async (): Promise<CoachConversationDetailDTO> => {
      if (!id) throw new Error("missing id");
      const res = await fetch(`/api/insights/chat/${id}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ConversationApiResponse;
      return json.data;
    },
    enabled: id !== null,
    staleTime: 60 * 1000,
  });
}

/**
 * Delete a conversation with optimistic removal from the rail cache.
 * Rolls back if the server responds with a non-2xx.
 */
export function useDeleteCoachConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/insights/chat/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return id;
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.list() });
      const previous = queryClient.getQueryData<CoachConversationsPage>(
        QUERY_KEYS.list(),
      );
      if (previous) {
        queryClient.setQueryData<CoachConversationsPage>(QUERY_KEYS.list(), {
          ...previous,
          conversations: previous.conversations.filter((c) => c.id !== id),
        });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(QUERY_KEYS.list(), ctx.previous);
      }
    },
    onSettled: (_data, _err, id) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list() });
      if (typeof id === "string") {
        queryClient.removeQueries({ queryKey: QUERY_KEYS.one(id) });
      }
    },
  });
}

/**
 * Pure SSE parser used by the streaming hook AND the unit tests.
 *
 * Takes a chunk of decoded text + the residual buffer carried from the
 * previous chunk and returns:
 *   - `events`: every fully-formed `CoachStreamEvent` parsed out of the
 *     concatenated buffer
 *   - `rest`: the trailing partial frame, kept around for the next call
 *
 * Frames look like `data: {"type":"token","token":"…"}\n\n`. We split
 * on `\n\n`, then strip the `data: ` prefix and JSON-parse the
 * remainder. Lines that don't look like SSE data are silently dropped
 * (matches the additive-evolution comment on the wire schema).
 */
export function parseSseChunk(
  buffer: string,
  chunk: string,
): { events: CoachStreamEvent[]; rest: string } {
  const combined = buffer + chunk;
  const events: CoachStreamEvent[] = [];
  let cursor = 0;
  while (cursor < combined.length) {
    const sep = combined.indexOf("\n\n", cursor);
    if (sep === -1) break;
    const frame = combined.slice(cursor, sep);
    cursor = sep + 2;
    const dataLine = frame
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.slice("data:".length).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as CoachStreamEvent;
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        events.push(parsed);
      }
    } catch {
      // ignore malformed frame; the wire format is forward-compatible.
    }
  }
  return { events, rest: combined.slice(cursor) };
}

/**
 * One assistant turn that is currently being streamed. The drawer
 * renders this alongside the persisted conversation history so the user
 * sees tokens arrive as they generate.
 */
export interface CoachStreamingMessage {
  /** Concatenated tokens received so far. */
  content: string;
  /** Provenance frame — populated once the server emits it. */
  metricSource: CoachProvenance | null;
  /** True until the `done` frame closes the stream. */
  inProgress: boolean;
  /** Final messageId once `done` lands; null otherwise. */
  messageId: string | null;
  /** Server-side error code from an `error` frame, if any. */
  errorCode: string | null;
}

/**
 * v1.4.25 W5 — optimistic user bubble surfaced by the send hook so the
 * thread paints the user's message immediately, before the assistant's
 * "Thinking…" placeholder. The server persists the user message before
 * the stream starts (see `appendMessage` in
 * `src/app/api/insights/chat/route.ts`), but the persisted twin only
 * lands client-side after the SSE `done` frame triggers a
 * `queryClient.invalidateQueries`. The earlier render order was
 * "Thinking…" → user message → assistant reply, which Marc flagged in
 * the W5 polish brief; surfacing this optimistic bubble flips the
 * order to user → "Thinking…" → assistant reply.
 *
 * The bubble holds the message text + the (parent-supplied)
 * conversationId so the thread renderer can match it against the
 * persisted history and suppress the twin during the same 150ms grace
 * window that already guards the assistant streaming bubble (see
 * `message-thread.tsx`).
 */
export interface CoachOptimisticUserMessage {
  /** Local-only id so React keys stay stable across renders. */
  localId: string;
  /** The user's message text — exactly what was sent to the server. */
  content: string;
  /**
   * Conversation id at the time the send fired. Null when the user is
   * creating a brand-new conversation; the server assigns the id and
   * emits it on the `done` frame.
   */
  conversationId: string | null;
}

const EMPTY_STREAMING: CoachStreamingMessage = {
  content: "",
  metricSource: null,
  inProgress: false,
  messageId: null,
  errorCode: null,
};

export interface SendCoachMessageParams {
  conversationId?: string;
  message: string;
  prefill?: string;
  locale?: "en" | "de";
  /**
   * v1.4.20.1 — optional snapshot scope (per-source toggles + window)
   * driven by the sources-rail picker. When omitted the server falls
   * back to all-source last30days, matching the legacy behaviour.
   */
  scope?: CoachScope;
}

export interface UseSendCoachMessageOptions {
  /**
   * Fired with the resolved `conversationId` after the `done` frame.
   * Lets the drawer flip to the just-created conversation when the
   * user starts a brand-new thread.
   */
  onDone?: (conversationId: string) => void;
}

/**
 * The streaming hook.
 *
 * `send()` POSTs to `/api/insights/chat`, walks the byte stream via
 * `fetch().body.getReader()`, and updates `streaming` after every
 * token / provenance / done / error frame. The drawer reads `streaming`
 * to render the live assistant bubble.
 *
 * On `done` we invalidate the conversation cache so the next mount
 * picks up the persisted shape (including the assistant message id and
 * any server-side editorialisation of the body).
 */
export function useSendCoachMessage(opts: UseSendCoachMessageOptions = {}) {
  const queryClient = useQueryClient();
  const [streaming, setStreaming] =
    useState<CoachStreamingMessage>(EMPTY_STREAMING);
  // v1.4.25 W5 — optimistic user bubble. Mounts the user's message in
  // the thread immediately so the chronological render order matches
  // the user's mental model (send → my message → coach "Thinking…" →
  // reply). Cleared once the persisted twin lands via the invalidate-
  // refetch the SSE `done` frame triggers.
  const [optimisticUser, setOptimisticUser] =
    useState<CoachOptimisticUserMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Stash `opts` in a ref so callers can pass an inline-literal object
  // (`useSendCoachMessage({ onDone: … })`) without re-memoising `send`
  // on every render. The hook owns the latest-callback-wins contract.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const reset = useCallback(() => {
    setStreaming(EMPTY_STREAMING);
    setOptimisticUser(null);
  }, []);

  const send = useCallback(
    async (params: SendCoachMessageParams): Promise<void> => {
      // Cancel any prior in-flight request.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // v1.4.25 W5 — surface the user's message in the thread BEFORE
      // the "Thinking…" placeholder paints. Without this the send hook
      // only exposed the streaming assistant bubble, so the first
      // thing the user saw was the placeholder followed by their own
      // message landing on the next refetch — Marc flagged the
      // order as confusing on the suggested-prompt chips.
      setOptimisticUser({
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        content: params.message,
        conversationId: params.conversationId ?? null,
      });
      setStreaming({
        content: "",
        metricSource: null,
        inProgress: true,
        messageId: null,
        errorCode: null,
      });

      let response: Response;
      try {
        response = await fetch("/api/insights/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            conversationId: params.conversationId,
            message: params.message,
            prefill: params.prefill,
            locale: params.locale,
            scope: params.scope,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setStreaming({
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.network",
        });
        return;
      }

      if (!response.body) {
        setStreaming({
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: `coach.http.${response.status}`,
        });
        return;
      }

      // Even on `!response.ok`, the route may have emitted a structured
      // `error` frame in an SSE body (e.g. 4xx/5xx + text/event-stream).
      // Falling back to `coach.http.<status>` would discard the richer
      // `errorCode`. Read the stream and let the parser route the frame
      // through the same path as the success case.
      const contentType = response.headers.get("Content-Type") ?? "";
      const isEventStream = contentType
        .toLowerCase()
        .startsWith("text/event-stream");
      if (!response.ok && !isEventStream) {
        // v1.4.25 W5 — for JSON errors the apiHandler envelope carries
        // a structured `error` code (e.g. `coach.budget.exceeded`).
        // Surface the structured code directly so the drawer can show
        // the right copy + toast variant; fall back to the generic
        // `coach.http.<status>` only when parsing the envelope fails.
        let structured: string | null = null;
        try {
          const envelope = (await response.clone().json()) as {
            error?: unknown;
          };
          if (typeof envelope?.error === "string") {
            structured = envelope.error;
          }
        } catch {
          // body was not JSON; fall through to the http-status fallback
        }
        setStreaming({
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: structured ?? `coach.http.${response.status}`,
        });
        // Drop the optimistic user bubble on the error path too so
        // the next refetch — which still has the persisted user
        // message — doesn't render the same bubble twice.
        setOptimisticUser(null);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resolvedConversationId: string | null = null;
      let collectedContent = "";
      let collectedProvenance: CoachProvenance | null = null;
      let lastError: string | null = null;
      let messageId: string | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buffer, text);
          buffer = rest;
          for (const evt of events) {
            switch (evt.type) {
              case "token":
                collectedContent += evt.token;
                setStreaming((prev) => ({
                  ...prev,
                  content: prev.content + evt.token,
                }));
                break;
              case "provenance":
                collectedProvenance = evt.metricSource;
                setStreaming((prev) => ({
                  ...prev,
                  metricSource: evt.metricSource,
                }));
                break;
              case "done":
                resolvedConversationId = evt.conversationId;
                messageId = evt.messageId;
                break;
              case "error":
                lastError = evt.code;
                break;
            }
          }
        }
        // Final flush of any trailing frame in the residual buffer.
        const tail = parseSseChunk(buffer, "\n\n");
        for (const evt of tail.events) {
          if (evt.type === "done") {
            resolvedConversationId = evt.conversationId;
            messageId = evt.messageId;
          } else if (evt.type === "error") {
            lastError = evt.code;
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          lastError = "coach.stream";
        }
      }

      setStreaming({
        content: collectedContent,
        metricSource: collectedProvenance,
        inProgress: false,
        messageId,
        errorCode: lastError,
      });

      if (resolvedConversationId) {
        // Invalidate the freshly-persisted conversation + the rail so
        // the drawer's next mount picks up the encrypted-on-disk shape
        // and the rail orders the thread to the top.
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.one(resolvedConversationId),
        });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list() });
        optsRef.current.onDone?.(resolvedConversationId);
      }
      // v1.4.25 W5 — drop the optimistic user bubble; the persisted
      // twin is on its way via the invalidate-refetch above. Drop on
      // error too so the user message isn't doubled when the next
      // refetch sees the server-persisted row.
      setOptimisticUser(null);
    },
    [queryClient],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    streaming,
    isStreaming: streaming.inProgress,
    send,
    cancel,
    reset,
    optimisticUser,
  };
}

// Re-exports for adjacent components that don't want to reach into
// `@/lib/ai/coach/types` directly.
export type {
  CoachConversationDTO,
  CoachConversationDetailDTO,
  CoachProvenance,
};
