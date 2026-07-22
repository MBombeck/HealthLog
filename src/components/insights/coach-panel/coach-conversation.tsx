"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Paperclip, Plus, Settings, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiDelete, apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import type { CoachScope } from "@/lib/ai/coach/types";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";
import type { CoachSeededQuestionDTO } from "@/app/api/insights/coach/seeded-question/route";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";
import { MAX_COACH_ATTACHMENTS } from "@/lib/validations/inbound-documents";
import { useModuleEnabled } from "@/hooks/use-module-enabled";
import { parseUploadResponse } from "@/components/documents/vault-utils";
import {
  metricScopeLabelFallback,
  scopeSourceMetricLabelKey,
} from "@/components/insights/coach-metric-scope";

import { CoachDrawerBody } from "./coach-drawer-body";
import { CoachHero } from "./coach-hero";
import { ScopeHintBadge } from "./scope-hint-badge";
import { CoachInput } from "./coach-input";
import {
  GuidedQuestionBubble,
  GuidedSummaryBubble,
} from "./guided-dialog-bubbles";
import { GuidedQuestionsCard } from "./guided-questions-card";
import {
  deriveThreadItems,
  GUIDED_IDLE,
  guidedReducer,
} from "./guided-questions-machine";
import { HistoryRail } from "./history-rail";
import { MessageThread, type InterleavedThreadItem } from "./message-thread";
import { MobileRailTray } from "./mobile-rail-tray";
import { SelfContextAdoptOffer } from "./self-context-adopt-offer";
import { SourcesRail } from "./sources-rail";
import { AttachmentPills, type AttachmentPillItem } from "./attachment-pills";
import { AttachmentPicker } from "./attachment-picker";
import { useResettableValue } from "./use-resettable-value";
import { useCoachAmbientSuggestionsEnabled } from "@/hooks/use-coach-ambient-suggestions";
import {
  useAttachCoachDocument,
  useCoachConversation,
  useCoachConversations,
  useDetachCoachDocument,
  useSendCoachMessage,
} from "./use-coach";

/**
 * v1.12.0 (Coach v2 #6) — shared chat surface for both the Coach drawer
 * (`<CoachDrawer>`, right/bottom `<Sheet>` overlay) and the full-page
 * Coach route (`/coach`).
 *
 * This component is the single source of truth for the Coach
 * conversation: it owns the active-conversation id, the streaming send
 * hook, the composer value, and the rail trays — every piece of Coach
 * v2 behaviour (incremental streaming, collapsible history +
 * provenance, the auto-grow composer, refusal / budget handling)
 * lives here once.
 * The drawer and the page differ ONLY in their chrome: the drawer wraps
 * this surface in a `<Sheet>` and supplies a close button + a maximize
 * control; the page renders it edge-to-edge and supplies a minimize
 * control. Neither forks the chat logic.
 *
 * The title + description render through `renderTitle` / `renderDescription`
 * render-props so the drawer can mount the Radix `<SheetTitle>` /
 * `<SheetDescription>` (required for the dialog's accessible name) while
 * the page mounts a plain `<h1>` / `<p>`.
 */

/**
 * v1.21.0 (C4 H1/H4) — collapse a UI launch scope ({ metric, also,
 * window }) into the chat route's wire scope ({ sources, window }).
 * Returns undefined when there is nothing to narrow, so the request
 * falls back to the route's default all-source snapshot. Exported for
 * the unit test that pins the source-dedup + window contract.
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

/**
 * v1.29.x — a stale/invalid `?doc=<id>` deep-link (a deleted document, a
 * mistyped id, someone else's document) 404s the staged detail fetch
 * forever, which used to trap every send behind a phantom "untitled"
 * attachment that could never resolve (the fenced gate never clears).
 * Pure so the drop decision is unit-testable without mounting the
 * component: given the currently staged ids and which of their detail
 * fetches settled into an error (index-aligned with `pendingAttachmentIds`,
 * matching `useQueries`' `isError`), returns the ids that should fall out of
 * staging. A bad link degrades to a normal chat instead of a dead end.
 */
export function dropInvalidStagedAttachments(
  pendingAttachmentIds: string[],
  isErrorByIndex: boolean[],
): string[] {
  return pendingAttachmentIds.filter((_, i) => isErrorByIndex[i] === true);
}

/**
 * v1.21.4 (C2) — the localStorage key that records the seeded "worth a look"
 * opener as dismissed for a given LOCAL calendar day. Date-stamped so the
 * dismissal resets at midnight: a new day mints a new key the flag has not
 * been written under yet, and the opener returns.
 */
function seededDismissStorageKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `coach-seeded-dismissed:${year}-${month}-${day}`;
}

export interface CoachConversationProps {
  /**
   * Pre-fill for the composer (suggested-prompt chip click). Resets the
   * composer on change via `useResettableValue`; the user can still type
   * freely between prop changes.
   */
  prefill?: string | null;
  /**
   * v1.21.0 (C4 H1/H4) — optional launch scope so a conversation opened
   * from a metric surface or insight card narrows its snapshot to the
   * relevant source(s) + window. Converted to the chat route's
   * `CoachScope` and attached to the FIRST turn of a fresh conversation
   * (`currentConversationId === null`); a continued thread keeps its own
   * established scope. Null → the route's default all-source snapshot.
   */
  launchScope?: CoachLaunchScope | null;
  /**
   * When true, the `prefill` is dispatched as the conversation's first turn
   * automatically, exactly once on mount (ref-guarded). Used by the
   * assessment hand-off so the answer lands without a manual send. The send
   * only fires for a fresh conversation with a non-empty prefill.
   */
  autoSend?: boolean;
  /**
   * Renders the conversation title. The surface passes the resolved
   * title string; the drawer wraps it in `<SheetTitle>`, the page in an
   * `<h1>`. Falls back to a plain element when omitted.
   */
  renderTitle?: (title: string) => React.ReactNode;
  /** Renders the tagline line beneath the title (see `renderTitle`). */
  renderDescription?: (tagline: string) => React.ReactNode;
  /**
   * Chrome-specific header action(s) — the maximize control (drawer) or
   * the minimize control (page) — mounted before the avatar so the
   * surface-toggle sits at the leading edge of the header.
   */
  leadingHeaderActions?: React.ReactNode;
  /**
   * Chrome-specific trailing control — the drawer's close button. The
   * page leaves this empty (it has no close affordance of its own).
   */
  trailingHeaderActions?: React.ReactNode;
  /**
   * Focus the composer on mount. The drawer sets this so the composer
   * takes focus when the sheet opens; the page sets it so a keyboard
   * user lands in the composer after the route change.
   */
  autoFocusComposer?: boolean;
  /**
   * Hands the chrome an imperative reset (abort any in-flight SSE +
   * clear the thread + composer). The drawer wires this to its close
   * handler so closing the overlay does not leave a stream running. The
   * page omits it — navigating away unmounts the whole subtree, which
   * tears the stream down on its own.
   */
  registerReset?: (reset: () => void) => void;
  /**
   * v1.16.1 — drawer-only: the "Conversations" affordance no longer
   * opens an in-panel left tray (it kept breaking inside the sheet);
   * it hands the user off to the full-page Coach route instead. The
   * drawer wires this to its maximize handler (close sheet + route);
   * the page omits it and renders the list inline / as a tray.
   */
  onRequestFullView?: () => void;
  /** className passthrough for the outer flex column. */
  className?: string;
  /** data-variant on the root, surfaced for e2e + styling hooks. */
  surface: "drawer" | "page";
  /**
   * v1.18.11 (W11, #67) — open a specific conversation on mount. The page
   * surface reads it from the `?c=` deep-link the dashboard Coach entry
   * carries, so a tap lands the user directly in that thread instead of a
   * blank new chat. Seeds the same `currentConversationId` the history
   * drawer drives, so the drawer's selection stays the single source of
   * truth; the URL param is just one more way to set it. Null/undefined
   * leaves the selection alone (new-chat, or auto-most-recent below).
   */
  initialConversationId?: string | null;
  /**
   * v1.18.11 (W11, #67) — when no `initialConversationId` is given, open
   * the user's MOST-RECENT conversation once the shared rail list resolves.
   * This is what makes the dashboard Coach entry land the user IN their
   * conversation cross-device: "most recent" is the server-authoritative
   * `updatedAt desc` head of `GET /api/insights/chat`, identical on web and
   * mobile — no client-only state. An account with no conversations falls
   * through to the new-chat hero. Resolves exactly once per mount so a later
   * "new chat" or thread switch is never overridden.
   */
  autoOpenMostRecent?: boolean;
  /**
   * v1.28.51 (Documents R3) / v1.29.x (S7) — seed a fresh chat with ONE stored
   * document attached. The `/coach?doc=<id>` deep-link (the detail sheet's "Ask
   * the Coach" action) passes it so the first turn is created + sent FENCED
   * (through the hardened `/api/insights/chat/fenced` endpoint) with that
   * document staged. Seeds the local `pendingAttachmentIds` for a not-yet-created
   * chat; once a thread exists the attachment set is read authoritatively from
   * the loaded conversation's `attachments` + sticky `fenced` flag instead.
   */
  initialDocumentId?: string | null;
  /**
   * v1.31.0 — the workout a FRESH conversation is scoped to ("Ask why" on the
   * workout-detail page, or `/coach?workout=<id>`). Threads onto the first
   * turn only, exactly like `launchScope`: once the thread exists the server
   * has already pinned the workout's evidence section onto its snapshot, so
   * re-sending it would be per-turn work that buys nothing. That gate is what
   * keeps snapshot-once intact.
   */
  initialWorkoutId?: string | null;
  /**
   * v1.28.52 (Documents R3) — hand the chrome an imperative getter for the
   * live conversation id (parallel to `registerReset`). The drawer reads it at
   * maximize time so it can hand off to `/coach?c=<id>` when a thread already
   * exists, falling back to `/coach?doc=<id>` for a pre-first-turn doc chat —
   * the surface-toggle preserves scope. The page omits it.
   */
  registerConversationIdGetter?: (getter: () => string | null) => void;
}

export function CoachConversation({
  prefill,
  launchScope,
  autoSend,
  renderTitle,
  renderDescription,
  leadingHeaderActions,
  trailingHeaderActions,
  autoFocusComposer,
  registerReset,
  onRequestFullView,
  className,
  surface,
  initialConversationId,
  autoOpenMostRecent = false,
  initialDocumentId,
  initialWorkoutId,
  registerConversationIdGetter,
}: CoachConversationProps) {
  const { t } = useTranslations();
  const router = useRouter();

  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(initialConversationId ?? null);
  const [activeWorkoutId, setActiveWorkoutId] = useState<string | null>(
    initialWorkoutId ?? null,
  );
  const [historyTrayOpen, setHistoryTrayOpen] = useState(false);
  const [sourcesTrayOpen, setSourcesTrayOpen] = useState(false);
  const [inputValue, setInputValue] = useResettableValue(prefill ?? "");
  // v1.16.4 — self-context backflow: `pendingAdopt` raises a quiet
  // offer to fold a clarifying-question answer back into the
  // Selbstauskunft. v1.16.5 — the answers now come from the guided
  // flow; `guidedIndex` routes the offer's outcome back into the
  // machine so the closing summary can say what was adopted.
  const [pendingAdopt, setPendingAdopt] = useState<{
    question: string;
    answer: string;
    guidedIndex: number;
  } | null>(null);

  // v1.16.5 — guided clarifying-questions flow (V2 of the v1.16.0
  // chips). The machine is pure (`guided-questions-machine.ts`); this
  // component owns the server round-trips: the pending-questions query
  // feeding the entry card, the per-question dismiss on answer, and
  // the dismiss-all behind "don't ask again".
  const [guided, dispatchGuided] = useReducer(guidedReducer, GUIDED_IDLE);
  const queryClient = useQueryClient();
  const { data: questionsData } = useQuery({
    queryKey: queryKeys.coachAboutMeQuestions(),
    queryFn: async () =>
      apiGet<{ questions: string[] }>("/api/coach/about-me/questions"),
    staleTime: 60_000,
  });
  const pendingQuestions = questionsData?.questions ?? [];
  const dismissQuestions = useMutation({
    mutationKey: queryKeys.coachAboutMeQuestions(),
    mutationFn: async (question?: string) =>
      apiDelete<{ questions: string[] }>(
        "/api/coach/about-me/questions",
        question === undefined ? {} : { question },
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.coachAboutMeQuestions(), next);
    },
    onError: () => {
      toast.error(t("insights.coach.guided.dismissError"));
    },
  });

  const { data: conversation } = useCoachConversation(currentConversationId);

  // v1.29.x (S7) — multi-document attachments. `pendingAttachmentIds` holds the
  // documents STAGED locally in the composer:
  //   • a not-yet-created chat → the full set to send FENCED on the first turn;
  //   • an existing conversation → uploads still being indexed, which auto-attach
  //     via the attach endpoint the moment their content index lands.
  // Seeds from the `/coach?doc=<id>` deep-link (a single document). Cleared on a
  // new chat / thread switch so a stale attachment can never leak onto a health
  // thread.
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>(
    initialDocumentId ? [initialDocumentId] : [],
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  // Whether the document-attach affordance is available at all (module-gated).
  const attachEnabled = useModuleEnabled("inboundDocuments");

  const attachDoc = useAttachCoachDocument(currentConversationId ?? "");
  const detachDoc = useDetachCoachDocument(currentConversationId ?? "");

  const send = useSendCoachMessage({
    onDone: (resolvedId) => {
      setCurrentConversationId(resolvedId);
    },
  });

  // v1.29.x (S7) — the SERVER-AUTHORITATIVE fence. For an existing conversation
  // the sticky `fenced` flag on the loaded DTO decides; for a not-yet-created
  // chat the presence of any staged attachment makes it fenced. A stale client
  // can never mis-route an already-fenced conversation to the tool route because
  // the existing-conversation branch reads the server flag, never local state.
  const serverAttachments = conversation?.attachments ?? [];
  const fenced =
    currentConversationId !== null
      ? (conversation?.fenced ?? false)
      : pendingAttachmentIds.length > 0;

  // Resolve title + indexed status for every locally-staged id (the server
  // attachments already carry their titles). Un-indexed docs poll until their
  // content index lands (freshly-uploaded documents index in the background).
  const stagedDetailResults = useQueries({
    queries: pendingAttachmentIds.map((id) => ({
      queryKey: queryKeys.inboundDocument(id),
      queryFn: async () =>
        apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${id}`),
      staleTime: 15_000,
      refetchInterval: (query: {
        state: { data?: InboundDocumentDetailDto };
      }) =>
        query.state.data && !query.state.data.hasContentIndex ? 2500 : false,
    })),
  });
  const stagedDetailById = new Map<
    string,
    InboundDocumentDetailDto | undefined
  >();
  pendingAttachmentIds.forEach((id, i) => {
    stagedDetailById.set(id, stagedDetailResults[i]?.data);
  });
  const isStagedIndexed = (id: string): boolean =>
    stagedDetailById.get(id)?.hasContentIndex === true;
  const stagedTitle = (id: string): string => {
    const d = stagedDetailById.get(id);
    return d?.title ?? d?.filename ?? t("documents.card.untitled");
  };

  // v1.29.x — a stale/invalid `?doc=<id>` deep-link (a deleted document, a
  // mistyped id, someone else's document) 404s the detail fetch above
  // forever. `refetchInterval` reads `false` once a query has no data, so the
  // fetch never retries on its own — `isStagedIndexed` stayed permanently
  // false and the fenced send-gate (`fenced && anyPendingUnindexed` below)
  // trapped every message behind a phantom "untitled" attachment that could
  // never resolve. Drop a staged id the moment its detail fetch settles into
  // an error instead: the doc-scope clears, the banner disappears, and the
  // surface degrades to a normal chat rather than a dead end.
  //
  // The drop itself runs in the render-phase-update pattern (mirrors
  // `autoOpenResolved` below) rather than an effect: `react-hooks/set-state-
  // in-effect` rejects a setState call inside an effect whose source is a
  // query result. It is self-limiting without a ref guard: once an id drops
  // out of `pendingAttachmentIds`, React's render-phase-update loop
  // re-renders BEFORE committing, and on that re-render the id is no longer
  // in `pendingAttachmentIds` at all, so `dropInvalidStagedAttachments` can
  // never surface it again. The toast is the one genuine side effect and
  // stays in its own effect (no setState inside it), keyed on the ids just
  // dropped so it fires exactly once per distinct drop.
  const invalidStagedIds = dropInvalidStagedAttachments(
    pendingAttachmentIds,
    stagedDetailResults.map((q) => q.isError === true),
  );
  const [invalidToastKey, setInvalidToastKey] = useState("");
  if (invalidStagedIds.length > 0) {
    setPendingAttachmentIds((prev) =>
      prev.filter((id) => !invalidStagedIds.includes(id)),
    );
    const key = invalidStagedIds.join(",");
    if (key !== invalidToastKey) setInvalidToastKey(key);
  }
  useEffect(() => {
    if (!invalidToastKey) return;
    toast.error(t("insights.coach.attach.notFoundError"));
  }, [invalidToastKey, t]);

  // The pills row above the composer. On a fresh chat every pill is a staged id;
  // on an existing conversation the server attachments are the live pills and any
  // staged uploads (still indexing) render alongside them.
  const attachmentPills: AttachmentPillItem[] =
    currentConversationId === null
      ? pendingAttachmentIds.map((id) => ({
          documentId: id,
          title: stagedTitle(id),
          indexing: !isStagedIndexed(id),
        }))
      : [
          ...serverAttachments.map((a) => ({
            documentId: a.documentId,
            title: a.title ?? t("documents.card.untitled"),
            indexing: false,
          })),
          ...pendingAttachmentIds.map((id) => ({
            documentId: id,
            title: stagedTitle(id),
            indexing: true,
          })),
        ];

  const anyPendingUnindexed = pendingAttachmentIds.some(
    (id) => !isStagedIndexed(id),
  );

  // Cap bookkeeping: how many documents already count, and the free slots the
  // picker / upload path may still fill.
  const liveAttachmentCount =
    currentConversationId === null
      ? pendingAttachmentIds.length
      : serverAttachments.length + pendingAttachmentIds.length;
  const remainingSlots = Math.max(
    0,
    MAX_COACH_ATTACHMENTS - liveAttachmentCount,
  );
  const excludeIds = [
    ...pendingAttachmentIds,
    ...serverAttachments.map((a) => a.documentId),
  ];

  // v1.29.x (S7) — once a staged UPLOAD finishes indexing on an EXISTING
  // conversation, promote it to a real attachment via the attach endpoint and
  // drop it from the local staging set. The ref guards against a double-mutate
  // while the request is in flight. The effect is keyed on a stable string of
  // the ready-to-attach ids (recomputed in render) so it fires only when the
  // set of indexed-and-staged documents actually changes.
  const attachingRef = useRef<Set<string>>(new Set());
  const readyToAttachIds =
    currentConversationId !== null
      ? pendingAttachmentIds.filter((id) => isStagedIndexed(id))
      : [];
  const readyToAttachKey = readyToAttachIds.join(",");
  useEffect(() => {
    if (!readyToAttachKey) return;
    for (const id of readyToAttachKey.split(",")) {
      if (attachingRef.current.has(id)) continue;
      attachingRef.current.add(id);
      attachDoc.mutate(id, {
        onSettled: () => {
          attachingRef.current.delete(id);
          setPendingAttachmentIds((prev) => prev.filter((x) => x !== id));
        },
      });
    }
  }, [readyToAttachKey, attachDoc]);

  function handleRemoveAttachment(documentId: string) {
    // A staged id (fresh chat, or an upload not yet attached) is local state.
    if (pendingAttachmentIds.includes(documentId)) {
      setPendingAttachmentIds((prev) => prev.filter((x) => x !== documentId));
      return;
    }
    // An already-attached document on an existing conversation → detach endpoint.
    if (currentConversationId !== null) {
      detachDoc.mutate(documentId);
    }
  }

  function handlePickFromVault(ids: string[]) {
    if (currentConversationId === null) {
      // Fresh chat: stage them for the first-turn attach (deduped + capped).
      setPendingAttachmentIds((prev) =>
        Array.from(new Set([...prev, ...ids])).slice(0, MAX_COACH_ATTACHMENTS),
      );
      return;
    }
    // Existing conversation: the picker only offers indexed documents, so attach
    // each straight away — the server flips the sticky fenced flag.
    for (const id of ids) attachDoc.mutate(id);
  }

  async function handleUploadNew(files: File[]) {
    const toUpload = files.slice(0, remainingSlots);
    for (const file of toUpload) {
      const form = new FormData();
      form.append("file", file);
      let response: Response;
      try {
        response = await apiFetchRaw("/api/documents/inbound", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: form,
        });
      } catch {
        toast.error(t("insights.coach.attach.uploadError"));
        continue;
      }
      const parsed = parseUploadResponse(
        response.status,
        await response.text(),
      );
      if (!parsed.ok) {
        toast.error(t("insights.coach.attach.uploadError"));
        continue;
      }
      const doc = parsed.document;
      // Reflect the new document in the vault + seed its detail so the pill
      // resolves its title immediately (it indexes in the background).
      queryClient.invalidateQueries({
        queryKey: queryKeys.documents(),
      });
      queryClient.setQueryData(queryKeys.inboundDocument(doc.id), doc);
      setPendingAttachmentIds((prev) =>
        prev.includes(doc.id) ? prev : [...prev, doc.id],
      );
    }
  }

  // v1.18.11 (W11, #67) — auto-open the most-recent conversation when the
  // surface mounts with no explicit selection. Only fetches the rail list
  // when the behaviour is requested AND no deep-linked id was supplied, so
  // the drawer's default new-chat mount pays nothing for it.
  const autoOpenEnabled = autoOpenMostRecent && !initialConversationId;
  const { conversations: railConversations } =
    useCoachConversations(autoOpenEnabled);
  // Resolve once per mount via the in-render setState pattern (the
  // `react-hooks/set-state-in-effect` rule rejects setState inside an effect
  // when the source is a query result; see `coach-prefs-section.tsx`). The
  // latch flips the first time the rail list arrives so a subsequent "new
  // chat" or thread switch is never clobbered by a late list refetch.
  const [autoOpenResolved, setAutoOpenResolved] = useState(false);
  if (autoOpenEnabled && !autoOpenResolved && railConversations.length > 0) {
    setAutoOpenResolved(true);
    // Server-authoritative `updatedAt desc` head = the same thread the rail
    // shows first, identical on every device.
    setCurrentConversationId(railConversations[0].id);
  }

  // Hand the chrome an imperative reset so the drawer can abort the
  // in-flight SSE stream + clear the thread on close. Re-registered when
  // the closed-over state setters / send hook change identity so the
  // callback never captures a stale conversation id.
  useEffect(() => {
    if (!registerReset) return;
    registerReset(() => {
      send.cancel();
      setCurrentConversationId(null);
      setInputValue("");
      setPendingAdopt(null);
      dispatchGuided({ type: "RESET" });
    });
  }, [registerReset, send, setInputValue]);

  // v1.28.52 (Documents R3) — expose the live conversation id imperatively so
  // the drawer chrome can read it at maximize time (it lives inside this
  // surface, not the chrome). A latest-value ref keeps the registered getter
  // stable while always returning the current thread id, so maximize hands off
  // to `/coach?c=<id>` once a turn has created the thread.
  const conversationIdRef = useRef<string | null>(currentConversationId);
  useEffect(() => {
    conversationIdRef.current = currentConversationId;
  });
  useEffect(() => {
    if (!registerConversationIdGetter) return;
    registerConversationIdGetter(() => conversationIdRef.current);
  }, [registerConversationIdGetter]);

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || send.isStreaming) return;
    // v1.29.x (S7) — a fenced turn cannot go out while a staged attachment is
    // still being indexed: the fenced endpoint 422s on an un-indexed document,
    // so mirror that gate client-side (the composer shows the "still indexing"
    // hint). The server edge is the real wall; this is the honest UI mirror.
    if (fenced && anyPendingUnindexed) return;
    // v1.16.5 — in the guided flow the composer message IS the answer
    // to the current question. Mark it answered before the send so the
    // question bubble anchors above the user's message, and dismiss the
    // question server-side — answered questions never return.
    const guidedQuestion =
      guided.phase === "asking" ? guided.questions[guided.index] : null;
    const guidedIndex = guided.phase === "asking" ? guided.index : null;
    if (guidedQuestion !== null) {
      dispatchGuided({ type: "ANSWER_SUBMITTED", answer: trimmed });
      dismissQuestions.mutate(guidedQuestion);
    }
    setInputValue("");
    // v1.21.0 (C4 H1/H4) — attach the launch scope to the FIRST turn of a
    // fresh conversation so a chat opened from a metric surface / insight
    // card reads a snapshot narrowed to the relevant source(s). A continued
    // thread (existing id) keeps its own established scope, so we omit it.
    const scope =
      currentConversationId === null
        ? launchScopeToCoachScope(launchScope)
        : undefined;
    // v1.16.6 — hand the question to the turn so the Coach reaction is
    // contextual (the question bubble itself is never persisted).
    // v1.29.x (S7) — `fenced` + `pendingAttachmentIds` route a fenced turn
    // through the hardened `/api/insights/chat/fenced` endpoint (see
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
      // v1.16.6 — sequence per answer: answer → Coach reaction
      // (streamed above) → adopt offer → next question. A resolved id
      // means the reaction landed; the machine then advances when the
      // adopt offer settles (ADOPTION_SETTLED). A null id is the
      // provider-less / errored turn — no reaction is coming, so keep
      // the original silent flow and advance immediately.
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

  // v1.22 — "Try again": regenerate an assistant reply by resubmitting the
  // user turn that produced it as a FRESH turn. The composer value is left
  // untouched (unlike `handleSubmit`, which clears it) so a half-typed
  // follow-up survives a regenerate. The existing thread is the conversation
  // context, so the new turn continues it rather than forking.
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

  function handleNewChat() {
    setCurrentConversationId(null);
    setInputValue("");
    setPendingAdopt(null);
    // v1.29.x (S7) — a new chat is always a health thread; drop any staged
    // attachments so a fenced scope can never leak onto a fresh health thread.
    setPendingAttachmentIds([]);
    setActiveWorkoutId(null);
    dispatchGuided({ type: "RESET" });
    send.reset();
  }

  const title = conversation?.title ?? t("insights.coach.newChat");
  const tagline = t("insights.coach.tagline");

  // v1.16.5 — materialise the machine's thread items into bubbles. The
  // thread only places them (`placeInterleaved`); every behaviour stays
  // here with the flow.
  const interleaved: InterleavedThreadItem[] = deriveThreadItems(guided).map(
    (item) => ({
      key: item.key,
      anchorAnswer: item.anchorAnswer,
      node:
        item.kind === "summary" ? (
          <GuidedSummaryBubble
            answered={item.summary?.answered ?? 0}
            adopted={item.summary?.adopted ?? 0}
            total={item.summary?.total ?? 0}
          />
        ) : (
          <GuidedQuestionBubble
            question={item.question ?? ""}
            progress={item.progress ?? { current: 1, total: 1 }}
            current={item.current}
            actionsDisabled={send.isStreaming || dismissQuestions.isPending}
            onSkip={
              item.current ? () => dispatchGuided({ type: "SKIP" }) : undefined
            }
            onLater={
              item.current ? () => dispatchGuided({ type: "EXIT" }) : undefined
            }
            onDismissRemaining={
              item.current
                ? () =>
                    dismissQuestions.mutate(undefined, {
                      onSuccess: () => dispatchGuided({ type: "EXIT" }),
                    })
                : undefined
            }
          />
        ),
    }),
  );

  // v1.18.9 — the live composer, lifted so it can mount in the new-chat
  // hero (centred) OR docked at the bottom of the conversation without
  // forking any composer logic (dictation, auto-grow, send/stop, the
  // guided-question placeholder all behave identically in both spots).
  //
  // v1.18.11 (W11) — on the page surface the composer is the control hub:
  // it grows a leading `+` actions menu (new chat + open conversations) and
  // a settings deep-link. The drawer keeps its own header for those, so the
  // hub is page-only.
  // v1.29.x (S7) — the composer with its attachment chrome: the pills row + the
  // "still indexing" hint stack directly above the input, so they travel with
  // the composer into BOTH the new-chat hero and the docked conversation view.
  const composerNode = (
    <div className="flex flex-col gap-2">
      <AttachmentPills
        items={attachmentPills}
        onRemove={handleRemoveAttachment}
        disabled={send.isStreaming}
      />
      {fenced && anyPendingUnindexed ? (
        <p
          data-slot="coach-attach-indexing-hint"
          className="text-muted-foreground px-1 text-xs"
        >
          {t("insights.coach.attach.indexingHint")}
        </p>
      ) : null}
      <CoachInput
        value={inputValue}
        onChange={setInputValue}
        onSubmit={() => handleSubmit(inputValue)}
        onCancel={send.cancel}
        disabled={send.isStreaming}
        isStreaming={send.isStreaming}
        autoFocusOnOpen={autoFocusComposer}
        placeholder={
          guided.phase === "asking"
            ? t("insights.coach.guided.answerPlaceholder")
            : undefined
        }
        showHub={surface === "page"}
        onNewChat={handleNewChat}
        onOpenHistory={() => router.push("/coach/conversations")}
        attachEnabled={attachEnabled}
        onPickFromVault={() => setPickerOpen(true)}
        onUploadNew={handleUploadNew}
      />
    </div>
  );

  // v1.18.9 — the centred new-chat hero replaces the cramped empty thread
  // on the PAGE surface only. It shows exactly when the surface is a fresh,
  // untouched new chat: no selected conversation, nothing streaming or
  // optimistic, no error, and none of the guided / adopt / pending-question
  // affordances in play (those belong in the docked conversation flow). The
  // first send flips `send.isStreaming` / `send.optimisticUser`, so the hero
  // unmounts and the docked thread + bottom composer take over.
  const heroActive =
    surface === "page" &&
    currentConversationId === null &&
    !send.isStreaming &&
    !send.streaming.content &&
    !send.streaming.errorCode &&
    !send.optimisticUser &&
    guided.phase === "idle" &&
    pendingQuestions.length === 0 &&
    !pendingAdopt;

  // v1.21.2 (A2 + A3) — the visible scope/opener affordance for the hero.
  //
  // A2 (scoped launch): the Coach was opened narrowed to a metric. Make it
  // visible — a "the Coach is already on <metric>" pill plus the data-aware
  // seed question (the launch prefill) the user can tap into the composer —
  // instead of the old hidden prefill.
  //
  // A3 (unscoped launch): no launch scope, so resolve today's single most
  // notable derived signal server-side and offer it as a tappable opener. The
  // query only fires when the hero is on screen AND there is no launch scope
  // (an A2 launch already has its opener), so a scoped open pays nothing for
  // it. When the server returns no signal the hint is null and the neutral
  // greeting stands — never a fabricated opener.
  const a2Metric = launchScope?.metric ?? null;
  // v1.21.4 (C2) — once the user dismisses today's seeded opener it stays gone
  // for the rest of the local calendar day; the fetch is skipped too, so a
  // dismissed day costs nothing. SSR-safe lazy init guards `window`.
  const [seededDismissedToday, setSeededDismissedToday] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(seededDismissStorageKey()) === "1";
    } catch {
      return false;
    }
  });
  // v1.25.0 — the per-user opt-out for proactive ambient suggestions gates the
  // seeded opener (and skips its fetch when off). The A2 launch scope below is
  // NOT ambient — it reflects how the chat was opened — so it stays unaffected.
  const ambientSuggestionsEnabled = useCoachAmbientSuggestionsEnabled();
  const seededEnabled =
    heroActive &&
    a2Metric === null &&
    !seededDismissedToday &&
    ambientSuggestionsEnabled;
  const { data: seeded } = useQuery({
    queryKey: queryKeys.coachSeededQuestion(),
    queryFn: async () =>
      apiGet<CoachSeededQuestionDTO>("/api/insights/coach/seeded-question"),
    enabled: seededEnabled,
    staleTime: 5 * 60 * 1000,
  });

  function seedComposer(question: string) {
    setInputValue(question);
  }

  function dismissSeeded() {
    setSeededDismissedToday(true);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(seededDismissStorageKey(), "1");
    } catch {
      // Storage can throw (private mode / quota); the in-memory flag still
      // hides the opener for this session.
    }
  }

  // `t()` returns the key string itself when a key is missing, so the only
  // reliable "is this key defined" signal is `t(key) !== key`.
  function tOrNull(key: string): string | null {
    const resolved = t(key);
    return resolved === key ? null : resolved;
  }

  // The resolved A2 metric label: prefers a per-source i18n key, falls back
  // to the brand-free English domain phrase so every source has a label.
  // Hoisted so both the hero hint (page) and the sources rail (drawer) read
  // the same string. Null when the launch carried no metric.
  const a2LabelKey = scopeSourceMetricLabelKey(a2Metric);
  const a2MetricLabel = a2Metric
    ? (tOrNull(`insights.coach.scope.metric.${a2Metric}`) ??
      (a2LabelKey ? tOrNull(a2LabelKey) : null) ??
      metricScopeLabelFallback(a2Metric) ??
      a2Metric)
    : null;

  let scopeHint: React.ReactNode = null;
  if (fenced) {
    // v1.29.x (S7) — a fenced conversation has NO health snapshot to scope, so
    // the A2/A3 "the Coach is already on <metric>" openers are suppressed. The
    // honest fencing banner (below) is the only chrome the fenced hero shows.
    scopeHint = null;
  } else if (a2Metric && a2MetricLabel) {
    // A2 — the launch prefill IS the data-aware opener; fall back to the
    // generic per-metric question when the launch carried no prefill.
    const seedQuestion =
      (prefill ?? "").trim() || t("insights.coach.scope.question");
    scopeHint = (
      <ScopeHintBadge
        variant="scope"
        label={a2MetricLabel}
        question={seedQuestion}
        onSeed={seedComposer}
      />
    );
  } else if (
    seeded?.signal &&
    !seededDismissedToday &&
    ambientSuggestionsEnabled
  ) {
    // A3 — the notable derived signal. The label + opener are keyed on the
    // signal's sourceMetric (`readiness` / `recovery`); an unknown sentinel
    // (future detector additions) skips the opener rather than guessing.
    const sentinel = seeded.signal.sourceMetric;
    const signalLabel = tOrNull(`insights.coach.seeded.signal.${sentinel}`);
    const signalQuestion = tOrNull(
      `insights.coach.seeded.question.${sentinel}`,
    );
    if (signalLabel && signalQuestion) {
      scopeHint = (
        <ScopeHintBadge
          variant="seeded"
          label={signalLabel}
          question={signalQuestion}
          onSeed={seedComposer}
          onDismiss={dismissSeeded}
        />
      );
    }
  }

  // v1.18.11 (W11) — the docked composer column: the quiet adopt offer and
  // the guided-questions entry card stack above the live composer. Shared by
  // the drawer body (via `CoachDrawerBody`) and the page surface (rendered
  // directly), so the two surfaces stay byte-identical above the composer.
  const composerStack = (
    <div>
      {/* v1.16.4 — quiet adopt-into-self-context offer once a clarifying
          question has been answered. Self-removes after settle; v1.16.5
          reports the outcome back into the guided machine for the closing
          summary. */}
      {pendingAdopt && !send.isStreaming && !fenced ? (
        <SelfContextAdoptOffer
          question={pendingAdopt.question}
          answer={pendingAdopt.answer}
          onDismiss={() => setPendingAdopt(null)}
          onSettled={(adoption) =>
            dispatchGuided({
              type: "ADOPTION_SETTLED",
              index: pendingAdopt.guidedIndex,
              adoption,
            })
          }
        />
      ) : null}
      {/* v1.16.5 — guided clarifying-questions entry card (V2 of the
          v1.16.0 chips). Offers the in-chat sequence while questions pend
          and the flow hasn't started. */}
      {guided.phase === "idle" && pendingQuestions.length > 0 && !fenced ? (
        <GuidedQuestionsCard
          count={pendingQuestions.length}
          disabled={send.isStreaming || dismissQuestions.isPending}
          onStart={() =>
            dispatchGuided({
              type: "START",
              questions: pendingQuestions,
            })
          }
          onLater={() => dispatchGuided({ type: "LATER" })}
          onDismissAll={() =>
            dismissQuestions.mutate(undefined, {
              onSuccess: () => dispatchGuided({ type: "LATER" }),
            })
          }
        />
      ) : null}
      {composerNode}
    </div>
  );

  // v1.29.x (S7) — the fenced-conversation banner. The moment a conversation is
  // fenced (server sticky flag, or ≥1 staged attachment on a fresh chat) this
  // states plainly that the coach runs WITHOUT access to health data and reads
  // ONLY the attached documents, and counts the attachments. Rendered in BOTH
  // surfaces (page + drawer) above the thread so the fence is always visible.
  // Null on a normal health thread.
  // v1.29.1 — name the attached document(s) in the banner so returning to a
  // fenced thread later is clear about what it is about, instead of a generic
  // "N documents attached". One doc → its title; two → both, comma-joined
  // through the reused `docScope.chattingAbout` phrasing; three or more → the
  // first two plus an "and N more" tail. Falls back to the plain count only when
  // no title has resolved yet (a sticky-fenced thread whose attachment is still
  // in flight), so the banner is never empty.
  const attachedTitles = attachmentPills.map((pill) => pill.title);
  const attachedCount = attachedTitles.length;
  const docScopeText =
    attachedCount === 0
      ? t("insights.coach.attach.documentsAttachedOther", { count: 0 })
      : attachedCount <= 2
        ? t("insights.coach.docScope.chattingAbout", {
            title: attachedTitles.join(", "),
          })
        : t("insights.coach.docScope.chattingAboutMore", {
            titles: attachedTitles.slice(0, 2).join(", "),
            count: attachedCount - 2,
          });
  const docScopeBanner = fenced ? (
    <div
      data-slot="coach-doc-scope"
      className="border-border/70 bg-muted/20 flex shrink-0 flex-col gap-1 border-b px-4 py-2 sm:px-6"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="bg-primary/15 text-primary inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium">
          <Paperclip className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{docScopeText}</span>
        </span>
      </div>
      <p className="text-muted-foreground text-xs leading-snug">
        {t("insights.coach.attach.fencedHint")}
      </p>
      {anyPendingUnindexed ? (
        <p className="text-muted-foreground text-xs leading-snug">
          {t("insights.coach.attach.indexingHint")}
        </p>
      ) : null}
    </div>
  ) : null;

  // v1.18.11 (W11) — the PAGE surface drops the top header bar and the
  // rail-tray strip entirely. The composer is the single control hub; the
  // thread (`[&>*]:max-w-2xl` inner gutter) and the docked composer
  // (`mx-auto max-w-2xl`) share ONE centred, max-width-capped column so the
  // composer never changes width between the new-chat hero and an active
  // conversation. The drawer surface keeps its own header + body chrome
  // (handled below) untouched.
  if (surface === "page") {
    return (
      <div
        data-slot="coach-conversation"
        data-variant={surface}
        className={cn("flex min-h-0 flex-1 flex-col", className)}
      >
        {docScopeBanner}
        {!heroActive ? <h1 className="sr-only">{title}</h1> : null}
        {/* v1.21.4 (A) — the page-toolbar gear was removed; Settings now lives
            in the composer's `+` actions menu alongside New chat and
            Conversations, keeping the page chrome to the composer alone. */}
        {heroActive ? (
          <CoachHero composer={composerNode} scopeHint={scopeHint} />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col">
              <MessageThread
                conversation={conversation ?? null}
                streaming={send.streaming}
                optimisticUser={send.optimisticUser}
                interleaved={interleaved}
                onRegenerate={handleRegenerate}
              />
            </div>
            {/* Docked composer — the SAME centred, capped column as the
                thread (and the hero composer), so the width is constant
                across the new-chat → conversation transition. */}
            <div
              data-slot="coach-page-composer"
              className="shrink-0 px-4 pt-2 pb-3 sm:px-6 sm:pb-4"
            >
              <div className="mx-auto w-full max-w-2xl">{composerStack}</div>
            </div>
          </>
        )}
        {attachEnabled ? (
          <AttachmentPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            remainingSlots={remainingSlots}
            excludeIds={excludeIds}
            onConfirm={handlePickFromVault}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-slot="coach-conversation"
      data-variant={surface}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <header
        data-slot="coach-conversation-header"
        // v1.18.1 (W-COACH-UI C2/C4) — the header used to crowd a bare
        // leading ghost-icon flush against the avatar (the "minimal"
        // element the maintainer disliked). The surface-toggle now sits
        // in its own leading cluster separated by a hairline divider, the
        // avatar steps up to `size-9`, and the band locks to `h-14` so
        // its bottom border shares the horizontal line with the body's
        // rail-tray strip + history-rail heading one row below.
        className="border-border/70 flex h-14 shrink-0 flex-row items-center gap-2.5 border-b px-3 sm:px-4"
      >
        {leadingHeaderActions ? (
          <div className="border-border/60 -ml-1 flex items-center gap-1 pr-1 sm:border-r sm:pr-2.5">
            {leadingHeaderActions}
          </div>
        ) : null}
        <div
          aria-hidden="true"
          className="from-primary to-brand-pink flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br shadow-sm"
        >
          <Sparkles className="text-background size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {renderTitle ? (
            renderTitle(title)
          ) : (
            <p className="min-w-0 truncate text-sm font-semibold">{title}</p>
          )}
          {renderDescription ? (
            renderDescription(tagline)
          ) : (
            <p className="text-muted-foreground truncate text-xs">{tagline}</p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleNewChat}
          data-slot="coach-new-chat"
          aria-label={t("insights.coach.newChat")}
          title={t("insights.coach.newChat")}
          className="text-muted-foreground hover:text-foreground size-11 shrink-0"
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
        {/* v1.16.1 — the Coach preferences moved into Settings → AI
            (one place for model + behaviour). The header keeps a gear
            that deep-links there instead of opening an in-chat sheet. */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          data-slot="coach-settings"
          className="text-muted-foreground hover:text-foreground size-11 shrink-0"
        >
          <Link
            href="/settings/ai"
            aria-label={t("insights.coach.settingsAriaLabel")}
            title={t("insights.coach.settingsAriaLabel")}
          >
            <Settings className="size-4" aria-hidden="true" />
          </Link>
        </Button>
        {trailingHeaderActions}
      </header>

      {docScopeBanner}

      {/* Drawer surface keeps its existing body chrome: thread + rail-tray
          strip + docked composer, with the conversation list + sources as
          mobile trays. The "Conversations" affordance hands off to the
          full-page route (in-panel left tray kept breaking inside the
          sheet). The page surface is handled above and never reaches here. */}
      <CoachDrawerBody
        thread={
          <MessageThread
            conversation={conversation ?? null}
            streaming={send.streaming}
            optimisticUser={send.optimisticUser}
            interleaved={interleaved}
            onRegenerate={handleRegenerate}
          />
        }
        composer={composerStack}
        onHistoryClick={onRequestFullView ?? (() => setHistoryTrayOpen(true))}
        onOpenSourcesTray={() => setSourcesTrayOpen(true)}
      />

      <MobileRailTray
        historyOpen={historyTrayOpen}
        onHistoryOpenChange={setHistoryTrayOpen}
        historyRail={
          <HistoryRail
            activeId={currentConversationId}
            onSelect={(id) => {
              setCurrentConversationId(id);
              setHistoryTrayOpen(false);
              setPendingAdopt(null);
              // v1.29.x (S7) — the selected thread's own `fenced` flag +
              // `attachments` are now authoritative; drop any staged `?doc=`
              // seed so a pending attachment can't leak across a thread switch.
              setPendingAttachmentIds([]);
              dispatchGuided({ type: "RESET" });
            }}
          />
        }
        sourcesOpen={sourcesTrayOpen}
        onSourcesOpenChange={setSourcesTrayOpen}
        sourcesRail={
          <SourcesRail
            // v1.21.2 (A2) — surface the launch scope on the drawer surface;
            // only set for a fresh, scoped, not-yet-sent conversation so a
            // continued thread (its own established scope) shows no stale line.
            activeScopeLabel={
              currentConversationId === null ? a2MetricLabel : null
            }
          />
        }
      />

      {attachEnabled ? (
        <AttachmentPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          remainingSlots={remainingSlots}
          excludeIds={excludeIds}
          onConfirm={handlePickFromVault}
        />
      ) : null}
    </div>
  );
}
