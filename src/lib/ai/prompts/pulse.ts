import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const PULSE_SECTION_DE = `FACHSPEZIFISCH — PULS/HERZFREQUENZ:
- Ruhepuls-Zonen:
  * Bradykardie: < 50 bpm (bei Sportlern normal, sonst abklärungsbedürftig)
  * Athletisch: 50-60 bpm
  * Normal: 60-100 bpm
  * Tachykardie: > 100 bpm (abklärungsbedürftig)
- Trend-Stabilität: Ruhepuls-Variabilität < 5 bpm über 7 Tage ist normal.
- Stress-Indikatoren: Steigende Ruheherzfrequenz kann auf Stress, Schlafmangel oder Übertraining hinweisen.
- Erholung: Sinkender Ruhepuls über Wochen deutet auf verbesserte kardiovaskuläre Fitness hin.
- Medikamenten-Einfluss: Betablocker senken die Herzfrequenz — Compliance-Korrelation prüfen.
- Blutdruck-Korrelation: Puls × systolischen Druck = Doppelprodukt als Herzbelastungsindikator.
- Stimmungs-Korrelation: Chronischer Stress kann Ruhepuls erhöhen. Nur erwähnen wenn moodVsPulse-Korrelation im Snapshot vorhanden und |r| > 0.4.
- moodVsPulse-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4. Falls nicht vorhanden, keine Korrelation interpretieren.
- pulseVsSystolic-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4. Bewertung der hämodynamischen Kopplung.
- Vergleiche avg7 vs avg30 vs avg90 vs allTimeAvg um kurzfristige Abweichungen von der Langzeit-Baseline zu erkennen.
- Nutze historicalComparison.pulse: Bei ≥5 bpm Veränderung gegenüber der Baseline klinisch bewerten.
- Fitness-Interpretation:
  * slope30 < -0.2 bpm/Tag (≈ -6 bpm/Monat): Positives Fitness-Signal, kardiovaskuläre Verbesserung
  * slope30 > +0.2 bpm/Tag (≈ +6 bpm/Monat) OHNE Stimmungsabfall: Mögliche Dekonditionierung
  * slope30 > +0.2 bpm/Tag MIT moodVsPulse r > 0.4: Stressbedingte Pulserhöhung
- Risikoband 80-100 bpm: Technisch "normal", aber erhöhtes CV-Risiko (+6-9% Mortalität pro 10 bpm, Meta-Analyse).
- Resting HR > 90 bpm: Unabhängiger Mortalitätsprädiktor — als eigenes Finding mit assessment "warning" erfassen.`;

const PULSE_SECTION_EN = `DOMAIN — PULSE / HEART RATE:
- Resting-pulse zones:
  * Bradycardia: < 50 bpm (normal in athletes, otherwise needs evaluation)
  * Athletic: 50-60 bpm
  * Normal: 60-100 bpm
  * Tachycardia: > 100 bpm (needs evaluation)
- Trend stability: Resting-pulse variability < 5 bpm over 7 days is normal.
- Stress indicators: A rising resting heart rate can point to stress, sleep loss or overtraining.
- Recovery: A falling resting pulse over weeks suggests improved cardiovascular fitness.
- Medication influence: Beta-blockers lower heart rate — check the compliance correlation.
- BP correlation: Pulse × systolic = rate-pressure product as a cardiac-load indicator.
- Mood correlation: Chronic stress can elevate resting pulse. Mention only if moodVsPulse correlation is present and |r| > 0.4.
- moodVsPulse correlation: Analyse only if present and |r| > 0.4. Otherwise do not interpret.
- pulseVsSystolic correlation: Analyse only if present and |r| > 0.4. Score haemodynamic coupling.
- Compare avg7 vs avg30 vs avg90 vs allTimeAvg to detect short-term deviations from the long-term baseline.
- Use historicalComparison.pulse: Score deltas ≥ 5 bpm against the baseline clinically.
- Fitness interpretation:
  * slope30 < -0.2 bpm/day (≈ -6 bpm/month): positive fitness signal, cardiovascular improvement
  * slope30 > +0.2 bpm/day (≈ +6 bpm/month) WITHOUT mood drop: possible deconditioning
  * slope30 > +0.2 bpm/day WITH moodVsPulse r > 0.4: stress-driven pulse rise
- Risk band 80-100 bpm: Technically "normal", but elevated CV risk (+6-9% mortality per 10 bpm, meta-analysis).
- Resting HR > 90 bpm: Independent mortality predictor — capture as its own finding with assessment "warning".`;

export function getPulseSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? PULSE_SECTION_EN : PULSE_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getPulseUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
): string {
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Analyse the pulse / heart-rate data with focus on resting-pulse trend, variability and links to medication and mood.
Use the precomputed correlations and historical comparison for a sound analysis.

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Puls-/Herzfrequenzdaten mit Fokus auf Ruhepulstrend, Variabilität und Zusammenhänge mit Medikation und Stimmung.
Nutze die vorberechneten Korrelationen und den historischen Vergleich für eine fundierte Analyse.

${snapshotJson}`;
}
