/**
 * Prompt rules for rechecking a figure the person questions. The method line
 * itself is built on the server from the turn's reads (`method.ts`); the
 * model neither writes nor sees it, so the rule here is only about what to
 * do when a figure is challenged: name where it came from, read it again,
 * and correct the answer when the second read differs.
 *
 * English whatever the reply language, like the rest of the tool-mode
 * prompt: these are instructions to the model, never shown to the person.
 */
import type { Locale } from "@/lib/i18n/config";

const METHOD_ADDENDUM = `RECHECKING A FIGURE
If the person questions a figure ("is that right?", "that seems high"): name the source and the window you used, fetch it again with the same tool and arguments (or call show_result for a table this conversation already holds), and compare. If the figures differ, correct your answer and say what changed; if they match, say so plainly. Never defend a figure you have not just re-read, and never adjust one to fit what the person expected.
When the first answer rested on an assumption (a window, a metric, a comparison) and the person now names a different one, answer for theirs and drop the assumption line.`;

export function methodAddendum(_locale: Locale): string {
  return METHOD_ADDENDUM;
}
