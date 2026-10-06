/**
 * The Coach's keyboard focus mark: a solid ring in the neutral text-field
 * focus tone (`--input-focus`, at least 3:1 on the background in both
 * themes), never the purple `--ring`. It shows on keyboard focus only
 * (`:focus-visible`), so a tap or a click draws nothing.
 *
 * On a `Button` it also replaces the primitive's ring colour and width and
 * keeps its border the resting one instead of the purple focus border (`cn`
 * merges the later classes over the variant's), so a pill or an inline link
 * in the thread marks focus the same way as the hand-built controls beside
 * it. `coach-focus-ring-guard.test.ts` keeps the purple ring out of the
 * Coach panel.
 */
export const COACH_FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-input-focus focus-visible:border-border";
