import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const MEDCO_SECTION_DE = `FACHSPEZIFISCH — MEDIKAMENTEN-ADHÄRENZ:
- Einnahmetreue-Bewertung:
  * ≥ 90%: Ausgezeichnete Adhärenz
  * 80-89%: Gute Adhärenz
  * 70-79%: Moderate Adhärenz — therapeutische Wirksamkeit möglicherweise eingeschränkt
  * < 70%: Unzureichende Adhärenz — wahrscheinlich subtherapeutische Wirkung
- Muster-Analyse: Morgen- vs. Abendeinnahme getrennt bewerten (Abenddosen werden häufiger vergessen).
- Streak-Tracking: Längste ununterbrochene Einnahmeperiode identifizieren und hervorheben.
- Wochenend-Effekt: Einnahmetreue an Wochenenden vs. Wochentagen vergleichen.
- Wirksamkeits-Korrelation: Direkte Verbindung zwischen Einnahmetreue und Vitalwert-Veränderungen herstellen.
  * Beispiel: "In Wochen mit > 90% Einnahmetreue war der mittlere systolische RR 5 mmHg niedriger."
- Verpasste Dosen: Konsequenzen differenzieren (Antihypertensiva-Rebound vs. Statine = weniger zeitkritisch).
- Motivierende Gesprächsführung: Positive Formulierungen bevorzugen, Fortschritte anerkennen.
- Vergleiche Perioden hoher Adhärenz (>90%) mit den zugehörigen Vitalwerten. Zeige konkret: "In Wochen mit >90% Einnahmetreue war der systolische RR X mmHg niedriger."
- Korrelationen nur erwähnen wenn der r-Wert im Snapshot vorhanden und |r| > 0.4 ist. Falls das Feld nicht im Snapshot vorhanden ist, keine Korrelation interpretieren oder erfinden.
- Nutze historicalComparison um den Einfluss der Adhärenz auf Blutdruck und Puls zu quantifizieren, sofern die Daten im Snapshot vorhanden sind.
- Falls Stimmungsdaten verfügbar und Korrelation |r| > 0.4: Prüfe ob niedrige Adhärenz mit schlechterer Stimmung korreliert.
- Chronotherapie-Hinweis: Falls ein Blutdruck-Medikament vorhanden ist UND Compliance > 90% ABER BP nicht im Zielbereich: "Einnahme-Zeitpunkt mit dem Arzt besprechen — abendliche Einnahme kann bei einigen Patienten die nächtliche Blutdruckkontrolle verbessern."
- Mood-Adhärenz-Risiko: Falls moodAdherenceRisk = true: "Deine Stimmung war in den letzten Tagen niedrig. Erfahrungsgemäß kann das die Einnahmetreue in den kommenden Tagen beeinflussen. Tipp: Lege die Medikamente abends schon bereit."`;

const MEDCO_SECTION_EN = `DOMAIN — MEDICATION ADHERENCE:
- Adherence rating:
  * ≥ 90%: Excellent adherence
  * 80-89%: Good adherence
  * 70-79%: Moderate adherence — therapeutic effect possibly reduced
  * < 70%: Insufficient adherence — likely subtherapeutic effect
- Pattern analysis: Score morning vs. evening doses separately (evening doses are missed more often).
- Streak tracking: Identify and highlight the longest uninterrupted intake streak.
- Weekend effect: Compare weekend vs. weekday adherence.
- Effectiveness correlation: Draw a direct link between adherence and vital-sign movement.
  * Example: "In weeks with > 90% adherence the mean systolic BP was 5 mmHg lower."
- Missed doses: Differentiate consequences (antihypertensive rebound vs. statins = less time-critical).
- Motivational interviewing: Prefer positive framing, acknowledge progress.
- Compare periods of high adherence (>90%) with the corresponding vitals. Be concrete: "In weeks with >90% adherence systolic BP was X mmHg lower."
- Mention correlations only if the r-value is present in the snapshot and |r| > 0.4. If the field is missing, do not interpret or invent a correlation.
- Use historicalComparison to quantify how adherence affects blood pressure and pulse, where data is available.
- If mood data is available and the correlation |r| > 0.4: Check whether low adherence aligns with worse mood.
- Chronotherapy note: If a BP medication exists AND compliance > 90% BUT BP is off target: "Discuss timing with your doctor — for some patients, evening dosing improves nocturnal BP control."
- Mood-adherence risk: If moodAdherenceRisk = true: "Your mood has been low recently. Experience shows this can affect adherence over the next few days. Tip: prepare your medication the evening before."`;

export function getMedicationComplianceSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? MEDCO_SECTION_EN : MEDCO_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getMedicationComplianceUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
): string {
  const ctxBlock =
    previousContextBlock && previousContextBlock.trim().length > 0
      ? `\n\n${previousContextBlock}\n`
      : "";
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Analyse medication adherence with focus on patterns, effectiveness correlation and concrete suggestions for improvement.
Use the correlation data and historical comparison to back up the link between adherence and vital signs.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Medikamenten-Einnahmetreue mit Fokus auf Muster, Wirksamkeitskorrelation und konkrete Verbesserungsvorschläge.
Nutze die Korrelationsdaten und den historischen Vergleich um den Zusammenhang zwischen Adhärenz und Vitalwerten zu belegen.${ctxBlock}

${snapshotJson}`;
}
