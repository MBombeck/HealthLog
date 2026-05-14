import { moodStabilityLabel } from "@/lib/targets/mood-stability-label";
import type { Locale } from "@/lib/i18n/config";

/**
 * v1.4.25 W3e — per-target Coach prompt builder.
 *
 * Returns a locale-appropriate pre-filled question that seeds the
 * Coach drawer's composer when the user clicks "Ask Coach about this"
 * on a target card. The prompt mentions the live current value, the
 * target range, the user's last-7-day cadence, and the streak (when
 * present) so the model has enough context to give a grounded answer
 * even before the snapshot lands.
 *
 * Prompts are deliberately question-shaped (not instructions). The
 * user can rewrite freely; the prefill exists to remove the
 * cold-start friction of typing the same question every time.
 *
 * Six metric templates × two locales = 12 prompts. Glucose contexts
 * fall back to the "general" template so we don't ship a four-way
 * context-aware glucose prompt before the iOS rollout decides whether
 * to surface glucose-by-context in the iOS Targets view.
 *
 * NOTE on PROMPT_VERSION: the Coach prompt itself (the system prompt
 * the model sees) does NOT change with this addition. The pre-fill is
 * just text the user can edit before sending. PROMPT_VERSION ratchets
 * when the assistant-facing prompt shifts; pre-fills do not, so we
 * leave PROMPT_VERSION at 4.23.0. Confirm with Marc if a future
 * change makes this prefill the canonical first turn.
 */
export interface TargetPromptInput {
  type: string;
  /**
   * v1.4.25 W9e — accepts every shipped locale. Templates exist for
   * DE and EN today; non-DE locales fall through to the EN body until
   * proper FR/ES/IT/PL pre-fills land.
   */
  locale: Locale;
  current: number | null;
  range: { min: number; max: number } | null;
  unit: string;
  status: string | null;
  streakDays: number;
  daysInRange7d: number;
}

type Template = (input: TargetPromptInput) => string;

function fmt(value: number | null, decimals = 1): string {
  if (value == null) return "—";
  return Number(value.toFixed(decimals)).toString();
}

const TEMPLATES_EN: Record<string, Template> = {
  BLOOD_PRESSURE: (i) =>
    `My latest blood pressure reading is ${fmt(i.current, 0)} mmHg systolic and my target band is ${i.range ? `${i.range.min}–${i.range.max} mmHg` : "not set"}. Over the last 7 days I've hit the band on ${i.daysInRange7d} days${i.streakDays >= 3 ? ` (current streak: ${i.streakDays} days)` : ""}. What should I focus on this week?`,
  BLOOD_PRESSURE_IN_TARGET: (i) =>
    `My blood pressure has been in target ${i.daysInRange7d} of the last 7 days${i.streakDays >= 3 ? ` (current streak: ${i.streakDays} days)` : ""}. Walk me through what's driving the trend and what I should change.`,
  WEIGHT: (i) =>
    `My current weight is ${fmt(i.current)} ${i.unit} and my healthy range is ${i.range ? `${i.range.min}–${i.range.max} ${i.unit}` : "not set"}. Over the last 7 days I've been in range on ${i.daysInRange7d} days. What should I focus on?`,
  PULSE: (i) =>
    `My resting pulse is ${fmt(i.current, 0)} ${i.unit} (target band ${i.range ? `${i.range.min}–${i.range.max} ${i.unit}` : "not set"}). How does this compare to a healthy pattern for me and what should I watch for?`,
  BMI: (i) =>
    `My current BMI is ${fmt(i.current)} ${i.unit} and the healthy range is ${i.range ? `${i.range.min}–${i.range.max}` : "18.5–24.9"}. How am I trending and what should I focus on?`,
  MOOD_SCORE: (i) =>
    `My latest mood score is ${fmt(i.current)} / 5 and my target is ${i.range ? `${i.range.min}+ / 5` : "3.5+ / 5"}. How does my mood compare to recent weeks and what could I try?`,
  MOOD_STABILITY: (i) => {
    const label = i.current != null ? moodStabilityLabel(i.current) : "stable";
    const verbal =
      label === "stable"
        ? "stable"
        : label === "variable"
          ? "variable"
          : "highly variable";
    return `My mood pattern is currently ${verbal}. What does this mean for me and what should I keep an eye on?`;
  },
  MEDICATION_COMPLIANCE: (i) =>
    `My medication adherence is ${fmt(i.current, 0)}% over the last 7 days${i.streakDays >= 3 ? ` (current streak: ${i.streakDays} days at goal)` : ""}. What can I change in my routine?`,
};

const TEMPLATES_DE: Record<string, Template> = {
  BLOOD_PRESSURE: (i) =>
    `Mein letzter Blutdruck-Wert liegt bei ${fmt(i.current, 0)} mmHg systolisch, mein Zielbereich ist ${i.range ? `${i.range.min}–${i.range.max} mmHg` : "nicht festgelegt"}. In den letzten 7 Tagen war ich an ${i.daysInRange7d} Tagen im Bereich${i.streakDays >= 3 ? ` (aktuelle Serie: ${i.streakDays} Tage)` : ""}. Worauf sollte ich diese Woche achten?`,
  BLOOD_PRESSURE_IN_TARGET: (i) =>
    `Mein Blutdruck war an ${i.daysInRange7d} von 7 Tagen im Zielbereich${i.streakDays >= 3 ? ` (aktuelle Serie: ${i.streakDays} Tage)` : ""}. Erklär mir bitte, was den Trend treibt und was ich ändern sollte.`,
  WEIGHT: (i) =>
    `Mein aktuelles Gewicht ist ${fmt(i.current)} ${i.unit}, mein gesunder Bereich liegt bei ${i.range ? `${i.range.min}–${i.range.max} ${i.unit}` : "nicht festgelegt"}. In den letzten 7 Tagen war ich an ${i.daysInRange7d} Tagen im Bereich. Worauf sollte ich mich konzentrieren?`,
  PULSE: (i) =>
    `Mein Ruhepuls ist ${fmt(i.current, 0)} ${i.unit} (Zielbereich ${i.range ? `${i.range.min}–${i.range.max} ${i.unit}` : "nicht festgelegt"}). Wie passt das zu einem gesunden Muster für mich und worauf sollte ich achten?`,
  BMI: (i) =>
    `Mein aktueller BMI liegt bei ${fmt(i.current)} ${i.unit}, der gesunde Bereich ist ${i.range ? `${i.range.min}–${i.range.max}` : "18,5–24,9"}. Wie ist mein Trend und worauf sollte ich achten?`,
  MOOD_SCORE: (i) =>
    `Mein letzter Stimmungs-Wert ist ${fmt(i.current)} / 5, mein Ziel liegt bei ${i.range ? `${i.range.min}+ / 5` : "3,5+ / 5"}. Wie ist meine Stimmung im Vergleich zu den letzten Wochen, und was könnte ich ausprobieren?`,
  MOOD_STABILITY: (i) => {
    const label = i.current != null ? moodStabilityLabel(i.current) : "stable";
    const verbal =
      label === "stable"
        ? "stabil"
        : label === "variable"
          ? "schwankend"
          : "sehr schwankend";
    return `Mein Stimmungsmuster ist aktuell ${verbal}. Was bedeutet das für mich und worauf sollte ich achten?`;
  },
  MEDICATION_COMPLIANCE: (i) =>
    `Meine Einnahmetreue liegt in den letzten 7 Tagen bei ${fmt(i.current, 0)}%${i.streakDays >= 3 ? ` (aktuelle Serie: ${i.streakDays} Tage im Ziel)` : ""}. Was könnte ich an meiner Routine ändern?`,
};

const GENERAL_EN: Template = (i) =>
  `I'd like to understand how I'm doing on ${i.type.toLowerCase().replace(/_/g, " ")} this week. Where am I doing well and where should I focus?`;
const GENERAL_DE: Template = (i) =>
  `Wie steht es um meine ${i.type.toLowerCase().replace(/_/g, " ")} diese Woche? Wo läuft es gut und worauf sollte ich achten?`;

export function buildTargetPrompt(input: TargetPromptInput): string {
  const table = input.locale === "de" ? TEMPLATES_DE : TEMPLATES_EN;
  const fallback = input.locale === "de" ? GENERAL_DE : GENERAL_EN;
  const template = table[input.type] ?? fallback;
  return template(input);
}
