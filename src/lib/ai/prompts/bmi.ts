import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const BMI_SECTION_DE = `FACHSPEZIFISCH — BMI:
- WHO-Klassifikation strikt anwenden:
  * Untergewicht: < 18.5
  * Normalgewicht: 18.5 - 24.9
  * Übergewicht (Präadipositas): 25.0 - 29.9
  * Adipositas Grad I: 30.0 - 34.9
  * Adipositas Grad II: 35.0 - 39.9
  * Adipositas Grad III: ≥ 40.0
- Altersadjustierung: Ab 65+ gilt BMI 22-27 als optimal (DEGAM).
- Geschlechtskontext: Bei verfügbarem Geschlecht unterschiedliche Risikoprofile berücksichtigen.
- Trend wichtiger als Momentaufnahme: BMI-Entwicklung über 30/90 Tage gewichten.
- Limitationen des BMI: Kein Maß für Körperzusammensetzung. Bei Sportlern oder muskulösen Personen eingeschränkt aussagekräftig — darauf hinweisen.
- Zusammenhang mit Blutdruck und Puls: Übergewicht als Risikofaktor für Hypertonie einordnen.`;

const BMI_SECTION_EN = `DOMAIN — BMI:
- Apply WHO classification strictly:
  * Underweight: < 18.5
  * Normal weight: 18.5 - 24.9
  * Overweight (pre-obesity): 25.0 - 29.9
  * Obesity class I: 30.0 - 34.9
  * Obesity class II: 35.0 - 39.9
  * Obesity class III: ≥ 40.0
- Age adjustment: From age 65+, BMI 22-27 counts as optimal (DEGAM).
- Sex context: When sex is known, factor in different risk profiles.
- Trend over snapshot: Weight 30- and 90-day BMI trajectories more heavily than a single value.
- BMI limitations: Not a measure of body composition. Less informative for athletes or very muscular people — point this out.
- Relation to blood pressure and pulse: Treat overweight as a risk factor for hypertension.`;

export function getBmiSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? BMI_SECTION_EN : BMI_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getBmiUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
): string {
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Analyse the BMI trajectory taking age, sex and weight trend into account. Place the WHO classification.

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere den BMI-Verlauf unter Berücksichtigung von Alter, Geschlecht und Gewichtstrend. Ordne die Klassifikation nach WHO ein.

${snapshotJson}`;
}
