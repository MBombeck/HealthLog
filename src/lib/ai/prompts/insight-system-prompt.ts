/**
 * System prompt and output formatting for OpenAI insights.
 */
import type { Locale } from "@/lib/i18n/config";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";

/**
 * v1.4.16 phase B8 — comparison snapshot the prompt narrates against
 * when the user has the dashboard's "Compare to" toggle on. The snapshot
 * is opt-in: pass it through `buildUserPrompt`'s 4th argument when
 * `comparisonBaseline !== "none"` so the LLM has prior-period context
 * for narrating "Your average BP improved by 4 mmHg vs. last month".
 *
 * Per research §7 Q4 the narrative is default-on whenever the toggle
 * itself is active — the pulldown is the single affordance, no
 * secondary "include in AI" preference, so users don't see surprising
 * mismatches between the chart they're staring at and the AI summary.
 */
export interface ComparisonSnapshot {
  baseline: Exclude<ComparisonBaseline, "none">;
  /** One row per metric the snapshot can compare. Empty array allowed
   *  so the prompt builder is non-strict — the wrapper still adds the
   *  context block but instructs the model that no metric had enough
   *  prior-period data to compare. */
  metrics: Array<{
    /** Snapshot key matching the metricSource convention used elsewhere
     *  in the AI pipeline ("bloodPressure", "weight", "pulse", "mood"). */
    type: string;
    currentAvg: number | null;
    baselineAvg: number | null;
    /** `currentAvg - baselineAvg`, rounded to 2dp; null when either
     *  side missing. */
    delta: number | null;
    /** `(delta / baselineAvg) * 100`, rounded to 1dp; null when either
     *  side missing or baselineAvg is 0. */
    deltaPercent: number | null;
    /** Free-form unit label ("mmHg", "kg", "bpm", "/5") so the model
     *  doesn't have to guess based on metric name. */
    unit: string;
  }>;
}

export function buildUserPrompt(
  featuresJson: string,
  privacyMode: string,
  locale: Locale,
  comparison?: ComparisonSnapshot,
): string {
  const comparisonBlock = comparison
    ? buildComparisonBlock(locale, comparison)
    : "";

  if (locale === "en") {
    const modeLabel =
      privacyMode === "raw"
        ? "Aggregated data + raw values (entire available period, anonymised)"
        : "Aggregated data only (no exact timestamps or raw values)";

    return `Analyse the following health data.
Data mode: ${modeLabel}
Note: use each metric's coverage object for measurement frequency and time spans, and tailor the analysis accordingly.

${featuresJson}${comparisonBlock}`;
  }

  const modeLabel =
    privacyMode === "raw"
      ? "Aggregierte Daten + Rohdaten (gesamter verfügbarer Zeitraum, anonymisiert)"
      : "Nur aggregierte Daten (keine exakten Zeitstempel oder Rohwerte)";

  return `Analysiere die folgenden Gesundheitsdaten.
Datenmodus: ${modeLabel}
Hinweis: Beachte die coverage-Objekte jeder Metrik für Informationen zu Messhäufigkeit und Zeiträumen. Passe deine Analyse entsprechend an.

${featuresJson}${comparisonBlock}`;
}

/**
 * v1.4.16 phase B8 — comparison context block.
 *
 * Renders a dedicated SYSTEM CONTEXT section after the user data so
 * the LLM can narrate the comparison ("Your average BP improved by
 * 4 mmHg vs. last month"). The instruction "narrate the comparison
 * when relevant" is in the system prompt; this block carries the
 * actual prior-period numbers.
 *
 * Exported for unit tests so the integration test can assert the
 * exact string the LLM sees.
 */
export function buildComparisonBlock(
  locale: Locale,
  snapshot: ComparisonSnapshot,
): string {
  const baselineLabel =
    locale === "en"
      ? snapshot.baseline === "lastMonth"
        ? "the same window 30 days ago"
        : "the same window 365 days ago"
      : snapshot.baseline === "lastMonth"
        ? "den gleichen Zeitraum 30 Tage zuvor"
        : "den gleichen Zeitraum 365 Tage zuvor";

  const renderRow = (metric: ComparisonSnapshot["metrics"][number]): string => {
    if (metric.delta === null || metric.baselineAvg === null) {
      return `- ${metric.type}: no prior-period data available`;
    }
    const sign = metric.delta > 0 ? "+" : metric.delta < 0 ? "-" : "±";
    const formattedDelta = `${sign}${Math.abs(metric.delta).toFixed(1)}${metric.unit ? ` ${metric.unit}` : ""}`;
    const pct =
      metric.deltaPercent != null
        ? ` (${metric.deltaPercent > 0 ? "+" : metric.deltaPercent < 0 ? "-" : "±"}${Math.abs(metric.deltaPercent).toFixed(1)} %)`
        : "";
    const current =
      metric.currentAvg != null
        ? `${metric.currentAvg.toFixed(1)}${metric.unit ? ` ${metric.unit}` : ""}`
        : "n/a";
    const prior =
      metric.baselineAvg != null
        ? `${metric.baselineAvg.toFixed(1)}${metric.unit ? ` ${metric.unit}` : ""}`
        : "n/a";
    return `- ${metric.type}: current ${current}, baseline ${prior}, delta ${formattedDelta}${pct}`;
  };

  if (snapshot.metrics.length === 0) {
    return locale === "en"
      ? `

SYSTEM CONTEXT — COMPARISON MODE ACTIVE
The user has activated comparison mode against ${baselineLabel}, but no metric currently has enough prior-period data to compare. State this explicitly in the summary's first sentence.`
      : `

SYSTEM CONTEXT — VERGLEICHSMODUS AKTIV
Der Nutzer hat den Vergleichsmodus gegen ${baselineLabel} aktiviert, aber für keine Metrik liegen ausreichend Daten aus der Vergleichsperiode vor. Erwähne das explizit im ersten Satz der Zusammenfassung.`;
  }

  if (locale === "en") {
    return `

SYSTEM CONTEXT — COMPARISON MODE ACTIVE
The user has activated comparison mode against ${baselineLabel}.
When narrating findings, reference the deltas below. The most
clinically-significant non-null delta MUST appear in the summary's
first sentence (e.g. "Your average systolic BP improved by 4 mmHg
vs. last month"). Do NOT invent comparison numbers.

Prior-period deltas:
${snapshot.metrics.map(renderRow).join("\n")}`;
  }

  return `

SYSTEM CONTEXT — VERGLEICHSMODUS AKTIV
Der Nutzer hat den Vergleichsmodus gegen ${baselineLabel} aktiviert.
Beziehe dich beim Narrativ auf die untenstehenden Deltas. Die
klinisch bedeutsamste nicht-leere Abweichung MUSS im ersten Satz der
Zusammenfassung auftauchen (z.B. "Dein systolischer Mittelwert ist
4 mmHg besser als im Vormonat"). Erfinde KEINE Vergleichszahlen.

Vorperioden-Deltas:
${snapshot.metrics.map(renderRow).join("\n")}`;
}
