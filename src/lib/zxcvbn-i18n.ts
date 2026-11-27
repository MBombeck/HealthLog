/**
 * Locale-aware translations for zxcvbn-typescript feedback messages.
 *
 * The library only emits English warnings/suggestions, so we map them
 * client-side to the user's UI language. Used by both the
 * password-strength component and the server-side checkPasswordStrength.
 */
import type { Locale } from "@/lib/i18n/config";

/**
 * How much of a password the server-side strength estimator reads, on every
 * path that scores one (`src/lib/auth/password.ts`).
 *
 * zxcvbn's matching grows with the square of the length times the number of
 * l33t substitutions it tries, and it runs on the request thread: 256
 * characters cost seconds of CPU per call. A password whose first 32
 * characters are hard to guess is strong whatever follows; a long one whose
 * first 32 are easy reads weaker than it is, which errs on the safe side.
 */
export const PASSWORD_STRENGTH_MAX_LENGTH = 32;

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

const warningsKo: Record<string, string> = {
  "Straight rows of keys are easy to guess":
    "키보드에서 일렬로 놓인 키는 쉽게 추측돼요",
  "Short keyboard patterns are easy to guess":
    "짧은 키보드 패턴은 쉽게 추측돼요",
  'Repeats like "aaa" are easy to guess': '"aaa" 같은 반복은 쉽게 추측돼요',
  'Repeats like "abcabc" are easy to guess':
    '"abcabc" 같은 반복은 쉽게 추측돼요',
  "Sequences like abc or 6543 are easy to guess":
    "abc나 6543 같은 연속은 쉽게 추측돼요",
  "Recent years are easy to guess": "최근 연도는 쉽게 추측돼요",
  "Dates are often easy to guess": "날짜는 대체로 쉽게 추측돼요",
  "This is a top-10 common password": "가장 흔한 비밀번호 10개 안에 들어요",
  "This is a top-100 common password": "가장 흔한 비밀번호 100개 안에 들어요",
  "This is a very common password": "아주 흔한 비밀번호예요",
  "This is similar to a commonly used password":
    "자주 쓰이는 비밀번호와 비슷해요",
  "A word by itself is easy to guess": "단어 하나만으로는 쉽게 추측돼요",
  "Names and surnames by themselves are easy to guess":
    "이름이나 성만으로는 쉽게 추측돼요",
  "Common names and surnames are easy to guess":
    "흔한 이름과 성은 쉽게 추측돼요",
};

const suggestionsKo: Record<string, string> = {
  "Use a few words, avoid common phrases":
    "단어를 여러 개 쓰고, 흔한 문구는 피해 주세요",
  "No need for symbols, digits, or uppercase letters":
    "기호, 숫자, 대문자를 꼭 넣지 않아도 돼요",
  "Add another word or two. Uncommon words are better.":
    "단어를 한두 개 더 붙여 주세요. 흔하지 않은 단어일수록 좋아요.",
  "Use a longer keyboard pattern with more turns":
    "방향이 자주 바뀌는 더 긴 키보드 패턴을 써 주세요",
  "Avoid repeated words and characters": "반복되는 단어와 문자는 피해 주세요",
  "Avoid sequences": "연속된 배열은 피해 주세요",
  "Avoid recent years": "최근 연도는 피해 주세요",
  "Avoid years that are associated with you":
    "본인과 관련된 연도는 피해 주세요",
  "Avoid dates and years that are associated with you":
    "본인과 관련된 날짜와 연도는 피해 주세요",
  "Capitalization doesn't help very much": "대문자로 바꿔도 큰 도움이 안 돼요",
  "All-uppercase is almost as easy to guess as all-lowercase":
    "전부 대문자로 써도 전부 소문자만큼 쉽게 추측돼요",
  "Reversed words aren't much harder to guess":
    "단어를 거꾸로 써도 추측 난이도는 별로 오르지 않아요",
  "Predictable substitutions like '@' instead of 'a' don't help very much":
    "'a' 대신 '@'처럼 뻔한 치환은 큰 도움이 안 돼요",
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
  const warnings =
    locale === "de" ? warningsDe : locale === "ko" ? warningsKo : warningsEn;
  const suggestions =
    locale === "de"
      ? suggestionsDe
      : locale === "ko"
        ? suggestionsKo
        : suggestionsEn;
  return {
    translate(text: string): string {
      return warnings[text] ?? suggestions[text] ?? text;
    },
  };
}
