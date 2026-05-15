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
- Aktivität: Falls activity-Daten vorhanden, Schrittzahl bewerten (≥ 8.000/Tag — Saint-Maurice et al., JAMA 2020; Mortalitäts-Plateau 8.000–12.000). Hinweis: WHO publiziert Aktivitätszeit (Min/Woche), KEIN Schritt-Soll — bitte keine "WHO ≥ 8.000 Schritte"-Formulierung. Zusammenhang mit Puls- und Gewichtstrend herstellen.
- Rate-Pressure Product: Falls ratePressureProduct vorhanden, als Indikator für kardiale Belastung in die Risikostratifizierung einbeziehen. > 12.000 = erhöhter myokardialer Sauerstoffbedarf.
- Body-Composition-Divergenz: Falls bodyCompositionDivergence.flag = true, als Frühzeichen für sarkopenische Adipositas in die Gesamtbewertung aufnehmen.
- Saisonale Variation: Falls seasonalVariation vorhanden, saisonale Blutdruckschwankungen kontextualisieren und ggf. beruhigend einordnen.
- Inline-Chart: Wenn die summary oder ein finding klar auf eine einzelne Metrik fokussiert (z.B. einen kritischen systolischen Trend), kannst du genau einen passenden Token aus der Allowlist im Text einbetten — der erste klar metrik-zentrierte Absatz erhält das Diagramm darunter.`;

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
- Activity: When activity data is present, evaluate step count (≥ 8,000/day — Saint-Maurice et al., JAMA 2020; benefit accumulates through ~12,000 steps/day, not a plateau). Note: WHO publishes activity *time* (min/week), NOT a step quota — do not phrase the target as "WHO ≥ 8,000 steps". Tie back to pulse and weight trends.
- Rate-pressure product: When ratePressureProduct is present, include it as a cardiac-load indicator. > 12,000 = elevated myocardial oxygen demand.
- Body-composition divergence: If bodyCompositionDivergence.flag = true, treat as an early sign of sarcopenic obesity.
- Seasonal variation: When seasonalVariation is present, contextualise seasonal BP swings and reassure where appropriate.
- Inline chart: When a summary or finding centres on a single metric (e.g. a critical systolic trend), embed exactly one matching token from the allowlist in the text — the first clearly metric-focused paragraph receives the chart underneath.`;

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
Produce a comprehensive overall assessment across every available health metric.
Focus on the interplay between parameters and identify the single most important call to action.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Erstelle eine umfassende Gesamtbewertung aller verfügbaren Gesundheitsdaten.
Fokussiere auf das Zusammenspiel der verschiedenen Parameter und identifiziere die wichtigste Handlungsempfehlung.${ctxBlock}

${snapshotJson}`;
}

