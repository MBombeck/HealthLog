/**
 * The view chips ("as a chart", "as a table") and when one would repeat a
 * control the answer already shows.
 *
 * A leaf module on purpose: the stored-reply reader (`persistence.ts`) uses
 * it, and that reader sits on the fenced document chat's module graph, which
 * must not reach the Coach tool registry the rest of the chip catalog
 * imports.
 */
import type {
  CoachFollowUp,
  CoachFollowUpKind,
  CoachResultMeta,
} from "@/lib/ai/coach/types";

/** Kinds answered from a table the conversation already holds. */
export const REUSE_FOLLOW_UP_KINDS: ReadonlySet<CoachFollowUpKind> = new Set([
  "as_chart",
  "as_table",
]);

/**
 * True when a view chip ("as a chart", "as a table") would repeat a control
 * the answer already shows: a table the answer displays with a chart renders
 * its own chart/table toggle right under the prose, so the chip adds
 * nothing. A view chip still counts for a table the answer only used (it
 * sits folded under "Data used", and the chip brings it into the answer)
 * and every other kind is never redundant this way. One definition for the
 * chips a turn derives and the chips a stored reply is read back with, so a
 * reply stored before the rule offers the same as a new one, on every
 * client.
 */
export function isRedundantViewChip(
  chip: Pick<CoachFollowUp, "kind" | "anchor">,
  results: readonly Pick<CoachResultMeta, "ref" | "displayed" | "chartKind">[],
): boolean {
  if (!REUSE_FOLLOW_UP_KINDS.has(chip.kind)) return false;
  const ref = chip.anchor?.ref;
  return results.some(
    (meta) => meta.ref === ref && meta.displayed && meta.chartKind !== null,
  );
}
