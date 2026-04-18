/**
 * Locale-aware translations for zxcvbn-typescript feedback messages.
 *
 * The library only emits English warnings/suggestions, so we map them
 * client-side to the user's UI language. Used by both the
 * password-strength component and the server-side checkPasswordStrength.
 */
import type { Locale } from "@/lib/i18n/config";

const warningsDe: Record<string, string> = {
  "Straight rows of keys are easy to guess":
    "Gerade Tastenreihen sind leicht zu erraten",
  "Short keyboard patterns are easy to guess":
    "Kurze Tastaturmuster sind leicht zu erraten",
  'Repeats like "aaa" are easy to guess':
    'Wiederholungen wie „aaa" sind leicht zu erraten',
  'Repeats like "abcabc" are easy to guess':
    'Wiederholungen wie „abcabc" sind leicht zu erraten',
  "Sequences like abc or 6543 are easy to guess":
    "Sequenzen wie abc oder 6543 sind leicht zu erraten",
  "Recent years are easy to guess":
    "Aktuelle Jahreszahlen sind leicht zu erraten",
  "Dates are often easy to guess": "Datumsangaben sind oft leicht zu erraten",
  "This is a top-10 common password":
    "Dies gehört zu den 10 häufigsten Passwörtern",
  "This is a top-100 common password":
    "Dies gehört zu den 100 häufigsten Passwörtern",
  "This is a very common password": "Dies ist ein sehr häufiges Passwort",
  "This is similar to a commonly used password":
    "Dies ähnelt einem häufig verwendeten Passwort",
  "A word by itself is easy to guess":
    "Ein einzelnes Wort ist leicht zu erraten",
  "Names and surnames by themselves are easy to guess":
    "Einzelne Namen sind leicht zu erraten",
  "Common names and surnames are easy to guess":
    "Häufige Namen sind leicht zu erraten",
};

const suggestionsDe: Record<string, string> = {
  "Use a few words, avoid common phrases":
    "Verwende mehrere Wörter, vermeide gängige Phrasen",
  "No need for symbols, digits, or uppercase letters":
    "Symbole, Ziffern oder Großbuchstaben sind nicht nötig",
  "Add another word or two. Uncommon words are better.":
    "Füge ein oder zwei weitere Wörter hinzu. Ungewöhnliche Wörter sind besser.",
  "Use a longer keyboard pattern with more turns":
    "Verwende ein längeres Tastaturmuster mit mehr Richtungswechseln",
  "Avoid repeated words and characters":
    "Vermeide wiederholte Wörter und Zeichen",
  "Avoid sequences": "Vermeide Sequenzen",
  "Avoid recent years": "Vermeide aktuelle Jahreszahlen",
  "Avoid years that are associated with you":
    "Vermeide Jahreszahlen, die mit dir in Verbindung stehen",
  "Avoid dates and years that are associated with you":
    "Vermeide Datumsangaben und Jahreszahlen, die mit dir in Verbindung stehen",
  "Capitalization doesn't help very much":
    "Großschreibung hilft nicht wesentlich",
  "All-uppercase is almost as easy to guess as all-lowercase":
    "Nur Großbuchstaben sind fast so leicht zu erraten wie nur Kleinbuchstaben",
  "Reversed words aren't much harder to guess":
    "Umgekehrte Wörter sind kaum schwerer zu erraten",
  "Predictable substitutions like '@' instead of 'a' don't help very much":
    'Vorhersehbare Ersetzungen wie „@" statt „a" helfen nicht wesentlich',
};

// English: identity map for all known strings (the library already returns
// English, but we wrap them so unknown values still pass through unchanged).
const warningsEn: Record<string, string> = Object.fromEntries(
  Object.keys(warningsDe).map((key) => [key, key]),
);
const suggestionsEn: Record<string, string> = Object.fromEntries(
  Object.keys(suggestionsDe).map((key) => [key, key]),
);

export interface ZxcvbnTranslations {
  translate(text: string): string;
}

export function getZxcvbnTranslations(locale: Locale): ZxcvbnTranslations {
  const warnings = locale === "de" ? warningsDe : warningsEn;
  const suggestions = locale === "de" ? suggestionsDe : suggestionsEn;
  return {
    translate(text: string): string {
      return warnings[text] ?? suggestions[text] ?? text;
    },
  };
}
