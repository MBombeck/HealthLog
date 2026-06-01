import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const PULSE_SECTION_DE = `METRIK — PULS / HERZFREQUENZ:
- Der Snapshot trägt pulse.summary + pulse.series (graded) und pulse.target (greenMin/greenMax/orangeMin/orangeMax, inTargetPctLast30DailyPoints). pulse.latestDayFocus zeigt den jüngsten Tageswert und den Schritt zum Vortag.
- Tendenz über Wochen: Vergleiche das recent-Mittel mit dem weekly/monthly-Mittel der Person. Eine Abweichung ab ~5 bpm gegenüber der eigenen Baseline ist signifikant; eine Variabilität < 5 bpm über die letzten Tage ist normal und kein Befund.
- Richtung: Ein über Wochen sinkender Ruhepuls deutet auf bessere kardiovaskuläre Fitness; ein steigender kann auf Stress, Schlafmangel oder Übertraining hinweisen — als mögliche Erklärung, nie als Diagnose.
- Einordnungs-Anker (Ruhepuls): athletisch 50-60, normal 60-100. Werte im Band 80-100 sind technisch normal, langfristig aber günstiger niedriger. < 50 oder > 100 über mehrere Tage ist erwähnenswert, ohne zu alarmieren.
- Medikamenten-Bezug: Betablocker senken die Herzfrequenz. moodContext.moodVsPulseCorrelation und ein pulseVsSystolic-Zusammenhang nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache.
- Eine Botschaft: Liegt der Ruhepuls über der eigenen Baseline, schließe mit EINEM machbaren Schritt (z.B. ein paar Tage morgens vor dem Aufstehen messen, um eine saubere Ruhe-Baseline zu bekommen). Verbessert er sich, erkenne das ehrlich an.`;

const PULSE_SECTION_EN = `METRIC — PULSE / HEART RATE:
- The snapshot carries pulse.summary + pulse.series (graded) and pulse.target (greenMin/greenMax/orangeMin/orangeMax, inTargetPctLast30DailyPoints). pulse.latestDayFocus shows the latest daily value and the step from the prior day.
- Trend over weeks: compare the recent mean with the person's weekly/monthly mean. A shift of ~5 bpm against their own baseline is significant; variability < 5 bpm across the recent days is normal and not a finding.
- Direction: a resting pulse falling over weeks suggests improving cardiovascular fitness; a rising one can point to stress, sleep loss or overtraining — as a possible explanation, never a diagnosis.
- Placement anchors (resting pulse): athletic 50-60, normal 60-100. Values in the 80-100 band are technically normal but tend to be more favourable lower over the long run. < 50 or > 100 across several days is worth noting without alarm.
- Medication link: beta-blockers lower heart rate. Mention moodContext.moodVsPulseCorrelation and any pulse-vs-systolic association only when present and |r| > 0.4 — as an association, never a cause.
- One message: if the resting pulse sits above the person's baseline, close with ONE doable step (e.g. take readings on waking for a few days to get a clean resting baseline). If it is improving, acknowledge that honestly.`;

export function getPulseSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? PULSE_SECTION_EN : PULSE_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getPulseUserPrompt(
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
Write one short assessment of this person's resting pulse: name the current level, place the recent days against their own weekly/monthly baseline, and close with one doable step. Judge confidence from the measurement count and recency.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung zum Ruhepuls dieser Person: benenne das aktuelle Niveau, ordne die jüngsten Tage gegen die eigene Wochen-/Monats-Baseline ein und schließe mit einem machbaren Schritt. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}

${snapshotJson}`;
}
