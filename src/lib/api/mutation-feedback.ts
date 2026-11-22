/**
 * What a change tells the person once it lands.
 *
 * A write a person makes answers, every time: a toast, with Undo where the
 * change can be undone, or a status line above the card's action row
 * (`docs/contributing/ui-standards.md` §12). Many settings writes answered
 * nothing (the pregnancy state, the scheduled report, the import folder and
 * its "Fetch now"), so a person could not tell a saved change from a lost
 * one. The answer lives in one place, the app's mutation cache
 * (`MutationSavedToaster` in `src/components/providers.tsx`): a mutation that
 * declares `meta: CONFIRM_SAVED` is confirmed with "Saved" when it succeeds,
 * unless its call site already showed a toast of its own for it. A mutation
 * that confirms in place declares `CONFIRMS_INLINE` instead.
 *
 * `src/__tests__/save-feedback-guard.test.ts` holds every settings write to
 * one of the three: its own toast, an inline confirmation, or this meta.
 *
 * Client-safe and pure.
 */

export type MutationFeedback = "saved" | "inline";

/** The cache confirms a successful write with "Saved". */
export const CONFIRM_SAVED = { feedback: "saved" } as const satisfies {
  feedback: MutationFeedback;
};

/** The call site confirms in place (a status line, a changed state). */
export const CONFIRMS_INLINE = { feedback: "inline" } as const satisfies {
  feedback: MutationFeedback;
};

/** Whether a mutation's meta asks the cache to confirm it. */
export function confirmsSaved(meta: unknown): boolean {
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as { feedback?: unknown }).feedback === "saved"
  );
}
