/**
 * The client's way to the questionnaire text: one chunk per language, loaded
 * when a questionnaire surface needs it. A reader downloads their own
 * language, and English only when they switch to the original; the server
 * and the tests read every language at once through `./index.ts`.
 */
import type { Locale } from "@/lib/i18n/config";

import type { LocaleWording } from "./types";

const LOADERS: Record<Locale, () => Promise<{ default: LocaleWording }>> = {
  en: () => import("./locales/en"),
  de: () => import("./locales/de"),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  it: () => import("./locales/it"),
  pl: () => import("./locales/pl"),
  ko: () => import("./locales/ko"),
  nl: () => import("./locales/nl"),
  "pt-BR": () => import("./locales/pt-br"),
  ru: () => import("./locales/ru"),
  // Questionnaire item wording stays English until a native speaker has
  // reviewed it clinically; the in-app `mentalHealth.wording.*` strings tell
  // the reader that the translation is not yet validated. Pointing this at
  // `en` is what makes that disclosure true rather than a claim.
  "zh-CN": () => import("./locales/en"),
};

export async function loadLocaleWording(
  locale: Locale,
): Promise<LocaleWording> {
  return (await LOADERS[locale]()).default;
}
