"use client";

/**
 * v1.41 — the one quiet line under an answer that says the Coach kept
 * something: "Remembered: you want to reach 75 kg by December. Undo".
 *
 * Meta text at the meta size, with "Undo" as a text button of the same size.
 * Undo forgets the fact (a soft delete) and the line goes. A fact the Coach
 * only proposes (a health fact, which is never kept without a tap) has no
 * line: the answer ends with the question and the reply pills carry
 * "Yes, remember it" / "No".
 *
 * The live turn has the fact's words from the `memoryNote` frame. A
 * persisted message carries only the fact's id, so its words come from the
 * memory list; a fact that has since been forgotten or edited away leaves
 * no line behind.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { COACH_MEMORY_KEYS } from "@/lib/ai/coach/memory/shared";
import type { CoachMemoryNoteMeta } from "@/lib/ai/coach/types";

import { useCoachFacts, useForgetCoachFact } from "./use-coach-facts";

export interface CoachMemoryNoteLineProps {
  fact: string;
  pending: boolean;
  onUndo: () => void;
}

/** The line itself, without data: what the tests render. */
export function CoachMemoryNoteLine({
  fact,
  pending,
  onUndo,
}: CoachMemoryNoteLineProps) {
  const { t } = useTranslations();
  return (
    <p
      data-slot="coach-memory-note"
      className="text-muted-foreground max-w-full text-xs leading-relaxed break-words"
    >
      {t(COACH_MEMORY_KEYS.saved, { fact: fact.replace(/[.\s]+$/, "") })}.{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        data-slot="coach-memory-note-undo"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={onUndo}
        // Inline in the meta line; the hit area reaches past the text (a
        // 44 px target on phones) without making the line any taller.
        className="text-foreground relative h-auto px-1 py-0 text-xs font-normal underline underline-offset-4 after:absolute after:-inset-x-1 after:-inset-y-3.5 after:content-[''] sm:after:-inset-y-1.5"
      >
        {t(COACH_MEMORY_KEYS.undo)}
      </Button>
    </p>
  );
}

export function CoachMemoryNote({
  note,
  liveFact,
}: {
  /** `metricSource.memoryNote`, or the live frame's metadata. */
  note: CoachMemoryNoteMeta;
  /** The fact's words from the live frame, when the turn just streamed. */
  liveFact?: string | null;
}) {
  const { t } = useTranslations();
  const [undone, setUndone] = useState(false);
  const saved = !note.proposal && !!note.factId;
  // The list is read only for a persisted note without its words.
  const facts = useCoachFacts({ enabled: saved && !liveFact && !undone });
  const forget = useForgetCoachFact({
    onSuccess: () => setUndone(true),
    onError: () => toast.error(t("settings.ai.coachMemory.forgotError")),
  });
  if (!saved || undone || !note.factId) return null;
  const fact =
    liveFact ?? facts.data?.find((f) => f.id === note.factId)?.text ?? null;
  if (!fact) return null;
  return (
    <CoachMemoryNoteLine
      fact={fact}
      pending={forget.isPending}
      onUndo={() => {
        if (note.factId && !forget.isPending) forget.mutate(note.factId);
      }}
    />
  );
}
