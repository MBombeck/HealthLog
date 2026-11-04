/** Population-norm framing, ru. */
/**
 * Cyrillic-safe word edges. JavaScript defines `\b` and `\w` over ASCII only,
 * so `\bнормальн` never matches before a Cyrillic letter and `\w*` stops at
 * the first Russian one. These lookarounds treat [а-яё] as word letters.
 */
const START = "(?<![а-яёa-z])";

export const patterns: readonly RegExp[] = [
  new RegExp(
    `${START}нормальн[а-яё]*\\s+(?:диапазон|предел|значени|границ)[а-яё]*`,
    "i",
  ),
  new RegExp(
    `${START}(?:референсн|референс)[а-яё]*\\s+(?:интервал|диапазон|значени|границ)[а-яё]*`,
    "i",
  ),
  new RegExp(
    `${START}(?:большинств|большая\\s+часть|многие|все)[а-яё]*\\s+(?:люд|взросл)[а-яё]*`,
    "i",
  ),
  new RegExp(
    `${START}(?:взросл|люд)[а-яё]*[^.?!]{0,15}(?:обычно|как\\s+правило|в\\s+среднем)`,
    "i",
  ),
  new RegExp(
    `${START}(?:врач|специалист|эксперт|рекомендаци)[а-яё]*[^.?!]{0,20}(?:говор|рекоменду|счита)[а-яё]*`,
    "i",
  ),
  new RegExp(`${START}(?:общ|широк)[а-яё]*\\s+(?:популяци|выборк)[а-яё]*`, "i"),
  new RegExp(
    `${START}(?:средн|типичн|здоров)[а-яё]*\\s+(?:показател|уровень|значени|норм)[а-яё]*`,
    "i",
  ),
  new RegExp(`${START}в\\s+среднем\\s+по\\s+популяции`, "i"),
];
