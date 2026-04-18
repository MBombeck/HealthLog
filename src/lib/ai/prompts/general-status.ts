import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const GENERAL_SECTION_DE = `FACHSPEZIFISCH — GESAMTBEWERTUNG:
- Integriere alle verfügbaren Vitalparameter zu einem kohärenten Gesamtbild.
- Priorisiere nach klinischer Relevanz: Kritische Abweichungen > moderate Trends > stabile Parameter.
- Identifiziere die wichtigste einzelne Handlungsempfehlung ("One Thing").
- Risikostratifizierung: Bewerte das kardiovaskuläre Gesamtrisiko basierend auf der Kombination aller Faktoren.
- Medikamenten-Adhärenz: Gesamteinnahmetreue bewerten und Zusammenhang mit Vitalwerten benennen.
- Stimmung: Falls vorhanden, als kontextuellen Faktor einbeziehen (nicht übergewichten).
- Positive Entwicklungen explizit hervorheben — Motivation ist therapeutisch relevant.
- Korrelationen nur erwähnen wenn der jeweilige r-Wert im Snapshot vorhanden und |r| > 0.4 ist. Falls ein Korrelationsfeld nicht im Snapshot vorhanden ist, keine Korrelation interpretieren oder erfinden. Vergleiche die aktuellen 7-Tage-Werte mit den Langzeit-Durchschnitten (avg90, allTime).
- Nutze historicalComparison um aktuelle Veränderungen gegenüber der etablierten Baseline einzuordnen.
- Falls Alter und Geschlecht bekannt sind, alters- und geschlechtsspezifische Risikobewertung anwenden.
- Schlaf: Falls sleep-Daten vorhanden, Schlafqualität in die Gesamtbewertung einbeziehen. < 6h/Nacht als Risikofaktor für Hypertonie und Gewichtszunahme benennen.
- Aktivität: Falls activity-Daten vorhanden, Schrittzahl bewerten (WHO-Ziel ≥ 8.000/Tag). Zusammenhang mit Puls- und Gewichtstrend herstellen.
- Rate-Pressure Product: Falls ratePressureProduct vorhanden, als Indikator für kardiale Belastung in die Risikostratifizierung einbeziehen. > 12.000 = erhöhter myokardialer Sauerstoffbedarf.
- Body-Composition-Divergenz: Falls bodyCompositionDivergence.flag = true, als Frühzeichen für sarkopenische Adipositas in die Gesamtbewertung aufnehmen.
- Saisonale Variation: Falls seasonalVariation vorhanden, saisonale Blutdruckschwankungen kontextualisieren und ggf. beruhigend einordnen.`;

const GENERAL_SECTION_EN = `DOMAIN — OVERALL ASSESSMENT:
- Integrate every available vital parameter into a single coherent picture.
- Prioritise by clinical relevance: critical deviations > moderate trends > stable parameters.
- Identify the single most important call to action ("One Thing").
- Risk stratification: Assess overall cardiovascular risk from the combination of all factors.
- Medication adherence: Score total adherence and link it to vital-sign movement.
- Mood: If present, include as a contextual factor (do not over-weight).
- Highlight positive developments explicitly — motivation is therapeutically relevant.
- Mention correlations only when the relevant r-value is present in the snapshot and |r| > 0.4. If a correlation field is missing, do not interpret or invent one. Compare current 7-day values to long-term averages (avg90, allTime).
- Use historicalComparison to anchor current changes against the established baseline.
- If age and sex are known, apply age- and sex-specific risk assessment.
- Sleep: When sleep data is present, fold sleep quality into the overall picture. < 6h/night = risk factor for hypertension and weight gain.
- Activity: When activity data is present, evaluate step count (WHO target ≥ 8,000/day). Tie back to pulse and weight trends.
- Rate-pressure product: When ratePressureProduct is present, include it as a cardiac-load indicator. > 12,000 = elevated myocardial oxygen demand.
- Body-composition divergence: If bodyCompositionDivergence.flag = true, treat as an early sign of sarcopenic obesity.
- Seasonal variation: When seasonalVariation is present, contextualise seasonal BP swings and reassure where appropriate.`;

export function getGeneralStatusSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? GENERAL_SECTION_EN : GENERAL_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getGeneralStatusUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
): string {
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Produce a comprehensive overall assessment across every available health metric.
Focus on the interplay between parameters and identify the single most important call to action.

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Erstelle eine umfassende Gesamtbewertung aller verfügbaren Gesundheitsdaten.
Fokussiere auf das Zusammenspiel der verschiedenen Parameter und identifiziere die wichtigste Handlungsempfehlung.

${snapshotJson}`;
}

// Backward-compatible export for insights/generate route (Task 8 uses this)
export function buildGeneratePrompts(
  featuresJson: string,
  privacyMode: string,
  locale: Locale,
): { systemPrompt: string; userPrompt: string } {
  if (locale === "en") {
    const modeLabel =
      privacyMode === "raw"
        ? "Aggregated data + raw values (entire available period, anonymised)"
        : "Aggregated data only (no exact timestamps or raw values)";

    return {
      systemPrompt: getGeneralStatusSystemPrompt(locale),
      userPrompt: `Analyse the following health data.
Data mode: ${modeLabel}
Use each metric's coverage object for measurement frequency and time spans.
Use correlations for cross-metric analysis and historicalComparison for temporal context.

${featuresJson}`,
    };
  }

  const modeLabel =
    privacyMode === "raw"
      ? "Aggregierte Daten + Rohdaten (gesamter verfügbarer Zeitraum, anonymisiert)"
      : "Nur aggregierte Daten (keine exakten Zeitstempel oder Rohwerte)";

  return {
    systemPrompt: getGeneralStatusSystemPrompt(locale),
    userPrompt: `Analysiere die folgenden Gesundheitsdaten.
Datenmodus: ${modeLabel}
Beachte die coverage-Objekte jeder Metrik für Informationen zu Messhäufigkeit und Zeiträumen.
Nutze die correlations-Daten für Kreuzanalysen und historicalComparison für temporale Einordnung.

${featuresJson}`,
  };
}
