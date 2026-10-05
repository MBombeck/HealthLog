"use client";

/**
 * v1.39.4 — up to three follow-up chips under the latest assistant reply.
 * They sit inside the answer's own column, on the bubble's left edge and at
 * the answer's text size, so they read as part of the reply rather than as
 * thread chrome. A tap sends the chip's label as the message with
 * `followUp: { messageId, id }`; the server resolves what the chip asks for.
 *
 * The label is the server's rendering in the request locale. It is not
 * re-rendered from `labelKey` here: a related-metric chip names its metric
 * in the label, and the key alone does not carry it. Hidden while a turn is
 * in flight, so a chip can never be tapped against a reply that is about to
 * stop being the latest. The tapped chip goes away with the rest, so focus
 * moves to the composer.
 */
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { COACH_FOLLOW_UP_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import type { CoachFollowUp } from "@/lib/ai/coach/types";

import { focusCoachComposer } from "./composer-focus";

/** At most this many chips render, whatever the payload carries. */
const MAX_CHIPS = 3;

export interface CoachFollowUpChipsProps {
  followUps: CoachFollowUp[];
  /** The assistant message that offered the chips. */
  messageId: string;
  /** True while a turn is in flight. */
  disabled: boolean;
  onSelect: (followUp: CoachFollowUp, messageId: string) => void;
}

export function CoachFollowUpChips({
  followUps,
  messageId,
  disabled,
  onSelect,
}: CoachFollowUpChipsProps) {
  const { t } = useTranslations();
  const chips = followUps.slice(0, MAX_CHIPS);
  if (disabled || chips.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t(COACH_FOLLOW_UP_UI_KEYS.groupLabel)}
      data-slot="coach-follow-up-chips"
      data-message-id={messageId}
      className="flex max-w-full flex-wrap gap-2"
    >
      {chips.map((chip) => (
        <Button
          key={chip.id}
          type="button"
          variant="outline"
          size="sm"
          // The answer's own scale (text-sm, regular weight); the 44 px tap
          // floor below `sm`, 36 px beside a pointer. A long label wraps
          // inside the pill instead of pushing past the column at 390 px.
          className="h-auto min-h-11 max-w-full rounded-full px-3 py-1.5 text-left text-sm leading-snug font-normal whitespace-normal sm:min-h-9"
          data-follow-up-id={chip.id}
          data-follow-up-kind={chip.kind}
          onClick={() => {
            onSelect(chip, messageId);
            focusCoachComposer();
          }}
        >
          {chip.label}
        </Button>
      ))}
    </div>
  );
}
