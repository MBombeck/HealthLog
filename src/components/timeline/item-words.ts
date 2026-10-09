/**
 * The words of one timeline item, in the reader's language (v1.42, #613).
 *
 * The server sends what the record holds: a life event's category, a visit's
 * kind and a document's kind as their codes, a lab day's analyte count as a
 * number, and a sentinel label for a trip or a cycle that has no name of its
 * own. Every surface that shows an item (the lanes, their hover titles, the
 * screen-reader table, the selection bar, the phone chronicle) reads it
 * through here, so a code is worded once and never reaches the screen raw.
 *
 * A code the bundle cannot word is left out rather than shown: an unknown
 * category reads as no category, not as `SOMETHING_NEW`.
 */
import { useMemo } from "react";

import { encounterKindText } from "@/components/encounters/encounter-labels";
import type { TimelineItem } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

import {
  DOCUMENT_KIND_KEY,
  LIFE_EVENT_CATEGORY_KEY,
  keyOf,
} from "./label-keys";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;
type TranslateCount = (
  baseKey: string,
  count: number,
  params?: Record<string, string | number>,
) => string;

export interface ItemWords {
  /** What the item is called. */
  label: string;
  /** Its second line (a category, a dose, a count), or null when none. */
  sub: string | null;
}

export type ItemWordsFn = (item: TimelineItem) => ItemWords;

/** A code worded through `map`, or null for none or a code it lacks. */
function worded<K extends string>(
  t: Translate,
  map: Readonly<Record<K, string>>,
  code: string | null,
): string | null {
  const key = code === null ? undefined : keyOf(map, code);
  return key ? t(key) : null;
}

const ENCOUNTER_KIND_CODES: ReadonlySet<string> = new Set([
  "ROUTINE",
  "ACUTE",
  "SPECIALIST",
  "PREVENTIVE",
  "EMERGENCY",
  "HOSPITAL",
  "THERAPY",
  "OTHER",
  "PROCEDURE",
]);

/** A visit's kind code, worded; null for a code the bundle does not know. */
export function visitKindWords(t: Translate, code: string): string | null {
  return ENCOUNTER_KIND_CODES.has(code)
    ? encounterKindText(t, code as Parameters<typeof encounterKindText>[1])
    : null;
}

export function makeItemWords(
  t: Translate,
  tCount: TranslateCount,
): ItemWordsFn {
  return (item) => {
    switch (item.kind) {
      case "lifeEvent":
        return {
          label: item.label,
          sub: worded(t, LIFE_EVENT_CATEGORY_KEY, item.sub),
        };
      case "travel":
        return { label: t("day.travel"), sub: null };
      case "cycle":
        return { label: t("nav.cycle"), sub: null };
      case "pause":
        return {
          label: t("day.event.paused", { label: item.label }),
          sub: null,
        };
      case "visit":
      case "procedure": {
        const kind = item.sub ? visitKindWords(t, item.sub) : null;
        // A visit without a reason or a practitioner is named by its kind.
        return item.label
          ? { label: item.label, sub: kind }
          : { label: kind ?? "", sub: null };
      }
      case "labDay": {
        const count = Number(item.sub);
        return {
          label: item.label,
          sub:
            Number.isInteger(count) && count > 0
              ? tCount("timeline.item.labValues", count)
              : null,
        };
      }
      case "document":
        return {
          label: item.label,
          sub: worded(t, DOCUMENT_KIND_KEY, item.sub),
        };
      default:
        // A dose, a dose change, a name: the record's own text.
        return { label: item.label, sub: item.sub };
    }
  };
}

/**
 * The line an item reads as: its label, its second line (a dose change's
 * dose is drawn as its own mark, so it is left out here) and the
 * unknown-start note.
 */
export function itemLine(
  item: TimelineItem,
  words: ItemWordsFn,
  startMissing: string,
): string {
  const { label, sub } = words(item);
  const parts = [label];
  if (sub && item.kind !== "doseChange") parts.push(sub);
  if (!item.startKnown) parts.push(startMissing);
  return parts.filter(Boolean).join(" · ");
}

/** {@link makeItemWords} with the bundle in hand. */
export function useItemWords(): ItemWordsFn {
  const { t, tCount } = useTranslations();
  return useMemo(() => makeItemWords(t, tCount), [t, tCount]);
}
