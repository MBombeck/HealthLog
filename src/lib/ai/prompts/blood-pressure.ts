import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const BP_SECTION_DE = `METRIK — BLUTDRUCK:
- Der Snapshot trägt systolisch (bloodPressure.systolic) und diastolisch (bloodPressure.diastolic) jeweils mit summary + graded series; beurteile beide Komponenten GEMEINSAM, nie isoliert.
- Tendenz über Tage/Wochen: Vergleiche das recent-Mittel (letzte Tage/Woche) mit dem weekly/monthly-Mittel der Person. Eine systolische Abweichung gilt ab ~5 mmHg, eine diastolische ab ~3 mmHg gegenüber der eigenen Baseline als signifikant — kleinere Schwankungen sind normal und kein Befund.
- Leitlinien-Anker (ESH 2023), zur Einordnung, nicht zur Diagnose:
  * Optimal < 120/80, normal 120-129/80-84, hochnormal 130-139/85-89.
  * Hypertonie Grad 1 ab 140/90, Grad 2 ab 160/100, Grad 3 ab 180/110.
  * Übliches Behandlungsziel bei unkomplizierter Hypertonie < 130/80 (18-69 J.), < 140/80 (≥ 70 J.).
- targets: Falls bloodPressure.targets vorhanden, ordne gegen das persönliche Zielband ein; inTargetPctLast30DailyPoints ist der Anteil der letzten Tage im Ziel.
- Medikamenten-Bezug: bpMedications trägt compliance7/compliance30. bpMedicationContinuityVsSystolic.correlation und weightVsSystolic.correlation nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache.
- Stimmung: moodContext.moodVsSystolicCorrelation nur erwähnen, wenn vorhanden und |r| > 0.4.
- Eine Botschaft: Wenn die Werte über der Baseline liegen, schließe mit EINEM machbaren Schritt (z.B. ein paar Tage zur selben Uhrzeit nachmessen, oder — bei lückenhafter Einnahmetreue — die Einnahme verlässlicher machen). Bei stabilen Werten im Ziel: das ehrlich anerkennen.`;

const BP_SECTION_EN = `METRIC — BLOOD PRESSURE:
- The snapshot carries systolic (bloodPressure.systolic) and diastolic (bloodPressure.diastolic), each with a summary + graded series; judge both components TOGETHER, never in isolation.
- Trend over days/weeks: compare the recent mean (last days/week) with the person's weekly/monthly mean. Treat a systolic shift of ~5 mmHg or a diastolic shift of ~3 mmHg against their own baseline as significant — smaller swings are normal and not a finding.
- Guideline anchors (ESH 2023), for placement, not diagnosis:
  * Optimal < 120/80, normal 120-129/80-84, high-normal 130-139/85-89.
  * Hypertension grade 1 from 140/90, grade 2 from 160/100, grade 3 from 180/110.
  * Common treatment target for uncomplicated hypertension < 130/80 (age 18-69), < 140/80 (age ≥ 70).
- targets: if bloodPressure.targets is present, place values against the personal target band; inTargetPctLast30DailyPoints is the share of recent days in target.
- Medication link: bpMedications carries compliance7/compliance30. Mention bpMedicationContinuityVsSystolic.correlation and weightVsSystolic.correlation only when present and |r| > 0.4 — as an association, never a cause.
- Mood: mention moodContext.moodVsSystolicCorrelation only when present and |r| > 0.4.
- One message: if the values sit above the person's baseline, close with ONE doable step (e.g. take a few readings at the same time of day for a few days, or — when adherence is patchy — make the medication routine more reliable). When values are stable and in target, say so honestly.`;

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
Write one short assessment of this person's blood pressure: name the current systolic/diastolic level, place the recent days against their own weekly/monthly baseline, and close with one doable step. Judge confidence from the measurement count and recency.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung zum Blutdruck dieser Person: benenne das aktuelle systolisch/diastolisch-Niveau, ordne die jüngsten Tage gegen die eigene Wochen-/Monats-Baseline ein und schließe mit einem machbaren Schritt. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}

${snapshotJson}`;
}
