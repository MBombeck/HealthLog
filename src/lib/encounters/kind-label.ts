/**
 * The human name of a visit kind, in the record owner's language.
 *
 * Spelled out with literal `t()` calls rather than an interpolated key, for the
 * same reason the restore-skip catalogue labels are: an interpolated key is
 * invisible to `i18n-call-site-coverage`, so a renamed or missing kind would
 * ship as raw dot notation instead of failing CI.
 *
 * This is not decoration. The value becomes a `MeasurementReminder.label`, and
 * that label IS the push body — so the fallback for a visit with no practice
 * attached is read off a lock screen. A raw enum constant there is the schema
 * leaking into the product.
 */
import type { EncounterKind, Laterality } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

export function encounterKindLabel(
  kind: EncounterKind,
  locale: string | null | undefined,
): string {
  const { t } = getServerTranslator(resolveLocale(locale));
  switch (kind) {
    case "ROUTINE":
      return t("encounters.kind.routine");
    case "ACUTE":
      return t("encounters.kind.acute");
    case "SPECIALIST":
      return t("encounters.kind.specialist");
    case "PREVENTIVE":
      return t("encounters.kind.preventive");
    case "EMERGENCY":
      return t("encounters.kind.emergency");
    case "HOSPITAL":
      return t("encounters.kind.hospital");
    case "THERAPY":
      return t("encounters.kind.therapy");
    case "PROCEDURE":
      return t("encounters.kind.procedure");
    default:
      return t("encounters.kind.other");
  }
}

/**
 * The same mapping as a KEY, for callers that already hold a translator and
 * cannot reach for a second one — the doctor-report PDF, the daily digest and
 * the clinician share view.
 *
 * Those three built the key by interpolation (`encounters.kind.${kind}`), and
 * the enum is `ROUTINE` while the bundle leaf is `routine`, so all three
 * printed raw dot notation into a clinical document. The interpolated form was
 * invisible to `i18n-call-site-coverage`, which is the reason it survived: the
 * key it asked for never existed and nothing said so.
 */
export function encounterKindLabelKey(kind: EncounterKind): string {
  switch (kind) {
    case "ROUTINE":
      return "encounters.kind.routine";
    case "ACUTE":
      return "encounters.kind.acute";
    case "SPECIALIST":
      return "encounters.kind.specialist";
    case "PREVENTIVE":
      return "encounters.kind.preventive";
    case "EMERGENCY":
      return "encounters.kind.emergency";
    case "HOSPITAL":
      return "encounters.kind.hospital";
    case "THERAPY":
      return "encounters.kind.therapy";
    case "PROCEDURE":
      return "encounters.kind.procedure";
    default:
      return "encounters.kind.other";
  }
}

/**
 * The side of a body site as a key, for the same translator-holding callers:
 * the doctor-report PDF and the clinician share view name it in the reading
 * clinician's language.
 */
export function lateralityLabelKey(laterality: Laterality): string {
  switch (laterality) {
    case "LEFT":
      return "encounters.laterality.left";
    case "RIGHT":
      return "encounters.laterality.right";
    default:
      return "encounters.laterality.both";
  }
}
