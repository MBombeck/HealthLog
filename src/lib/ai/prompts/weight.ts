import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const WEIGHT_SECTION_DE = `FACHSPEZIFISCH — GEWICHT:
- BMI-Kontext immer mitbewerten (Größe aus Profil, falls verfügbar).
- WHO BMI-Klassifikation: Untergewicht < 18.5, Normalgewicht 18.5-24.9, Übergewicht 25.0-29.9, Adipositas I 30.0-34.9, II 35.0-39.9, III ≥ 40.0.
- Trend-Analyse: 7-Tage, 30-Tage und 90-Tage gleitende Durchschnitte vergleichen.
- Plateau-Erkennung: Gewichtsveränderung < ±0.5 kg über > 14 Tage als Plateau identifizieren.
- Realistische Zielprojektion: Maximal 0.5-1.0 kg/Woche als nachhaltiger Gewichtsverlust (DGE-Empfehlung).
- Gewichts-Blutdruck-Korrelation: Nur erwähnen wenn weightVsSystolic im Snapshot vorhanden und |r| > 0.4. Pro kg Gewichtsreduktion ca. 1 mmHg systolische Senkung.
- Medikamenten-Einfluss: Gewichtsrelevante Medikamente identifizieren (z.B. Betablocker, Cortison).
- Tageszeit-Schwankungen: Morgen- vs. Abendmessungen differenzieren (1-2 kg normal).
- Vergleiche das aktuelle 7-Tage-Mittel (historicalComparison.weight.current7dAvg) mit dem 30-Tage-Baseline (previous30dAvg). Bei >2 kg Differenz: klinisch bewerten und Ursachen diskutieren.
- Plateau-Definition: <0.5 kg Veränderung über >14 Tage (prüfe ob avg7 ≈ avg30 ≈ avg90).
- Nutze allTimeMin/allTimeMax/allTimeAvg um den aktuellen Wert historisch einzuordnen.
- Gewichtsmeilensteine (klinisch signifikant):
  * 5% Verlust vom Startgewicht (allTimeMax): Metabolischer Benefit, KV-Risikoreduktion
  * 10% Verlust: Erheblicher klinischer Nutzen
  * Wenn erreicht: Explizit anerkennen und klinischen Kontext geben
- Zu schneller Verlust: > 1 kg/Woche über > 2 Wochen = Risiko für Muskelmasseverlust, nicht nachhaltig
- Body-Composition-Divergenz: Falls bodyCompositionDivergence.flag = true: "Gewicht stabil, aber Körperfettanteil steigend — möglicher Muskelmasseverlust. Krafttraining empfehlen."
- Schlaf-Gewicht-Verbindung: Falls sleep.avg7 < 6h UND weight.slope30 > 0: "Schlafmangel stört metabolische Regulation und kann Gewichtszunahme begünstigen."
- Inline-Chart: Bei einem klar gewichtsfokussierten summary- oder finding-Text kannst du genau einen Token (metric:WEIGHT, optional auch metric:BODY_FAT für Körperzusammensetzung) im Text einbetten, um das Diagramm darunter einzublenden.`;

const WEIGHT_SECTION_EN = `DOMAIN — WEIGHT:
- Always include BMI context (height from profile, if available).
- WHO BMI classification: Underweight < 18.5, Normal 18.5-24.9, Overweight 25.0-29.9, Obesity I 30.0-34.9, II 35.0-39.9, III ≥ 40.0.
- Trend analysis: Compare 7-day, 30-day and 90-day moving averages.
- Plateau detection: Flag a weight change < ±0.5 kg over > 14 days as a plateau.
- Realistic target projection: At most 0.5-1.0 kg/week is sustainable weight loss (DGE recommendation).
- Weight-BP correlation: Mention only if weightVsSystolic is present in the snapshot and |r| > 0.4. Roughly 1 mmHg systolic drop per kg lost.
- Medication influence: Identify weight-relevant medications (e.g. beta-blockers, cortisone).
- Time-of-day swings: Differentiate morning vs. evening readings (1-2 kg normal).
- Compare the current 7-day mean (historicalComparison.weight.current7dAvg) with the 30-day baseline (previous30dAvg). For deltas > 2 kg: assess clinically and discuss likely causes.
- Plateau definition: < 0.5 kg change over > 14 days (check whether avg7 ≈ avg30 ≈ avg90).
- Use allTimeMin/allTimeMax/allTimeAvg to anchor the current value historically.
- Weight milestones (clinically significant):
  * 5% loss from starting weight (allTimeMax): metabolic benefit, CV risk reduction
  * 10% loss: substantial clinical benefit
  * If reached: acknowledge explicitly and give clinical context
- Too rapid loss: > 1 kg/week sustained > 2 weeks = risk of muscle-mass loss, not sustainable
- Body-composition divergence: If bodyCompositionDivergence.flag = true: "Weight stable but body-fat percentage rising — possible muscle-mass loss. Recommend strength training."
- Sleep-weight link: If sleep.avg7 < 6h AND weight.slope30 > 0: "Sleep loss disrupts metabolic regulation and can favour weight gain."
- Inline chart: When a summary or finding text is centred on weight, embed exactly one token (metric:WEIGHT, or metric:BODY_FAT for body-composition findings) inside that text to inline the chart underneath.`;

export function getWeightSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? WEIGHT_SECTION_EN : WEIGHT_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getWeightUserPrompt(
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
Analyse the weight trajectory with focus on trends, BMI classification and links to other vital signs.
Use the temporal layers (avg7, avg30, avg90, allTime) and the historical comparison for a nuanced assessment.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Gewichtsentwicklung mit Fokus auf Trends, BMI-Klassifikation und Zusammenhang mit anderen Vitalwerten.
Nutze die temporalen Schichten (avg7, avg30, avg90, allTime) und den historischen Vergleich für eine differenzierte Bewertung.${ctxBlock}

${snapshotJson}`;
}
