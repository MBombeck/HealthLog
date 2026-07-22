"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";

import type {
  CoachConversationAttachmentDTO,
  CoachConversationDetailDTO,
  CoachConversationDTO,
  CoachConversationsPage,
  CoachProvenance,
  CoachScope,
  CoachStreamEvent,
  CoachSuggestion,
  CoachUsage,
} from "@/lib/ai/coach/types";
import type { CoachSuggestedAction } from "@/lib/ai/coach/suggest-action";
import { useTranslations } from "@/lib/i18n/context";
import {
  apiDelete,
  apiFetchRaw,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

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
  list: () => queryKeys.coachConversations(),
  one: (id: string) => queryKeys.coachConversation(id),
};

export interface RenameCoachConversationInput {
  id: string;
  title: string;
}

export type CoachConversationRenameSnapshot = Array<
  readonly [QueryKey, unknown]
>;

function renameConversationInCache(
  data: unknown,
  input: RenameCoachConversationInput,
): unknown {
  if (!data || typeof data !== "object") return data;

  if ("pages" in data && Array.isArray(data.pages)) {
    let changed = false;
    const pages = data.pages.map((page) => {
      const renamed = renameConversationInCache(page, input);
      changed ||= renamed !== page;
      return renamed;
    });
    return changed ? { ...data, pages } : data;
  }

  if ("conversations" in data && Array.isArray(data.conversations)) {
    let changed = false;
    const conversations = data.conversations.map((conversation) => {
      if (
        conversation &&
        typeof conversation === "object" &&
        "id" in conversation &&
        conversation.id === input.id
      ) {
        changed = true;
        return { ...conversation, title: input.title };
      }
      return conversation;
    });
    return changed ? { ...data, conversations } : data;
  }

  if ("id" in data && data.id === input.id && "title" in data) {
    return { ...data, title: input.title };
  }
  return data;
}

/**
 * Capture and update every currently materialised conversation cache. Search
 * variants live below the list prefix, while the open thread has its own key.
 */
export async function applyOptimisticCoachConversationRename(
  queryClient: QueryClient,
  input: RenameCoachConversationInput,
): Promise<CoachConversationRenameSnapshot> {
  const detailKey = queryKeys.coachConversation(input.id);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: QUERY_KEYS.list() }),
    queryClient.cancelQueries({ queryKey: detailKey }),
  ]);

  const snapshot: CoachConversationRenameSnapshot = [
    ...queryClient.getQueriesData({ queryKey: QUERY_KEYS.list() }),
    ...queryClient.getQueriesData({ queryKey: detailKey, exact: true }),
  ];
  for (const [key, previous] of snapshot) {
    queryClient.setQueryData(key, renameConversationInCache(previous, input));
  }
  return snapshot;
}

export function restoreCoachConversationRename(
  queryClient: QueryClient,
  snapshot: CoachConversationRenameSnapshot,
): void {
  for (const [key, previous] of snapshot) {
    queryClient.setQueryData(key, previous);
  }
}

export async function invalidateCoachConversationRename(
  queryClient: QueryClient,
  id: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list() }),
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.one(id) }),
  ]);
}

export async function patchCoachConversationTitle(
  input: RenameCoachConversationInput,
): Promise<RenameCoachConversationInput> {
  const title = input.title.trim();
  return apiPatch<RenameCoachConversationInput>(
    `/api/insights/chat/${encodeURIComponent(input.id)}`,
    { title },
  );
}

/**
 * The single (first) page of conversations. Used ONLY for the
 * auto-open-most-recent-thread behaviour on mount
 * (`coach-conversation.tsx`), which never needs more than the rail's
 * server-authoritative head. Every surface that lets the user BROWSE or
 * SEARCH history (the drawer rail, the standalone conversations page) reads
 * `useCoachConversationHistory` below instead — it walks the full cursor
 * chain via `useInfiniteQuery` rather than stopping at page one.
 */
export function useCoachConversations(enabled = true) {
  const query = useQuery({
    queryKey: QUERY_KEYS.list(),
    queryFn: async (): Promise<CoachConversationsPage> => {
      return apiGet<CoachConversationsPage>("/api/insights/chat", {
        headers: { Accept: "application/json" },
      });
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

const HISTORY_PAGE_LIMIT = 20;

export interface UseCoachConversationHistoryOptions {
  /**
   * Server-side title search (see `GET /api/insights/chat?q=`). The caller
   * debounces the raw input (`useDebouncedValue`) before passing it here —
   * every distinct value keys its own cache page chain, so a fast typist
   * never sees a stale search's tail page bleed into a fresh one.
   */
  search?: string;
  enabled?: boolean;
}

/**
 * v1.30.2 (QoL H1) — the full, paginated + server-searched conversation
 * history. Replaces the old "first page only, client-side substring
 * filter" behaviour: `useInfiniteQuery` walks the cursor chain
 * (`nextCursor`) so every conversation the caller has ever had is
 * reachable via `fetchNextPage`, and `search` narrows the SERVER'S query
 * (title-only — see the route doc comment) rather than filtering an
 * already-truncated client array.
 *
 * Shared by the drawer's `<HistoryRail>` and the standalone
 * `/coach/conversations` page so the two surfaces can never drift onto
 * different pagination behaviour again.
 */
export function useCoachConversationHistory(
  options: UseCoachConversationHistoryOptions = {},
) {
  const { search = "", enabled = true } = options;
  const trimmedSearch = search.trim();

  const query = useInfiniteQuery({
    queryKey: queryKeys.coachConversationHistory(trimmedSearch),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | null;
    }): Promise<CoachConversationsPage> => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      params.set("limit", String(HISTORY_PAGE_LIMIT));
      if (trimmedSearch) params.set("q", trimmedSearch);
      return apiGet<CoachConversationsPage>(
        `/api/insights/chat?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    staleTime: 30 * 1000,
  });

  const conversations = useMemo(
    () => query.data?.pages.flatMap((page) => page.conversations) ?? [],
    [query.data],
  );

  return {
    conversations,
    isLoading: query.isLoading,
    isError: query.isError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
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
    queryKey: queryKeys.coachConversation(id),
    queryFn: async (): Promise<CoachConversationDetailDTO> => {
      if (!id) throw new Error("missing id");
      return apiGet<CoachConversationDetailDTO>(`/api/insights/chat/${id}`, {
        headers: { Accept: "application/json" },
      });
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
      await apiDelete(`/api/insights/chat/${id}`);
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

// v1.30.1 M5 — delayed-commit delete window, in milliseconds. Long
// enough to read + tap Undo, short enough that the eventual DELETE
// isn't a surprise days later.
const CONVERSATION_DELETE_UNDO_MS = 6000;

/**
 * v1.30.1 M5 — replaces the old "tap once to arm, tap the same row
 * again to delete" confirm, which never disarmed (a row armed minutes
 * earlier deleted on a later stray tap) and had no way back once fired.
 * Mirrors the Documents delete-with-undo pattern instead: a single tap
 * hides the row immediately and schedules the real
 * `DELETE /api/insights/chat/[id]` after `CONVERSATION_DELETE_UNDO_MS`;
 * calling `undoDelete` within that window cancels the network call and
 * un-hides the row. `pendingDeleteIds` is a client-only hide filter —
 * consumers subtract it from whatever list they render.
 *
 * Centralised here (rather than duplicated in the rail + the standalone
 * `/coach/conversations` page, which previously carried byte-identical
 * arm/confirm logic) so both surfaces share one implementation.
 */
export function useDeleteCoachConversationWithUndo() {
  const deleteMutation = useDeleteCoachConversation();
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    // A closed drawer / unmounted page must not silently lose a
    // scheduled delete: fire any still-pending ones immediately rather
    // than leaking the timer (or worse, never deleting at all).
    const timerMap = timers.current;
    return () => {
      for (const [id, timer] of timerMap) {
        clearTimeout(timer);
        deleteMutation.mutate(id);
      }
      timerMap.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on unmount only
  }, []);

  const requestDelete = useCallback(
    (id: string) => {
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      const timer = setTimeout(() => {
        timers.current.delete(id);
        setPendingDeleteIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        deleteMutation.mutate(id);
      }, CONVERSATION_DELETE_UNDO_MS);
      timers.current.set(id, timer);
    },
    [deleteMutation],
  );

  const undoDelete = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setPendingDeleteIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return { pendingDeleteIds, requestDelete, undoDelete };
}

/**
 * Shared rename mutation for every Coach history surface. It snapshots each
 * materialised list/search/detail cache before the optimistic write and
 * restores those exact data references if persistence fails.
 */
export function useRenameCoachConversation() {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  return useMutation({
    mutationFn: patchCoachConversationTitle,
    onMutate: (input: RenameCoachConversationInput) =>
      applyOptimisticCoachConversationRename(queryClient, {
        ...input,
        title: input.title.trim(),
      }),
    onError: (_error, _input, snapshot) => {
      if (snapshot) restoreCoachConversationRename(queryClient, snapshot);
      toast.error(t("insights.coach.rename.error"));
    },
    onSettled: (_data, _error, input) => {
      void invalidateCoachConversationRename(queryClient, input.id);
    },
  });
}

/**
 * v1.29.x (S7) — attach a stored document to an EXISTING fenced (or about-to-be-
 * fenced) conversation. On success invalidates the conversation detail + rail so
 * the pills + badge refetch from server truth. The server flips the sticky flag
 * true (the one legal, privilege-reducing tool→fenced transition).
 */
export function useAttachCoachDocument(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.coachAttachmentMutation(conversationId),
    mutationFn: async (documentId: string): Promise<CoachAttachmentsResponse> =>
      apiPost<CoachAttachmentsResponse>(
        `/api/insights/chat/${conversationId}/attachments`,
        { documentId },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachConversation(conversationId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachConversations(),
      });
    },
  });
}

/**
 * v1.29.x (S7) — detach a document from a fenced conversation. The conversation
 * stays fenced (sticky flag). Invalidates the detail + rail on success.
 */
export function useDetachCoachDocument(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.coachAttachmentMutation(conversationId),
    mutationFn: async (documentId: string): Promise<CoachAttachmentsResponse> =>
      apiDelete<CoachAttachmentsResponse>(
        `/api/insights/chat/${conversationId}/attachments/${encodeURIComponent(
          documentId,
        )}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachConversation(conversationId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachConversations(),
      });
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
  /**
   * v1.18.1 (Workstream C) — cadence suggestion from the additive
   * `suggestion` frame, if the turn carried one. Null otherwise.
   */
  suggestion: CoachSuggestion | null;
  /**
   * v1.22 (W7/W6) — generalised confirm-card action from the additive
   * `suggestedAction` frame (mirrors `suggestion`). Persisted messages carry it
   * on `metricSource.suggestedAction` instead. Null otherwise.
   */
  suggestedAction: CoachSuggestedAction | null;
  /** True until the `done` frame closes the stream. */
  inProgress: boolean;
  /** Final messageId once `done` lands; null otherwise. */
  messageId: string | null;
  /** Server-side error code from an `error` frame, if any. */
  errorCode: string | null;
  /**
   * v1.18.9 — per-turn token usage from the additive `done.usage` frame.
   * Null until `done` lands (or when the provider returned no count). The
   * thread's token footer reads this for the just-finished streaming
   * bubble; persisted bubbles read `CoachMessageDTO.tokensUsed` instead.
   */
  usage: CoachUsage | null;
}

/**
 * v1.4.25 W5 — optimistic user bubble surfaced by the send hook so the
 * thread paints the user's message immediately, before the assistant's
 * "Thinking…" placeholder. The server persists the user message before
 * the stream starts (see `appendMessage` in
 * `src/app/api/insights/chat/route.ts`), but the persisted twin only
 * lands client-side after the SSE `done` frame triggers a
 * `queryClient.invalidateQueries`. The earlier render order was
 * "Thinking…" → user message → assistant reply, which the maintainer flagged in
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
  suggestion: null,
  suggestedAction: null,
  inProgress: false,
  messageId: null,
  errorCode: null,
  usage: null,
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
  /**
   * v1.16.6 — guided clarifying-questions flow: the pending question
   * this message answers. Server-side prompt context only; never
   * persisted with the message.
   */
  guidedQuestion?: string;
  /**
   * v1.29.x (S7) — SERVER-AUTHORITATIVE: the loaded conversation's sticky
   * `documentScoped` flag. When true the turn is FENCED and routes to the
   * hardened `/api/insights/chat/fenced` endpoint (no tools, no snapshot, fenced
   * document text) — NEVER the coach tool route. A stale client cannot mis-route
   * an already-fenced conversation to the tool route because this comes from the
   * server DTO, not client-side attachment bookkeeping.
   */
  fenced?: boolean;
  /**
   * v1.29.x (S7) — LOCAL state: documents staged in the composer for a NOT-yet-
   * created conversation (first-turn attach). Empty / omitted otherwise. Their
   * presence also forces the fenced route (a fresh chat born with attachments is
   * fenced). Ignored once a conversation exists — attach-to-existing goes through
   * `POST /api/insights/chat/{id}/attachments`.
   */
  pendingAttachmentIds?: string[];
  /**
   * v1.31.0 — the workout a FRESH conversation is scoped to. Travels ONLY on
   * the first turn (the caller gates on a null conversation id) and never on
   * the fenced path, which has no snapshot to pin a section onto. The server
   * ignores it on any later turn regardless, so snapshot-once holds even if a
   * client re-sent it.
   */
  workoutId?: string;
}

/**
 * v1.29.x (S7) — the ONE branch point that decides which backend a Coach turn
 * hits. A FENCED turn (the conversation's server `fenced` flag OR staged
 * first-turn attachments) goes to the hardened `/api/insights/chat/fenced`
 * endpoint; otherwise the normal Coach route (tool loop + health snapshot).
 * Extracted as a pure function so a unit test can prove a fenced send never
 * resolves to the tool route — the whole prompt-injection fence rests on this.
 */
export function resolveCoachSendTarget(params: SendCoachMessageParams): {
  url: string;
  body: string;
} {
  const fenced =
    params.fenced === true || (params.pendingAttachmentIds?.length ?? 0) > 0;
  if (fenced) {
    // Fenced path. The body carries ONLY the fields the fenced endpoint accepts
    // — NOT `scope` / `guidedQuestion` / `prefill`, which drive the coach's
    // snapshot + tool behaviour and have no place on the hardened endpoint (the
    // server schema is `.strict()` and would 422 them). `attachmentIds` travels
    // ONLY on a brand-new conversation (first-turn attach); attach-to-existing
    // uses the dedicated attach endpoint, so it is omitted once an id exists.
    const attachmentIds =
      !params.conversationId && (params.pendingAttachmentIds?.length ?? 0) > 0
        ? params.pendingAttachmentIds
        : undefined;
    return {
      url: "/api/insights/chat/fenced",
      body: JSON.stringify({
        conversationId: params.conversationId,
        message: params.message,
        locale: params.locale,
        attachmentIds,
      }),
    };
  }
  return {
    url: "/api/insights/chat",
    body: JSON.stringify({
      conversationId: params.conversationId,
      message: params.message,
      prefill: params.prefill,
      locale: params.locale,
      scope: params.scope,
      guidedQuestion: params.guidedQuestion,
      workoutId: params.workoutId,
    }),
  };
}

/**
 * v1.29.x (S7) — the shape both attach + detach mutations return (and the fenced
 * conversation detail carries): the refreshed live attachment set + the sticky
 * fenced flag (always true after an attach; unchanged by a detach).
 */
export interface CoachAttachmentsResponse {
  attachments: CoachConversationAttachmentDTO[];
  fenced: boolean;
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
    async (params: SendCoachMessageParams): Promise<string | null> => {
      // Cancel any prior in-flight request.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // v1.4.25 W5 — surface the user's message in the thread BEFORE
      // the "Thinking…" placeholder paints. Without this the send hook
      // only exposed the streaming assistant bubble, so the first
      // thing the user saw was the placeholder followed by their own
      // message landing on the next refetch — the maintainer flagged the
      // order as confusing on the suggested-prompt chips.
      setOptimisticUser({
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        content: params.message,
        conversationId: params.conversationId ?? null,
      });
      setStreaming({
        content: "",
        metricSource: null,
        suggestion: null,
        suggestedAction: null,
        inProgress: true,
        messageId: null,
        errorCode: null,
        usage: null,
      });

      // v1.4.47 W8 — pre-check navigator.onLine so an airplane-mode
      // user gets the offline-specific copy immediately rather than
      // waiting for the fetch to fail with a generic network error.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStreaming({
          content: "",
          metricSource: null,
          suggestion: null,
          suggestedAction: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.network",
          usage: null,
        });
        return null;
      }

      // v1.28.51 — resolve the target BEFORE the fetch. A doc-scoped turn
      // resolves to the hardened fenced document endpoint; everything else to
      // the Coach tool route. This is the prompt-injection fence's client edge.
      const target = resolveCoachSendTarget(params);

      // apiFetchRaw: the chat POST streams SSE — the envelope helpers
      // would buffer and unwrap a body that never carries the envelope.
      let response: Response;
      try {
        response = await apiFetchRaw(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: target.body,
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return null;
        setStreaming({
          content: "",
          metricSource: null,
          suggestion: null,
          suggestedAction: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.network",
          usage: null,
        });
        return null;
      }

      if (!response.body) {
        setStreaming({
          content: "",
          metricSource: null,
          suggestion: null,
          suggestedAction: null,
          inProgress: false,
          messageId: null,
          errorCode: `coach.http.${response.status}`,
          usage: null,
        });
        return null;
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
          suggestion: null,
          suggestedAction: null,
          inProgress: false,
          messageId: null,
          errorCode: structured ?? `coach.http.${response.status}`,
          usage: null,
        });
        // v1.16.4 — KEEP the optimistic user bubble: a rejected turn
        // (budget gate, 4xx) has no persisted twin coming, and dropping
        // the bubble left the error standing next to an empty thread.
        // The content-equality dedupe in <MessageThread> still
        // suppresses the optimistic copy if a persisted twin lands.
        return null;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resolvedConversationId: string | null = null;
      let collectedContent = "";
      let collectedProvenance: CoachProvenance | null = null;
      let collectedSuggestion: CoachSuggestion | null = null;
      let collectedSuggestedAction: CoachSuggestedAction | null = null;
      let lastError: string | null = null;
      let messageId: string | null = null;
      let collectedUsage: CoachUsage | null = null;

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
              case "suggestion":
                collectedSuggestion = evt.suggestion;
                setStreaming((prev) => ({
                  ...prev,
                  suggestion: evt.suggestion,
                }));
                break;
              case "suggestedAction":
                collectedSuggestedAction = evt.suggestedAction;
                setStreaming((prev) => ({
                  ...prev,
                  suggestedAction: evt.suggestedAction,
                }));
                break;
              case "reasoning":
                // v1.19.1 — the thinking disclosure was removed, so the
                // additive `reasoning` frame is accepted off the wire and
                // dropped. Kept as an explicit no-op case so the wire frame
                // stays a recognised type rather than slipping to a default.
                break;
              case "done":
                resolvedConversationId = evt.conversationId;
                messageId = evt.messageId;
                // v1.18.9 — additive per-turn usage envelope.
                collectedUsage = evt.usage ?? null;
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
            collectedUsage = evt.usage ?? null;
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
        suggestion: collectedSuggestion,
        suggestedAction: collectedSuggestedAction,
        inProgress: false,
        messageId,
        errorCode: lastError,
        usage: collectedUsage,
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
      // twin is on its way via the invalidate-refetch above.
      // v1.16.4 — but only when a twin IS coming (the turn resolved a
      // conversation) or the turn succeeded outright. An errored turn
      // without a conversation id persisted nothing; dropping the
      // bubble then erased the user's message next to the error bubble.
      // The content-equality dedupe in <MessageThread> still suppresses
      // the optimistic copy if a persisted twin does land later.
      if (resolvedConversationId || !lastError) {
        setOptimisticUser(null);
      }
      return resolvedConversationId;
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
  CoachConversationAttachmentDTO,
  CoachConversationDTO,
  CoachConversationDetailDTO,
  CoachProvenance,
  CoachSuggestion,
  CoachUsage,
};
