import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const BP_SECTION_DE = `FACHSPEZIFISCH — BLUTDRUCK:
- Klassifikation nach ESH 2023:
  * Optimal: < 120/80 mmHg
  * Normal: 120-129/80-84 mmHg
  * Hochnormal: 130-139/85-89 mmHg
  * Hypertonie Grad 1: 140-159/90-99 mmHg
  * Hypertonie Grad 2: 160-179/100-109 mmHg
  * Hypertonie Grad 3: ≥ 180/≥ 110 mmHg
  * Isolierte systolische Hypertonie: ≥ 140/< 90 mmHg
- Zielwerte: Bei unkomplizierter Hypertonie Ziel < 130/80 mmHg (18-69 Jahre), < 140/80 mmHg (≥ 70 Jahre).
- Morning Surge: Morgendlicher Blutdruckanstieg > 20 mmHg systolisch als Risikofaktor identifizieren.
- Pulsdruck: (Systolisch - Diastolisch) > 60 mmHg als Marker für arterielle Steifigkeit bewerten.
- Medikamenten-Korrelation: Einnahmetreue von Antihypertensiva mit Blutdruckverlauf korrelieren.
- Gewichts-Korrelation: Gewichtstrend mit Blutdruckverlauf vergleichen (pro kg Gewichtsverlust ca. 1 mmHg Senkung erwartet).
- Stimmungs-Korrelation: Nur erwähnen wenn moodVsSystolicCorrelation im Snapshot vorhanden und |r| > 0.4. Falls nicht vorhanden, keine Korrelation interpretieren.
- weightVsSystolic-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4. Pro kg Gewichtsreduktion kann 1 mmHg systolische Senkung erwartet werden.
- weightVsDiastolic-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4.
- Vergleiche avgSys30 und avgSys90 sowie allTimeAvg um langfristige Trends zu erkennen.
- Nutze historicalComparison.systolic und historicalComparison.diastolic: Bei ≥5 mmHg systolischer bzw. ≥3 mmHg diastolischer Veränderung klinisch bewerten.
- Morgen-Risikoleiter (J-HOP Studie):
  * Morgen-RR 135-144: Schlaganfall-HR 2.45
  * Morgen-RR 145-154: HR 2.80
  * Morgen-RR 155-164: HR 3.58
  * Morgen-RR ≥ 165: HR 6.52
- Rate-Pressure Product: Wenn ratePressureProduct.rpp30 > 12.000: "Erhöhter kardialer Sauerstoffbedarf" mit assessment "warning" bewerten.
- Saisonale Variation: Falls seasonalVariation vorhanden und delta > 5 mmHg: "Physiologisch normale saisonale Schwankung — kein Grund zur Sorge, ggf. Winter-Dosisanpassung besprechen."
- Salz-Signal: Akuter Gewichtsanstieg ≥ 1 kg in 3 Tagen + systolischer Anstieg ≥ 5 mmHg = mögliche erhöhte Natriumzufuhr.
- Inline-Chart: Wenn die summary oder ein finding-Text klar auf eine einzelne Blutdruck-Komponente zielt, kannst du genau einen Token (metric:BLOOD_PRESSURE_SYS oder metric:BLOOD_PRESSURE_DIA) im Text einbetten, um das Diagramm darunter einzublenden.`;

const BP_SECTION_EN = `DOMAIN — BLOOD PRESSURE:
- ESH 2023 classification:
  * Optimal: < 120/80 mmHg
  * Normal: 120-129/80-84 mmHg
  * High-normal: 130-139/85-89 mmHg
  * Hypertension grade 1: 140-159/90-99 mmHg
  * Hypertension grade 2: 160-179/100-109 mmHg
  * Hypertension grade 3: ≥ 180/≥ 110 mmHg
  * Isolated systolic hypertension: ≥ 140/< 90 mmHg
- Targets: For uncomplicated hypertension aim for < 130/80 mmHg (age 18-69), < 140/80 mmHg (age ≥ 70).
- Morning surge: Identify a morning systolic rise > 20 mmHg as a risk factor.
- Pulse pressure: (systolic - diastolic) > 60 mmHg flagged as a marker of arterial stiffness.
- Medication correlation: Correlate antihypertensive adherence with blood-pressure trajectory.
- Weight correlation: Compare weight trend with BP trajectory (~1 mmHg drop expected per kg lost).
- Mood correlation: Mention only if moodVsSystolicCorrelation is present in the snapshot and |r| > 0.4. Otherwise do not interpret a correlation.
- weightVsSystolic correlation: Analyse only if present and |r| > 0.4. Roughly 1 mmHg systolic drop per kg lost.
- weightVsDiastolic correlation: Analyse only if present and |r| > 0.4.
- Compare avgSys30 and avgSys90 with allTimeAvg to surface long-term trends.
- Use historicalComparison.systolic and historicalComparison.diastolic: rate ≥5 mmHg systolic or ≥3 mmHg diastolic deltas clinically.
- Morning risk ladder (J-HOP study):
  * Morning BP 135-144: stroke HR 2.45
  * Morning BP 145-154: HR 2.80
  * Morning BP 155-164: HR 3.58
  * Morning BP ≥ 165: HR 6.52
- Rate-pressure product: If ratePressureProduct.rpp30 > 12,000, label "Elevated cardiac oxygen demand" with assessment "warning".
- Seasonal variation: If seasonalVariation is present and delta > 5 mmHg: "Physiologically normal seasonal swing — no cause for concern, optionally discuss a winter dose adjustment."
- Salt signal: Acute weight gain ≥ 1 kg over 3 days plus systolic rise ≥ 5 mmHg = possible elevated sodium intake.
- Inline chart: If the summary or a finding text centres on a single BP component, embed exactly one token (metric:BLOOD_PRESSURE_SYS or metric:BLOOD_PRESSURE_DIA) inside that text to inline the chart beneath it.`;

export function getBloodPressureSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? BP_SECTION_EN : BP_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getBloodPressureUserPrompt(
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
Analyse the following blood-pressure data with focus on trends, target attainment and medication effectiveness.
Account for measurement timing and density when judging confidence.
Use the precomputed correlations and historicalComparison for a sound temporal assessment.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die folgenden Blutdruck-Daten mit Fokus auf Trends, Zielwerterreichung und Medikamentenwirksamkeit.
Berücksichtige die Messzeiträume und Datendichte für die Konfidenzeinschätzung.
Nutze die vorberechneten Korrelationen (correlations) und den historischen Vergleich (historicalComparison) für eine fundierte temporale Analyse.${ctxBlock}

${snapshotJson}`;
}
