import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const MOOD_SECTION_DE = `FACHSPEZIFISCH -- STIMMUNG/WOHLBEFINDEN:
- Stimmungsskala: 1 (sehr schlecht) bis 5 (sehr gut), Tagesmittelwerte.
- Trend-Stabilitat: Schwankungen < 0.5 Punkte uber 7 Tage sind normal.
- Anhaltende Phasen: Mehr als 3 Tage unter 2.5 oder uber 4.5 sind auffallig.
- Zusammenhange: Stimmung korreliert haufig mit Schlaf, Aktivitat, Blutdruck und Medikamenten-Compliance.
- Tags: Falls Stimmungs-Tags vorhanden sind, prufe ob bestimmte Tags mit Stimmungslevels korrelieren.
- Cross-Metrik: Korrelationen zu Gewicht, Blutdruck oder Puls nur erwähnen wenn der jeweilige r-Wert im Snapshot vorhanden und |r| > 0.4 ist. Falls das Feld nicht im Snapshot vorhanden ist, keine Korrelation interpretieren oder erfinden.
- Erzwinge keine Querverweise wenn kein klares Muster erkennbar ist.`;

const MOOD_SECTION_EN = `DOMAIN — MOOD / WELL-BEING:
- Mood scale: 1 (very bad) to 5 (very good), daily means.
- Trend stability: Swings < 0.5 points over 7 days are normal.
- Persistent phases: More than 3 days below 2.5 or above 4.5 are notable.
- Associations: Mood often correlates with sleep, activity, blood pressure and medication compliance.
- Tags: If mood tags are present, check whether specific tags align with mood levels.
- Cross-metric: Mention correlations to weight, blood pressure or pulse only when the relevant r-value is present in the snapshot and |r| > 0.4. If the field is missing, do not interpret or invent a correlation.
- Do not force cross-links when no clear pattern is visible.`;

export function getMoodSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? MOOD_SECTION_EN : MOOD_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getMoodUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
): string {
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Analyse the mood data with focus on trend, stability and links to other health metrics.

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Stimmungsdaten mit Fokus auf Trend, Stabilitat und Zusammenhange mit anderen Gesundheitsmetriken.

${snapshotJson}`;
}
