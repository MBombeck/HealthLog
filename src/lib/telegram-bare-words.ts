/**
 * Bare-word aliases the Telegram bot answers, per app language.
 *
 * The bot's real commands are slash commands (`/help`, `/start`, `/add`) plus
 * the `taken <name>` text command, and `telegram.helpBody` documents exactly
 * those in every bundle; none of that depends on the reader's language. What
 * did depend on it were the two undocumented courtesies below, which knew
 * English and German: "aide", "ayuda", "aiuto" and "pomoc" reached the intake
 * keyword instead, failed it, and the handler returned without replying at all.
 * Silence is the worst answer to someone asking for help.
 *
 * These are ordinary words, not app labels, so there is nothing in the bundles
 * to derive them from. One entry per locale, so a new language cannot be
 * forgotten here. The bot matches the union, whatever the reader's language,
 * on the FOLDED text, so "cześć" and "czesc" are one entry and a stray capital
 * or accent cannot miss.
 */
import type { Locale } from "@/lib/i18n/config";

interface BareWords {
  /** "Help". */
  readonly help: readonly string[];
  /** Greetings the bot answers with a wave. */
  readonly greeting: readonly string[];
}

const BARE_WORDS: Readonly<Record<Locale, BareWords>> = {
  en: { help: ["help"], greeting: ["hi", "hello", "hey"] },
  de: { help: ["hilfe"], greeting: ["hallo", "moin"] },
  fr: { help: ["aide"], greeting: ["bonjour", "salut"] },
  es: { help: ["ayuda"], greeting: ["hola", "buenas"] },
  it: { help: ["aiuto"], greeting: ["ciao", "salve"] },
  pl: { help: ["pomoc"], greeting: ["czesc", "witaj", "dzien dobry"] },
  ko: { help: ["도움말", "도움"], greeting: ["안녕", "안녕하세요"] },
  nl: { help: ["hulp"], greeting: ["hoi", "hallo", "goedemorgen"] },
  "pt-BR": { help: ["ajuda"], greeting: ["oi", "ola", "bom dia"] },
  ru: {
    help: ["помощь", "помоги", "помогите"],
    greeting: ["привет", "здравствуй", "здравствуйте", "добрый день"],
  },
};

/** "Help", in every language the app ships. */
export const HELP_WORDS: readonly string[] = Object.values(BARE_WORDS).flatMap(
  (words) => words.help,
);

/** Greetings, in every language the app ships. */
export const GREETING_WORDS: readonly string[] = Object.values(
  BARE_WORDS,
).flatMap((words) => words.greeting);
