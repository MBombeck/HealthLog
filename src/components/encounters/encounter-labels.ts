"use client";

/**
 * Browser-side labels for a visit's kind and status.
 *
 * The server has its own `encounterKindLabel` and the two do not share code on
 * purpose: the server's answer becomes a push body in the RECORD OWNER's
 * language, and this one renders in the language of whoever is looking. Sharing
 * a resolver would force one of the two to read the wrong locale.
 *
 * Both switches spell out literal `t()` calls rather than interpolating a key.
 * An interpolated key is invisible to `i18n-call-site-coverage`, so a renamed
 * or missing label would ship as raw dot notation instead of failing CI.
 */
import type {
  EncounterKind,
  EncounterStatus,
  Laterality,
} from "@/generated/prisma/client";

type Translate = (key: string, values?: Record<string, string>) => string;

/** Every kind, in the order the picker offers them. */
export const ENCOUNTER_KINDS: EncounterKind[] = [
  "ROUTINE",
  "ACUTE",
  "SPECIALIST",
  "PREVENTIVE",
  "EMERGENCY",
  "HOSPITAL",
  "THERAPY",
  "PROCEDURE",
  "OTHER",
];

/** Every side a body site can carry; "not stated" is the absence, not a value. */
export const LATERALITIES: Laterality[] = ["LEFT", "RIGHT", "BOTH"];

/** Every status a visit can be edited into. */
export const ENCOUNTER_STATUSES: EncounterStatus[] = [
  "PLANNED",
  "DONE",
  "CANCELLED",
  "NO_SHOW",
];

export function encounterKindText(t: Translate, kind: EncounterKind): string {
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

export function encounterStatusText(
  t: Translate,
  status: EncounterStatus,
): string {
  switch (status) {
    case "PLANNED":
      return t("encounters.status.planned");
    case "DONE":
      return t("encounters.status.done");
    case "CANCELLED":
      return t("encounters.status.cancelled");
    default:
      return t("encounters.status.noShow");
  }
}

export function lateralityText(t: Translate, laterality: Laterality): string {
  switch (laterality) {
    case "LEFT":
      return t("encounters.laterality.left");
    case "RIGHT":
      return t("encounters.laterality.right");
    default:
      return t("encounters.laterality.both");
  }
}

/**
 * The body site as one line: the person's own words, with the side after it
 * when one is stated. Null when the visit names no site, so a caller renders
 * nothing rather than a lone side.
 */
export function bodySiteText(
  t: Translate,
  bodySite: string | null,
  laterality: Laterality | null,
): string | null {
  const site = bodySite?.trim();
  if (!site) return null;
  if (!laterality) return site;
  return t("encounters.bodySiteWithSide", {
    site,
    side: lateralityText(t, laterality),
  });
}
