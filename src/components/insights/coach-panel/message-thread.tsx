"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { useCoachPrefs } from "@/hooks/use-coach-prefs";

import { SourceChips } from "./source-chips";
import type {
  CoachConversationDetailDTO,
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
  /** Empty-state copy when no conversation is loaded yet. */
  emptyHint?: string;
}

function isPinnedToBottom(el: HTMLElement, slack = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function MessageThread({
  conversation,
  streaming,
  emptyHint,
}: MessageThreadProps) {
  const { t } = useTranslations();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasPinnedRef = useRef(true);

  // v1.4.23 H4 — read the user's Coach prefs so the evidence
  // disclosure honours `showEvidenceByDefault`. Cached at the
  // queryClient level via the shared `useCoachPrefs` hook; the
  // settings sheet writes the same key after a successful save so the
  // new default takes effect on the next reply without a page reload.
  const { data: coachPrefs } = useCoachPrefs();
  const evidenceDefaultOpen = coachPrefs?.showEvidenceByDefault ?? false;

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
  // when the user was already at the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (wasPinnedRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, streaming?.content]);

  if (messages.length === 0 && !streamingActive) {
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
            evidenceDefaultOpen={evidenceDefaultOpen}
            messageId={m.id}
          />
        );
      })}
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
            evidenceDefaultOpen={evidenceDefaultOpen}
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
  /** v1.4.23 H4 — when true the evidence `<details>` mounts open. */
  evidenceDefaultOpen?: boolean;
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
  evidenceDefaultOpen,
  messageId,
}: ChatBubbleProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
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

  const errorMessage = errorCode ? t(`insights.coach.${errorCode}`, {}) : null;
  // When a translated message comes back unchanged (i.e. key missing) we
  // fall back to a generic provider error string so the bubble doesn't
  // surface raw `coach.http.503` text to the user.
  const safeError =
    errorMessage && errorMessage !== `insights.coach.${errorCode}`
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
          {content || (inProgress ? t("insights.coach.thinking") : "")}
        </div>
        {safeError && (
          <p className="text-dracula-orange/90 text-xs">{safeError}</p>
        )}
        {metricSource && <SourceChips provenance={metricSource} />}
        {keyValues.length > 0 && (
          <details
            data-slot="coach-evidence"
            // v1.4.23 H4 — open by default when the user's prefs ask
            // for it. Browsers honour the boolean `open` attribute on
            // initial mount; toggling at runtime keeps the user's
            // current expansion state intact.
            open={evidenceDefaultOpen ? true : undefined}
            className={cn(
              "border-border/50 bg-muted/30 group rounded-md border",
              "px-2.5 py-1.5 text-xs",
            )}
          >
            <summary
              data-slot="coach-evidence-summary"
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
              data-slot="coach-evidence-list"
              className="text-foreground mt-2 flex flex-col gap-1"
            >
              {keyValues.map((kv, idx) => (
                <li
                  key={`${kv.label}-${idx}`}
                  data-slot="coach-evidence-row"
                  className="leading-relaxed"
                >
                  <span className="text-muted-foreground">{kv.label}:</span>{" "}
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
        className="text-muted-foreground hover:text-dracula-green focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        <ThumbsUp className="size-3" aria-hidden="true" />
        {t("insights.coach.feedbackHelpful")}
      </button>
      <button
        type="button"
        data-slot="coach-message-feedback-unhelpful"
        onClick={() => submit.mutate("unhelpful")}
        disabled={submit.isPending}
        className="text-muted-foreground hover:text-dracula-orange focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        <ThumbsDown className="size-3" aria-hidden="true" />
        {t("insights.coach.feedbackUnhelpful")}
      </button>
    </div>
  );
}
