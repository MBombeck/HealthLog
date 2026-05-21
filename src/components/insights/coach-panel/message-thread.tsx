"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { scrollBehaviorForUser } from "@/lib/motion";
import { useTranslations } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { useAuth } from "@/hooks/use-auth";

import { SourceChips } from "./source-chips";
import type {
  CoachConversationDetailDTO,
  CoachOptimisticUserMessage,
  CoachStreamingMessage,
} from "./use-coach";
import type { CoachMessageDTO } from "@/lib/ai/coach/types";

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
}

function isPinnedToBottom(el: HTMLElement, slack = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * v1.4.25 W5 — map server-emitted error codes to specific Coach i18n
 * keys. The chat route distinguishes the daily user-quota
 * (`coach.budget.exceeded`, returned as a JSON 429) from the provider
 * rate-limit (`coach.provider.rate_limited`, streamed as an SSE error
 * frame). Both used to surface as the generic provider-unavailable
 * copy; we now route each to its dedicated translation so the user
 * understands whether the limit is on their side (reset at UTC
 * midnight) or transient on the provider side (retry in ~5 min).
 *
 * Exported so the resolver can be pinned by unit tests without
 * standing up the whole thread renderer.
 */
export function errorCodeToI18nKey(code: string): string {
  switch (code) {
    case "coach.budget.exceeded":
      return "insights.coach.dailyLimitBody";
    case "coach.provider.rate_limited":
      return "insights.coach.providerRateLimitBody";
    case "coach.provider.unavailable":
    case "coach.provider.empty":
    case "coach.provider.none":
    case "coach.network":
    case "coach.stream":
      return "insights.coach.errorProvider";
    default:
      // Forward-compat: try `insights.coach.<code>` for codes that
      // ship their own translation (e.g. legacy `errorProvider`).
      return `insights.coach.${code}`;
  }
}

export function MessageThread({
  conversation,
  streaming,
  optimisticUser,
  emptyHint,
}: MessageThreadProps) {
  const { t } = useTranslations();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasPinnedRef = useRef(true);

  // v1.4.27 F14 — the evidence disclosure used to honour an opt-in
  // `coachPrefs.showEvidenceByDefault` flag that surfaced the raw
  // measurement values unconditionally. The flag created an UX trap
  // (Marc 2026-05-15: "literal metric values exposed under every
  // bubble") so the disclosure is now collapsed by default for every
  // reply. The user expands by click; the pref is retired in the
  // settings sheet so nothing flips it back on.

  const messages: CoachMessageDTO[] = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages],
  );
  // v1.4.20.1 — once the SSE stream emits `done`, the route's
  // invalidate-then-refetch pulls the persisted assistant message into
  // `conversation.messages`. The streaming bubble was still rendering
  // because the hook keeps `streaming.content` populated to support
  // the in-flight render path; the result was two assistant bubbles
  // side by side until the next `send` reset the streaming state.
  // Suppress the streaming bubble at render time as soon as the
  // persisted twin lands — comparing on `messageId` keeps the
  // transition seamless while never accidentally hiding an in-flight
  // bubble (during streaming `messageId` is null).
  // v1.4.22 W5 reconcile (Code-MED-3) — streaming/persisted-twin
  // race. On slow connections SSE `done` fires before the
  // invalidate-refetch resolves; the persisted twin lands while the
  // streaming bubble is still painted, producing a 200-500ms
  // duplicate render. Hide the persisted twin (matched on
  // streaming.messageId) for a 150ms grace window after it first
  // appears so the streaming bubble stays alone until the streaming
  // state cleans up naturally on the next `send`.
  const [graceWindow, setGraceWindow] = useState(false);
  const lastPersistedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const persistedId = streaming?.messageId ?? null;
    if (
      persistedId &&
      persistedId !== lastPersistedIdRef.current &&
      messages.some((m) => m.id === persistedId)
    ) {
      lastPersistedIdRef.current = persistedId;
      setGraceWindow(true);
      const handle = setTimeout(() => setGraceWindow(false), 150);
      return () => clearTimeout(handle);
    }
  }, [streaming?.messageId, messages]);
  const suppressedTwinId = graceWindow ? streaming?.messageId : null;

  const streamingPersisted =
    !graceWindow &&
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

  // Track scroll position so we don't yank the viewport when the user
  // is browsing earlier turns.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasPinnedRef.current = isPinnedToBottom(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new messages OR streaming-content growth, but only
  // when the user was already at the bottom. v1.4.25 W5 — the
  // optimistic user bubble counts as a new message; scroll on its
  // localId so the user sees their own bubble land at the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (wasPinnedRef.current) {
      // v1.4.43 W5-H5 — respect `prefers-reduced-motion`.
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehaviorForUser() });
    }
  }, [messages.length, streaming?.content, optimisticUser?.localId]);

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

  if (messages.length === 0 && !streamingActive && !optimisticActive) {
    return (
      <div
        data-slot="coach-message-thread"
        className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <div
          aria-hidden="true"
          className="from-dracula-purple to-dracula-pink flex size-12 items-center justify-center rounded-full bg-gradient-to-br"
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
    <div
      ref={scrollerRef}
      data-slot="coach-message-thread"
      className={cn(
        "flex h-full flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6",
        "scroll-smooth",
      )}
    >
      {messages.map((m) => {
        // v1.4.22 W5 reconcile (Code-MED-3) — suppress the persisted
        // twin during the 150ms grace window so the streaming bubble
        // stays alone on slow connections.
        if (m.id === suppressedTwinId) return null;
        return (
          <ChatBubble
            key={m.id}
            role={m.role}
            content={m.content}
            metricSource={m.metricSource}
            providerType={m.providerType}
            messageId={m.id}
          />
        );
      })}
      {/* v1.4.25 W5 — optimistic user bubble surfaces between the
          persisted history and the streaming assistant placeholder so
          the visible order matches the user's mental model. The
          send-hook drops it as soon as the SSE `done` frame fires +
          the invalidate-refetch lands the persisted twin. */}
      {optimisticActive && optimisticUser && (
        <ChatBubble
          key={optimisticUser.localId}
          role="user"
          content={optimisticUser.content}
        />
      )}
      {streamingActive && streaming && (
        // role=log + aria-live=polite so screen-reader users hear the
        // assistant prose announce as tokens land. aria-relevant=text
        // limits announcements to the streamed content; additions
        // covers the bubble-mount edge case.
        <div role="log" aria-live="polite" aria-relevant="additions text">
          <ChatBubble
            role="assistant"
            content={streaming.content}
            metricSource={streaming.metricSource}
            providerType={streaming.inProgress ? "streaming" : null}
            inProgress={streaming.inProgress}
            errorCode={streaming.errorCode}
          />
        </div>
      )}
      {/* v1.4.22 W5 reconcile (Design-H3) — medical-disclaimer
          reach regression. v1.4.22 B4 moved the disclaimer to the
          sources-rail footer, but the rail is xl-only; on mobile
          and laptop viewports the disclaimer was only reachable
          via the chevron tray. Pin a small persistent line at the
          bottom of the message thread so every Coach session
          carries the disclaimer regardless of viewport. The rail
          footer stays for desktop users — the redundancy is
          intentional for clinical-adjacent UI. */}
      <p
        data-slot="coach-thread-disclaimer"
        className="text-muted-foreground mt-auto pt-2 text-[10px] leading-relaxed"
      >
        {t("insights.coach.composerDisclaimer")}
      </p>
    </div>
  );
}

interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  metricSource?: import("@/lib/ai/coach/types").CoachProvenance | null;
  providerType?: string | null;
  inProgress?: boolean;
  errorCode?: string | null;
  /**
   * v1.4.23 H7 — present only on persisted assistant messages.
   * Streaming bubbles (no message id yet) skip the thumbs row so the
   * user can't rate before the message lands on disk.
   */
  messageId?: string;
}

function ChatBubble({
  role,
  content,
  metricSource,
  providerType,
  inProgress,
  errorCode,
  messageId,
}: ChatBubbleProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  // v1.4.27 B7 / L3 — pair the evidence `<details>` and its disclosed
  // list explicitly so screen-readers announce the panel relationship.
  const evidencePanelId = useId();
  // v1.4.27 MB3 / CF-32 — track the disclosure state in React so the
  // summary can carry an accurate `aria-expanded`. Native `<details>`
  // reflects its open state via the `open` attribute, but that does
  // not surface as `aria-expanded` on the summary by default; screen
  // readers still need the explicit attribute to announce the panel
  // as expanded vs collapsed.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  if (role === "user") {
    // v1.4.22 B3 — pull the user's Gravatar so the user bubble's
    // avatar matches the Coach avatar in size and visual weight.
    // Falls back to the generic person glyph when the user hasn't
    // configured an email (or the Gravatar lookup returned null).
    const gravatarUrl = user?.gravatarUrl ?? null;
    const initials = user?.username
      ? user.username.slice(0, 2).toUpperCase()
      : null;
    return (
      <div
        data-slot="coach-bubble-user"
        className="flex items-start justify-end gap-2"
      >
        <div
          className={cn(
            "border-dracula-purple/30 bg-dracula-purple/12 text-foreground",
            "max-w-[80%] rounded-xl rounded-tr-sm border px-3.5 py-2.5",
            "text-sm leading-relaxed",
          )}
        >
          {content}
        </div>
        {gravatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={gravatarUrl}
            alt=""
            aria-hidden="true"
            data-slot="coach-bubble-user-avatar"
            className="border-border/50 mt-0.5 size-8 shrink-0 rounded-full border object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            data-slot="coach-bubble-user-avatar"
            className="text-muted-foreground bg-muted/60 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          >
            {initials ?? <User className="size-3.5" />}
          </div>
        )}
      </div>
    );
  }

  // v1.4.25 W5 — map server-emitted error codes to specific Coach
  // i18n keys. Distinct user-quota and provider-rate-limit copy so the
  // user understands daily-cap (resets at UTC midnight) vs. transient
  // provider load (retry in ~5 min). Codes that have no dedicated
  // translation fall back to the generic provider-unavailable copy.
  const errorKey = errorCode ? errorCodeToI18nKey(errorCode) : null;
  const errorMessage = errorKey ? t(errorKey, {}) : null;
  // When a translated message comes back unchanged (i.e. key missing)
  // we fall back to a generic provider error string so the bubble
  // doesn't surface raw `coach.http.503` text to the user.
  const safeError =
    errorMessage && errorMessage !== errorKey
      ? errorMessage
      : errorCode
        ? t("insights.coach.errorProvider")
        : null;

  const keyValues = metricSource?.keyValues ?? [];

  return (
    <div
      data-slot="coach-bubble-assistant"
      className="flex items-start gap-2.5"
    >
      <div
        aria-hidden="true"
        className="from-dracula-purple to-dracula-pink mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
      >
        {providerType === "refusal" ? (
          <Bot className="text-background size-3.5" />
        ) : (
          <Sparkles className="text-background size-3.5" />
        )}
      </div>
      <div className="flex max-w-[80%] flex-col gap-2">
        <div
          className={cn(
            "border-border/60 bg-muted/40 text-foreground",
            "rounded-xl rounded-tl-sm border px-3.5 py-2.5",
            "text-sm leading-relaxed whitespace-pre-wrap",
            inProgress && "animate-pulse motion-reduce:animate-none",
          )}
        >
          {/* v1.4.25 W5b — strip stray Metric/enum leak tokens from
              the assistant prose before it lands in the bubble. The
              raw `content` is the streamed Coach reply (or the
              persisted twin after `done` fires); both paths are AI-
              authored so they share the same leak surface as the
              insight prose elsewhere. */}
          {content
            ? stripChartTokens(content)
            : inProgress
              ? t("insights.coach.thinking")
              : ""}
        </div>
        {safeError && (
          <p className="text-dracula-orange/90 text-xs">{safeError}</p>
        )}
        {metricSource && <SourceChips provenance={metricSource} />}
        {keyValues.length > 0 && (
          <details
            data-slot="coach-evidence"
            open={evidenceOpen}
            onToggle={(e) =>
              setEvidenceOpen((e.target as HTMLDetailsElement).open)
            }
            // v1.4.27 F14 — always closed by default. The `open`
            // attribute was previously tied to a per-user pref that
            // surfaced raw values unconditionally; that pref is now
            // retired and the disclosure is a true progressive-
            // disclosure surface — the user clicks to expand.
            //
            // v1.4.27 MB3 / CF-32 — the `open` attribute is now
            // controlled from local state so the summary's
            // `aria-expanded` stays in lock-step. The native disclosure
            // semantics (Enter / Space toggle) are preserved.
            className={cn(
              "border-border/50 bg-muted/30 group rounded-md border",
              "px-2.5 py-1.5 text-xs",
            )}
          >
            <summary
              data-slot="coach-evidence-summary"
              aria-controls={evidencePanelId}
              aria-expanded={evidenceOpen}
              className={cn(
                "text-muted-foreground hover:text-foreground flex cursor-pointer",
                "items-center gap-1.5 leading-relaxed",
                "marker:hidden [&::-webkit-details-marker]:hidden",
                "focus-visible:ring-ring/50 rounded outline-none focus-visible:ring-2",
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className="size-3 transition-transform group-open:rotate-90"
              />
              <span>{t("insights.coach.evidenceLabel")}</span>
            </summary>
            <ul
              id={evidencePanelId}
              data-slot="coach-evidence-list"
              className="text-foreground mt-2 flex flex-col gap-1"
            >
              {keyValues.map((kv, idx) => (
                <li
                  key={`${kv.label}-${idx}`}
                  data-slot="coach-evidence-row"
                  className="leading-relaxed"
                >
                  {/* v1.4.25 W5 — `kv.label` (e.g. "avg7 systolic")
                      was rendered prefixed to every row, repeating
                      framing the disclosure heading already gives.
                      Drop the label and lead with the value; the
                      window stays as a parenthetical tail so the row
                      still answers "over what timeframe?". */}
                  <strong className="font-semibold">
                    {kv.value}
                    {kv.unit ? ` ${kv.unit}` : ""}
                  </strong>
                  {kv.window && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({kv.window})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {/* v1.4.23 H7 — per-message thumbs feedback. Only persisted
            assistant messages get the row (skipped for refusals,
            errors, in-flight stream bubbles). The aggregator buckets
            the rating by (promptVersion, tone, verbosity). */}
        {messageId &&
          !inProgress &&
          !errorCode &&
          providerType !== "refusal" && (
            <CoachMessageFeedback messageId={messageId} />
          )}
      </div>
    </div>
  );
}

interface CoachMessageFeedbackProps {
  messageId: string;
}

function CoachMessageFeedback({ messageId }: CoachMessageFeedbackProps) {
  const { t } = useTranslations();
  const [submittedRating, setSubmittedRating] = useState<
    "helpful" | "unhelpful" | null
  >(null);

  const submit = useMutation({
    mutationFn: async (rating: "helpful" | "unhelpful") => {
      const res = await fetch(
        `/api/insights/chat/messages/${messageId}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating }),
        },
      );
      // Treat 409 (already_rated) as a successful no-op so the user
      // never sees an error toast for double-clicking the same chip.
      if (!res.ok && res.status !== 409) {
        throw new Error("coach-feedback.failed");
      }
      return rating;
    },
    onSuccess: (rating) => setSubmittedRating(rating),
  });

  if (submittedRating) {
    return (
      <p
        data-slot="coach-message-feedback-thanks"
        className="text-muted-foreground text-[10px]"
      >
        {t("insights.coach.feedbackThanks")}
      </p>
    );
  }

  return (
    <div data-slot="coach-message-feedback" className="flex items-center gap-2">
      <button
        type="button"
        data-slot="coach-message-feedback-helpful"
        onClick={() => submit.mutate("helpful")}
        disabled={submit.isPending}
        className="text-muted-foreground hover:text-dracula-green focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1 rounded px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        <ThumbsUp className="size-3" aria-hidden="true" />
        {t("insights.coach.feedbackHelpful")}
      </button>
      <button
        type="button"
        data-slot="coach-message-feedback-unhelpful"
        onClick={() => submit.mutate("unhelpful")}
        disabled={submit.isPending}
        className="text-muted-foreground hover:text-dracula-orange focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1 rounded px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        <ThumbsDown className="size-3" aria-hidden="true" />
        {t("insights.coach.feedbackUnhelpful")}
      </button>
    </div>
  );
}
