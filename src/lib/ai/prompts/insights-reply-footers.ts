/**
 * The reply-language footer the insights prompt appends for every locale
 * outside German and English: the whole footer for the locales without a
 * safety-contract matrix (ko, nl, pt-BR), and the fallback for the matrix
 * locales when their native body cannot be built. Prompt text only.
 */
import type { Locale } from "@/lib/i18n/config";

export const INSIGHTS_LOCALE_REPLY_FOOTER_FALLBACK: Record<
  Exclude<Locale, "de" | "en">,
  string
> = {
  fr: "\n\nREPLY LANGUAGE: render all user-facing strings in French. Use natural French health vocabulary. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  es: "\n\nREPLY LANGUAGE: render all user-facing strings in Spanish (peninsular preferred). Use natural Spanish health vocabulary. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  it: "\n\nREPLY LANGUAGE: render all user-facing strings in Italian. Use natural Italian health vocabulary. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  pl: "\n\nREPLY LANGUAGE: render all user-facing strings in Polish. Use natural Polish health vocabulary with formal Pan/Pani register for medical-adjacent topics. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  nl: "\n\nREPLY LANGUAGE: render all user-facing strings in Dutch, in the informal je/jij register throughout (never formal u). Use natural Dutch health vocabulary. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  ko: "\n\nREPLY LANGUAGE: render all user-facing strings in Korean, in the 해요체 register throughout (never 합쇼체 or plain 한다체). Use natural Korean health vocabulary. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  ru: "\n\nREPLY LANGUAGE — THIS OVERRIDES THE LANGUAGE RULE ABOVE. The \"Respond in English\" instruction earlier in this prompt does NOT apply to this request: write EVERY user-facing string in Russian (русский язык), with natural Russian medical vocabulary and the standard Russian lab terminology, addressing the user with «вы». Never answer in English. The severity / sourceWindow / sourceMetric / topic enum values still stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
  "pt-BR":
    "\n\nREPLY LANGUAGE: render all user-facing strings in Brazilian Portuguese (pt-BR, never European Portuguese), addressing the user as você throughout. Use natural Brazilian health vocabulary. The severity / sourceWindow / sourceMetric / topic enum values stay in lowercase English exactly as listed in OUTPUT FORMAT — those are contract keys, NOT translations.",
};
