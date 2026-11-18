import type { Locale } from "@/lib/i18n/config";

/**
 * A sentence without the first name it opens with ("Alex, your pulse …" →
 * "Your pulse …"). The briefing may use the name once a day, and the Today
 * screen greets by it right above the lead, so the lead would say it twice
 * (#173). Only the exact name followed by a comma or an exclamation mark at
 * the very start; a name later in the sentence, or a longer word that merely
 * starts like it, stays. The briefing itself keeps the name.
 */
export function withoutLeadingName(
  sentence: string,
  firstName: string | null | undefined,
  locale: Locale,
): string {
  const name = firstName?.trim();
  if (!name) return sentence;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sentence.match(
    new RegExp(`^\\s*${escaped}(?![\\p{L}\\p{N}])\\s*[,!]\\s*`, "iu"),
  );
  if (!match) return sentence;
  const rest = sentence.slice(match[0].length);
  const [first = ""] = rest;
  if (!first) return sentence;
  return first.toLocaleUpperCase(locale) + rest.slice(first.length);
}
