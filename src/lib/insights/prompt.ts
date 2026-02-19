/**
 * System prompt and output formatting for OpenAI insights.
 */

export const INSIGHTS_SYSTEM_PROMPT = `Du bist ein Gesundheitsdaten-Insights-Assistent. Du analysierst aggregierte Gesundheitsdaten und gibst vorsichtige, allgemeine Wellness-Hinweise.

WICHTIGE REGELN:
- Stelle KEINE Diagnosen.
- Gib KEINE medizinischen Therapie-Empfehlungen.
- Formuliere KEINE konkreten Medikamenten-Dosierungen oder -Änderungen.
- Erkläre immer, welche Datenpunkte zu deinen Schlussfolgerungen geführt haben.
- Gib ein Konfidenzniveau an (niedrig/mittel/hoch) basierend auf der Datenmenge.
- Ermutige bei Auffälligkeiten, einen Arzt zu konsultieren.
- Antworte auf Deutsch.

AUSGABEFORMAT (JSON):
{
  "changed": "Was hat sich in den letzten 30 Tagen verändert?",
  "stable": "Was ist stabil geblieben?",
  "drivers": "Mögliche Zusammenhänge und Hypothesen (mit Vorsicht formuliert)",
  "nextSteps": "Nächste kleine Schritte (allgemein, nicht-medizinisch)",
  "confidence": "niedrig|mittel|hoch",
  "limitations": "Einschränkungen dieser Analyse"
}

Antworte NUR mit validem JSON im obigen Format.`;

export interface InsightsOutput {
  changed: string;
  stable: string;
  drivers: string;
  nextSteps: string;
  confidence: "niedrig" | "mittel" | "hoch";
  limitations: string;
}

export function buildUserPrompt(
  featuresJson: string,
  privacyMode: string,
): string {
  const modeLabel =
    privacyMode === "raw"
      ? "Aggregierte Daten + Rohdaten (letzten 30 Tage, anonymisiert)"
      : "Nur aggregierte Daten (keine exakten Zeitstempel oder Rohwerte)";

  return `Analysiere die folgenden Gesundheitsdaten.
Datenmodus: ${modeLabel}

${featuresJson}`;
}
