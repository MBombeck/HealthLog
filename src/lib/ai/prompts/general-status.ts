import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const GENERAL_SECTION_DE = `METRIK — GESAMTBEWERTUNG:
- Der Snapshot trägt measurementSeries (eine Map je Metriktyp mit summary + graded series), medicationAdherence (summary + series), bloodPressureTargets (falls vorhanden) und moodContext (falls ≥ 3 Tage). dataCoverage.avgDaysBetweenMeasurements zeigt die Messdichte.
- LÄNGE (überschreibt das Single-Metrik-Budget): Diese Sektion deckt bis zu sechs Metriken ab — schreibe 3-5 Sätze, ca. 50-80 Wörter. Trotzdem knapp und ohne Fülltext.
- Fasse die verfügbaren Parameter zu EINEM kohärenten Bild zusammen — nicht jeden einzeln aufzählen. Nenne HÖCHSTENS zwei Metriken namentlich (die auffälligsten), den Rest nur, wenn er auffällig vom eigenen Mittel abweicht. Priorisiere: das Auffälligste zuerst, Stabiles nur knapp.
- Pro Metrik dieselbe Logik: das recent-Mittel gegen das weekly/monthly-Mittel der Person stellen und nur signifikante Abweichungen von der eigenen Baseline melden.
- Positives ausdrücklich anerkennen — ein stabiler oder sich verbessernder Wert ist eine echte Botschaft, kein Lückenfüller.
- Zusammenhänge nur erwähnen, wenn ein r-Wert im Snapshot vorhanden und |r| > 0.4 ist — als Zusammenhang, nie als Ursache. Stimmung als Kontext einbeziehen, nicht übergewichten.
- Eine Botschaft: Auch über alle Metriken hinweg endet die Einschätzung mit GENAU EINER wichtigsten, machbaren Empfehlung ("eine Sache").`;

const GENERAL_SECTION_EN = `METRIC — OVERALL ASSESSMENT:
- The snapshot carries measurementSeries (a map per metric type with summary + graded series), medicationAdherence (summary + series), bloodPressureTargets (when present) and moodContext (when ≥ 3 days). dataCoverage.avgDaysBetweenMeasurements shows the measurement density.
- LENGTH (overrides the single-metric budget): this section spans up to six metrics — write 3-5 sentences, roughly 50-80 words. Still concise, no filler.
- Pull the available parameters into ONE coherent picture — do not list each separately. Name AT MOST two metrics by name (the most notable ones); mention the rest only when they deviate notably from their own mean. Prioritise: the most notable first, stable values only briefly.
- Same logic per metric: place the recent mean against the person's weekly/monthly mean and report only significant deviations from their own baseline.
- Acknowledge the positive explicitly — a stable or improving value is a real message, not filler.
- Mention associations only when an r-value is present in the snapshot and |r| > 0.4 — as an association, never a cause. Include mood as context, do not over-weight it.
- One message: even across all metrics, close with EXACTLY ONE most-important, doable suggestion ("one thing").`;

export function getGeneralStatusSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? GENERAL_SECTION_EN : GENERAL_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getGeneralStatusUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
): string {
  // v1.4: when the previous-analysis context block is supplied, the
  // model is instructed to call out improvements / regressions
  // explicitly. Block already includes the comparison instruction,
  // so we just inject it ahead of the snapshot.
  const ctxBlock =
    previousContextBlock && previousContextBlock.trim().length > 0
      ? `\n\n${previousContextBlock}\n`
      : "";
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Write one short overall assessment across the available health metrics: name what stands out, place the recent days against the person's own weekly/monthly baseline, and close with the single most important doable step. Judge confidence from the measurement count, density and recency.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Gesamteinschätzung über die verfügbaren Gesundheitsdaten: benenne das Auffälligste, ordne die jüngsten Tage gegen die eigene Wochen-/Monats-Baseline ein und schließe mit dem einen wichtigsten machbaren Schritt. Konfidenz aus Messanzahl, Dichte und Aktualität ableiten.${ctxBlock}

${snapshotJson}`;
}

