export type InsightLocale = "de" | "en";

function getLocalizedText(
  locale: InsightLocale,
  de: string,
  en: string,
): string {
  return locale === "en" ? en : de;
}

export function getNoKeyGeneralStatusText(locale: InsightLocale): string {
  return getLocalizedText(
    locale,
    "Beobachte Entwicklungen über mehrere Wochen statt einzelne Tageswerte isoliert zu bewerten. Achte auf konsistente Messzeitpunkte, damit Trends belastbar vergleichbar bleiben. Reagiere früh, wenn sich mehrere Kennzahlen gleichzeitig in eine ungünstige Richtung bewegen.",
    "Track developments over several weeks instead of judging single daily values in isolation. Keep measurement timing consistent so trends remain comparable and reliable. React early when multiple metrics move in an unfavorable direction at the same time.",
  );
}

export function getNoKeyBloodPressureStatusText(locale: InsightLocale): string {
  return getLocalizedText(
    locale,
    "Miss den Blutdruck möglichst in Ruhe und unter vergleichbaren Bedingungen. Entscheidend ist die Tendenz über mehrere Tage, nicht ein einzelner Ausreißer. Beurteile systolische und diastolische Werte immer gemeinsam im zeitlichen Verlauf.",
    "Measure blood pressure at rest and under comparable conditions whenever possible. The multi-day trend matters more than a single outlier. Always evaluate systolic and diastolic values together over time.",
  );
}

export function getNoKeyWeightStatusText(locale: InsightLocale): string {
  return getLocalizedText(
    locale,
    "Bewerte Gewicht vor allem im Verlauf und nicht anhand einzelner Tage. Nutze möglichst konstante Messbedingungen, um normale Schwankungen besser einzuordnen. Wichtig ist die langfristige Richtung im Zusammenspiel mit Blutdruck und BMI.",
    "Evaluate weight mainly as a trend rather than by isolated daily readings. Use consistent measurement conditions to interpret normal fluctuations more reliably. What matters most is the long-term direction together with blood pressure and BMI.",
  );
}

export function getNoKeyPulseStatusText(locale: InsightLocale): string {
  return getLocalizedText(
    locale,
    "Miss den Ruhepuls in einer entspannten Situation und möglichst zur gleichen Tageszeit. Kurzfristige Ausschläge sind normal, wichtiger ist die Entwicklung über mehrere Tage. Achte auf wiederkehrende Abweichungen vom persönlichen Zielbereich.",
    "Measure resting pulse in a relaxed state and ideally at the same time of day. Short-term spikes are normal, while the multi-day pattern is more important. Watch for repeated deviations from your personal target range.",
  );
}

export function getNoKeyBmiStatusText(locale: InsightLocale): string {
  return getLocalizedText(
    locale,
    "Der BMI ist eine Orientierungsgröße und sollte immer zusammen mit Gewichtstrend und Körperfett betrachtet werden. Einzelwerte sind weniger wichtig als die Entwicklung über Wochen. Aussagekräftig sind vor allem stabile Verbesserungen oder dauerhafte Abweichungen.",
    "BMI is a directional metric and should always be viewed together with weight trend and body-fat context. Single values are less important than changes across weeks. The most meaningful signals are sustained improvements or persistent deviations.",
  );
}

export function getNoKeyMedicationComplianceStatusText(
  locale: InsightLocale,
): string {
  return getLocalizedText(
    locale,
    "Konstanz bei der Einnahme ist wichtiger als einzelne perfekte Tage. Beurteile die Treue pro Medikament und zusätzlich im Gesamtbild über mehrere Wochen. Achte besonders auf wiederkehrende Auslassungen und stabilisiere dafür feste Zeitfenster-Routinen.",
    "Consistency in intake matters more than isolated perfect days. Evaluate adherence per medication and also in the overall multi-week picture. Pay special attention to repeated misses and stabilize fixed time-window routines.",
  );
}

export function getNoKeyMoodStatusText(locale: InsightLocale): string {
  return getLocalizedText(
    locale,
    "Bewerte die Stimmung im Verlauf über mehrere Wochen statt einzelne Tage isoliert zu betrachten. Achte auf wiederkehrende Muster und Zusammenhänge mit anderen Gesundheitswerten. Anhaltende Phasen niedriger Stimmung verdienen besondere Aufmerksamkeit.",
    "Evaluate mood trends over several weeks rather than isolated daily readings. Watch for recurring patterns and correlations with other health metrics. Sustained periods of low mood deserve special attention.",
  );
}
