"use client";

/**
 * v1.41 — what an answer assumed instead of asking, in one quiet line under
 * it: "Assumed: last 30 days. Change".
 *
 * Meta text, the value in the foreground. "Change" is a text button of the
 * same size, offered only under the latest answer and only when the server
 * sent alternatives for that assumption (`change_assumption` follow-ups).
 * A tap shows them as reply pills right below; a pill sends its label as
 * the person's message and the server answers from the alternative, without
 * asking again. Nothing opens by itself.
 */
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { COACH_ASSUMPTION_KEYS } from "@/lib/ai/coach/dialog-keys";
import type { CoachAssumption, CoachFollowUp } from "@/lib/ai/coach/types";

import { SuggestedReplies } from "./suggested-replies";
import { COACH_FOCUS_RING } from "./focus-ring";

/** The alternatives the server offers for one assumption. */
export function alternativesFor(
  assumption: CoachAssumption,
  followUps: readonly CoachFollowUp[],
): CoachFollowUp[] {
  return followUps.filter(
    (chip) =>
      chip.kind === "change_assumption" &&
      chip.assumption?.kind === assumption.kind,
  );
}

/** The catalog value in the reader's language, else the server's. */
function optionLabel(
  t: (key: string) => string,
  option: CoachAssumption["value"],
): string {
  const local = t(option.labelKey);
  return local === option.labelKey ? option.label : local;
}

export interface CoachAssumptionLineProps {
  assumptions: CoachAssumption[];
  /** The latest answer's `change_assumption` chips; empty elsewhere. */
  changes: CoachFollowUp[];
  messageId: string | null;
  /** True while a turn is in flight. */
  disabled: boolean;
  onChange?: (followUp: CoachFollowUp, messageId: string) => void;
}

export function CoachAssumptionLine({
  assumptions,
  changes,
  messageId,
  disabled,
  onChange,
}: CoachAssumptionLineProps) {
  const { t } = useTranslations();
  const [openKind, setOpenKind] = useState<string | null>(null);
  const baseId = useId();
  if (assumptions.length === 0) return null;
  return (
    <div
      data-slot="coach-assumptions"
      className="flex w-full min-w-0 flex-col gap-2"
    >
      {assumptions.slice(0, 2).map((assumption) => {
        const alternatives =
          onChange && messageId && !disabled
            ? alternativesFor(assumption, changes)
            : [];
        const open = openKind === assumption.kind && alternatives.length > 0;
        const panelId = `${baseId}-${assumption.kind}`;
        return (
          <div key={assumption.kind} className="flex flex-col gap-2">
            <p
              data-slot="coach-assumption-line"
              data-kind={assumption.kind}
              className="text-muted-foreground max-w-full text-xs leading-relaxed"
            >
              {t(COACH_ASSUMPTION_KEYS.line, {
                value: optionLabel(t, assumption.value),
              })}
              .{" "}
              {alternatives.length > 0 ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  data-slot="coach-assumption-change"
                  aria-expanded={open}
                  aria-controls={open ? panelId : undefined}
                  onClick={() => setOpenKind(open ? null : assumption.kind)}
                  // Inline in the meta line; the hit area reaches past the text (a
                  // 44 px target on phones) without making the line any taller.
                  className={cn(
                    "text-foreground relative h-auto px-1 py-0 text-xs font-normal underline underline-offset-4 after:absolute after:-inset-x-1 after:-inset-y-3.5 after:content-[''] sm:after:-inset-y-1.5",
                    COACH_FOCUS_RING,
                  )}
                >
                  {t(COACH_ASSUMPTION_KEYS.change)}
                </Button>
              ) : null}
            </p>
            {open && messageId && onChange ? (
              <div id={panelId}>
                {SuggestedReplies({
                  slot: "coach-assumption-alternatives",
                  messageId,
                  disabled,
                  max: 3,
                  replies: alternatives.map((chip) => ({
                    id: chip.id,
                    label: chip.label,
                    kind: "followUp",
                    data: { "data-follow-up-id": chip.id },
                    onSelect: () => onChange(chip, messageId),
                  })),
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
