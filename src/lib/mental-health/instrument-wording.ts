/**
 * How a surface reads questionnaire text out of one language's wording: the
 * answer label of an item, the stem above it. Data-free, so a client surface
 * imports it without pulling every language in; the text itself comes from
 * `./wording/load.ts` on the client and `./wording/resolve.ts` on the server.
 *
 * Every instrument has wording in every app language (`./wording/`). Where a
 * validated translation is published, that translation is reproduced word for
 * word; where none is, a translation written for HealthLog stands in, and the
 * surfaces show a note beside it with a one-tap switch to the English
 * original. The text never lives in `messages/*.json`, so a translator editing
 * the bundles cannot reword an item by accident (`i18n-locale-integrity.test.ts`
 * holds every bundle clear of it).
 */
import { localeFromLanguageTag, type Locale } from "@/lib/i18n/config";

import { INSTRUMENTS, type InstrumentId } from "./instruments";
import { SINGLE_ANCHOR_GROUP, type InstrumentWording } from "./wording/types";

/**
 * The app language whose questionnaire text a reader of `locale` is shown;
 * a language the app does not ship reads the English original.
 */
export function wordingLocale(locale: string): Locale {
  return localeFromLanguageTag(locale) ?? "en";
}

/** Instruments whose form carries the unscored functional follow-up. */
export function hasFunctionalItem(id: InstrumentId): boolean {
  return id === "PHQ9";
}

/** The anchor group an item's answers come from. */
export function anchorGroup(id: InstrumentId, itemIndex: number): string {
  return INSTRUMENTS[id].optionGroups?.[itemIndex] ?? SINGLE_ANCHOR_GROUP;
}

/** The label of answer `value` to item `itemIndex`. */
export function anchorText(
  id: InstrumentId,
  wording: InstrumentWording,
  itemIndex: number,
  value: number,
): string {
  return wording.anchors[anchorGroup(id, itemIndex)][value];
}

/** The stem the source form prints above item `itemIndex`, or null. */
export function stemText(
  id: InstrumentId,
  wording: InstrumentWording,
  itemIndex: number,
): string | null {
  const stemId = INSTRUMENTS[id].stemIds[itemIndex];
  return stemId ? (wording.stems[stemId] ?? null) : null;
}
