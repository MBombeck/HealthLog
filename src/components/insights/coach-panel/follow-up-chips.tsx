"use client";

/**
 * v1.39.4 — up to three follow-up chips under the latest assistant reply.
 * v1.41 — a thin adapter onto `SuggestedReplies`, the one pattern every
 * tappable reply in the thread uses (follow-ups, clarifying choices, memory
 * and plan decisions).
 *
 * A tap sends the chip's label as the message with
 * `followUp: { messageId, id }`; the server resolves what the chip asks for.
 * The label is the server's rendering in the request locale. It is not
 * re-rendered from `labelKey` here: a related-metric chip names its metric
 * in the label, and the key alone does not carry it.
 */
import { useTranslations } from "@/lib/i18n/context";
import { COACH_FOLLOW_UP_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import type { CoachFollowUp } from "@/lib/ai/coach/types";

import { SuggestedReplies } from "./suggested-replies";

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
  return SuggestedReplies({
    slot: "coach-follow-up-chips",
    label: t(COACH_FOLLOW_UP_UI_KEYS.groupLabel),
    messageId,
    disabled,
    max: MAX_CHIPS,
    replies: followUps.map((chip) => ({
      id: chip.id,
      label: chip.label,
      kind: "followUp",
      data: {
        "data-follow-up-id": chip.id,
        "data-follow-up-kind": chip.kind,
      },
      onSelect: () => onSelect(chip, messageId),
    })),
  });
}
