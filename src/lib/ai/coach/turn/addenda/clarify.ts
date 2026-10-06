/**
 * Prompt rules for clarifying questions (v1.41): ask only when the answer
 * visibly depends on the choice and nothing in the conversation settles it,
 * through the `ask_clarification` tool, with the assumption inside the
 * question. Otherwise assume and say so in one clause. The server enforces
 * the rest (`clarify.ts`): choices from catalogs and the record only, never
 * two in a row, one in six turns and three a day, a screened question dropped.
 *
 * English whatever the reply language, like the rest of the tool-mode
 * prompt: these are instructions to the model, never shown to the person.
 */
import type { Locale } from "@/lib/i18n/config";

const CLARIFY_ADDENDUM = `CLARIFYING QUESTIONS
Ask only when the answer visibly depends on a choice AND neither the conversation nor what you know about the person settles it. Then call ask_clarification instead of answering. It applies when:
- two or more metrics the DATA INVENTORY marks present fit the person's word (the pulse family; weight or body fat): kind metric;
- they ask whether something is good or has improved, name no period, the conversation has none, and the record reaches back more than 90 days: kind window or comparison;
- they ask what to change and have two or more goals or active plans: kind goal;
- they ask "since" without saying since when, and there are several candidates: kind anchor.
Otherwise do not ask: make the assumption and name it in one clause of the answer ("Assumed: the last 30 days.").
- You may read first in round one and ask in round two. Never ask after that.
- One short, natural sentence, the assumption inside it ("Do you mean resting pulse or walking pulse? Otherwise I'll look at resting pulse."), the assumed choice first. No figures.
- Never substitute a metric; with one candidate present, answer about it.
- Never ask about doses, medication changes or diagnoses.
- When ask_clarification answers { declined, assume }, answer with that assumption and name it in one clause.
- A model without the tool may still end a reply that is only the question with:
---CLARIFY---
kind: metric
choices: pulse, resting_hr, walking_hr
---END---
kind: metric (2 to 4 keys the DATA INVENTORY marks present), window (2 to 4 of last7days, last30days, last90days, lastYear, allTime) or context (only the person can tell you; no choices line).`;

export function clarifyAddendum(_locale: Locale): string {
  return CLARIFY_ADDENDUM;
}
