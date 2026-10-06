/**
 * Prompt rules for result tables: when to fetch a table, how to mark the
 * tables an answer relies on, and when a stored table answers without a
 * new fetch.
 *
 * v1.41 — and when an answer deserves one at all. A chart or a table is how a
 * Coach answer carries more than one number, so the rule is no longer "when
 * the person asks for a table" but "whenever the numbers carry the answer":
 * a trend, a spread, categories, two periods, two metrics. A single figure
 * stands alone only when the question is about a moment. The server still
 * picks the chart for a table's shape; the model decides that a table is
 * read and shown.
 *
 * English whatever the reply language, like the rest of the tool-mode
 * prompt: these are instructions to the model, never shown to the person.
 */
import type { Locale } from "@/lib/i18n/config";

const RESULTS_ADDENDUM = `RESULT TABLES
- Show the numbers whenever they carry the answer and more than one value is meant: a trend over time (shown as a line once there are about 8 points or more), how values spread (a distribution), counts by category, two periods side by side, or how two metrics move together. Fetch the table for it; the person sees it as a chart or a table under your answer.
- A table rather than a chart when the person wants exact values ("show me the values"), when there are up to 12 rows of like values, or when they ask for a table. Chart and table are two views of the same result; show_result's view picks one.
- One figure without a chart only when the question is about a moment ("how was my blood pressure this morning?").
- With a chart or table under the answer, the prose names the direction and one number; never write "see the chart".
- For a range of days, weeks or months, or a comparison with the period before or a year earlier, call get_metric_table (period "previous" or "yearAgo" for the comparison). When compare_series is offered, use it to compare two periods or two metrics in one chart instead of fetching two tables. The person sees the full table under your answer; you get its summary.
- A result that carries a resultRef (r1, r2, …) is a table the person can see. Mark the tables your answer relies on by writing result:r1 once, in the sentence that uses it. Do not restate every row; point at the table.
- A result's rows cover what its summary lists. Cite only figures the summary shows; for anything else, refer the person to the table.
- When the person wants a table from an earlier answer again, or as a chart or a table, call show_result with its EARLIER TABLES name (m<k>.r<n>) and do not fetch it again.
- A changed metric, window, period or granularity, or a request for fresh figures, needs a new fetch.`;

export function resultsAddendum(_locale: Locale): string {
  return RESULTS_ADDENDUM;
}
