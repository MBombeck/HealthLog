/**
 * The words a record search matches beyond what a row stores: enum words,
 * kind aliases, sides and the labels in the English and the owner's bundle.
 * Kept apart from `record-search.ts` so that file stays under the size ratchet.
 */
import type {
  EncounterKind,
  IllnessLifecycle,
  IllnessType,
  InboundDocumentKind,
  Laterality,
} from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { resolveVaccineEntry } from "@/lib/vaccinations/resolve-vaccine-entry";

/** "DISCHARGE_LETTER" → "discharge letter". */
export function enumWords(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

/**
 * Words a person uses for a visit kind that neither the enum nor the bundle
 * label carries. "Operation" is the common one: nobody asks for their "left
 * knee procedure or surgery".
 */
export const ENCOUNTER_KIND_ALIASES: Partial<Record<EncounterKind, string>> = {
  PROCEDURE: "surgery surgical operation operiert eingriff",
  HOSPITAL: "inpatient krankenhaus klinik",
  EMERGENCY: "notaufnahme notfall",
};

export const LATERALITY_WORDS: Record<Laterality, string> = {
  LEFT: "left",
  RIGHT: "right",
  BOTH: "both sides",
};

export function sideTerms(
  laterality: Laterality | null,
  owner: Locale,
): string | null {
  if (!laterality) return null;
  const key =
    laterality === "LEFT"
      ? "encounters.laterality.left"
      : laterality === "RIGHT"
        ? "encounters.laterality.right"
        : "encounters.laterality.both";
  const en = getServerTranslator("en").t(key);
  const own = getServerTranslator(owner).t(key);
  return `${LATERALITY_WORDS[laterality]} ${en} ${own}`;
}

export function documentKindLabel(
  kind: InboundDocumentKind,
  locale: Locale,
): string {
  return getServerTranslator(locale).t(`documents.kind.${kind}`);
}

export function illnessTypeLabel(type: IllnessType, locale: Locale): string {
  return getServerTranslator(locale).t(`illness.type.${type}`);
}

export function lifecycleLabel(lifecycle: IllnessLifecycle): string {
  return getServerTranslator("en").t(`illness.lifecycle.${lifecycle}`);
}

/** The catalogue name of a dose's slug, or null for a slug it does not know. */
export function vaccineCatalogName(
  slug: string | null,
  locale: Locale,
): string | null {
  const entry = resolveVaccineEntry({ antigenSlug: slug });
  if (!entry?.slug) return null;
  return getServerTranslator(locale).t(`vaccinations.catalog.${entry.slug}`);
}
