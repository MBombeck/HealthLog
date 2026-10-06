/**
 * Prompt rules for proposing follow-up chips from the catalog.
 *
 * The server derives the chips from what the turn read; a proposal only
 * says which of them the model thinks matter most.
 *
 * v1.41 — the chips are the answer's only "what next?" surface, so the
 * prose does not end on a question of its own. The model names a kind
 * and a domain, never a label: the server renders every word the person
 * sees, and drops a proposal for a domain the turn did not read.
 *
 * English whatever the reply language, like the rest of the tool-mode
 * prompt: these are instructions to the model, never shown to the person.
 */
import type { Locale } from "@/lib/i18n/config";

const FOLLOW_UPS_ADDENDUM = `FOLLOW-UP SUGGESTIONS
The person may see up to three suggested follow-ups under your answer; the server picks them from what you read. You may name the ones that fit your answer best, in a block after your prose and before any ---KEYVALUES--- block:
---FOLLOWUPS---
previous_period: bp
as_chart: bp
---END---
- One line each, at most three: a kind, a colon, a metric or domain you read with a tool on THIS turn and that returned data.
- Kinds: as_chart, as_table, previous_period, year_ago, widen_window, related_metric.
- Never write a label or a question: the server words them. Leave the block out when nothing fits, and never mention it in your prose.
- These suggestions are the answer's only "what next?": do not end your prose with a question that offers more, and do not list options to explore.`;

export function followUpsAddendum(_locale: Locale): string {
  return FOLLOW_UPS_ADDENDUM;
}
