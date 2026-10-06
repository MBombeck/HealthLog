"use client";

/**
 * v1.41 — the one quiet way the Coach offers a reply: pills under the latest
 * answer, in the answer's own column, at the answer's text size.
 *
 * Every reply the person can give by tap uses it: the follow-ups after an
 * answer, the choices of a clarifying question (the question itself is the
 * answer above, its assumed choice the first pill), "Yes, remember it" /
 * "No" under a fact proposal and "Take on this plan" / "Not now" under a
 * plan proposal. A tap sends the pill's label as the person's own message,
 * so it shows in the thread like anything they typed; the request carries
 * which offer it answered, and the server resolves it from what it stored.
 *
 * Outline pills in the foreground at reduced contrast, never an accent
 * colour, never a card. Hidden while a turn runs, so a pill can never answer
 * a reply that is about to stop being the latest. The tapped pill goes away
 * with the rest, so focus moves to the composer.
 */
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { COACH_SUGGESTED_REPLIES_KEYS } from "@/lib/ai/coach/dialog-keys";

import { focusCoachComposer } from "./composer-focus";

/** At most this many pills render, whatever the offer carries. */
export const MAX_SUGGESTED_REPLIES = 4;

export interface SuggestedReply {
  /** Stable within the offer; the React key. */
  id: string;
  /** What the pill says, and the message a tap sends. */
  label: string;
  /** What the offer is (`followUp`, `clarification`, `memory`, `plan`). */
  kind: string;
  /** Extra `data-*` attributes, for tests and the e2e specs. */
  data?: Record<`data-${string}`, string>;
  onSelect: () => void;
}

export interface SuggestedRepliesProps {
  replies: SuggestedReply[];
  /** The assistant message that offered them. */
  messageId: string;
  /** True while a turn is in flight. */
  disabled: boolean;
  /** At most this many; defaults to {@link MAX_SUGGESTED_REPLIES}. */
  max?: number;
  /** The group's accessible name; defaults to "Suggested replies". */
  label?: string;
  /** The group's `data-slot`. */
  slot?: string;
}

export function SuggestedReplies({
  replies,
  messageId,
  disabled,
  max = MAX_SUGGESTED_REPLIES,
  label,
  slot = "coach-suggested-replies",
}: SuggestedRepliesProps) {
  const { t } = useTranslations();
  const shown = replies.slice(0, max);
  if (disabled || shown.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={label ?? t(COACH_SUGGESTED_REPLIES_KEYS.groupLabel)}
      data-slot={slot}
      data-message-id={messageId}
      className="flex max-w-full flex-wrap gap-2"
    >
      {shown.map((reply) => (
        <Button
          key={reply.id}
          type="button"
          variant="outline"
          size="sm"
          // The answer's own scale (text-sm, regular weight) at reduced
          // contrast; the 44 px tap floor below `sm`, 36 px beside a
          // pointer. A long label wraps inside the pill instead of pushing
          // past the column at 390 px.
          className="border-border text-foreground/80 hover:text-foreground hover:bg-muted h-auto min-h-11 max-w-full rounded-full px-3 py-1.5 text-left text-sm leading-snug font-normal whitespace-normal shadow-none sm:min-h-9"
          data-reply-id={reply.id}
          data-reply-kind={reply.kind}
          {...reply.data}
          onClick={() => {
            reply.onSelect();
            focusCoachComposer();
          }}
        >
          {reply.label}
        </Button>
      ))}
    </div>
  );
}
