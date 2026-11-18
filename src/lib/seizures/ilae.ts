/**
 * The seizure-type vocabulary of the diary (#1368): the ILAE 2025 types the
 * record stores, the class each belongs to, the ILAE 2017 name shown beside
 * it, the SNOMED CT concept the FHIR export codes it with, and the duration
 * after which emergency treatment is due (Trinka's t1).
 *
 * Client-safe: no server imports, so the type picker and the timer read the
 * same table the export and the report do.
 *
 * Sources:
 *  - Beniczky, Trinka et al., "Updated classification of epileptic seizures:
 *    Position paper of the ILAE", Epilepsia 2025, doi:10.1111/epi.18338.
 *    Four classes, 21 types; consciousness (awareness plus responsiveness)
 *    replaces awareness; "not sure" at a level records the parent class.
 *  - Fisher et al., "Operational classification of seizure types by the
 *    ILAE", Epilepsia 2017, pubmed 28276060. The 2017 names.
 *  - Trinka et al., "A definition and classification of status epilepticus",
 *    Epilepsia 2015, pubmed 26336950. t1: tonic-clonic 5 min, focal with
 *    impaired consciousness 10 min, absence 10 to 15 min (10 used here).
 *  - LOINC answer list LL6116-9 for 99311-3 (created with the AAN seizure
 *    frequency measure), checked against tx.fhir.org, LOINC 2.83.
 *  - SNOMED CT International, 2026-07 release. SNOMED still uses the 2017
 *    wording; a type without its own concept falls back to its parent.
 */

export const SEIZURE_ILAE_TYPES = [
  "FOCAL_PRESERVED",
  "FOCAL_IMPAIRED",
  "FOCAL_UNDETERMINED",
  "FOCAL_TO_BILATERAL_TC",
  "GENERALIZED_UNDETERMINED",
  "GENERALIZED_TC",
  "GEN_CLONIC",
  "GEN_TONIC",
  "GEN_MYOCLONIC",
  "GEN_MYOCLONIC_ATONIC",
  "GEN_ATONIC",
  "GEN_NEGATIVE_MYOCLONIC",
  "GEN_SPASMS",
  "ABSENCE_TYPICAL",
  "ABSENCE_ATYPICAL",
  "ABSENCE_MYOCLONIC",
  "EYELID_MYOCLONIA",
  "UNKNOWN_UNDETERMINED",
  "UNKNOWN_PRESERVED",
  "UNKNOWN_IMPAIRED",
  "UNKNOWN_BILATERAL_TC",
  "UNCLASSIFIED",
] as const;

export type SeizureIlaeType = (typeof SEIZURE_ILAE_TYPES)[number];

/** The four ILAE 2025 classes, in the order the picker offers them. */
export const SEIZURE_ILAE_CLASSES = [
  "FOCAL",
  "GENERALIZED",
  "UNKNOWN",
  "UNCLASSIFIED",
] as const;

export type SeizureIlaeClass = (typeof SEIZURE_ILAE_CLASSES)[number];

export interface SnomedConcept {
  code: string;
  display: string;
}

export interface IlaeTypeInfo {
  ilaeClass: SeizureIlaeClass;
  /** The parent-class entry ("not sure" at the second step). */
  isParent: boolean;
  /** Bilateral tonic-clonic: the three types the convulsive counts and the NICE rule use. */
  isConvulsive: boolean;
  /** Absent from the 2017 classification (new in 2025). */
  newIn2025: boolean;
  snomed: SnomedConcept;
  /** True when `snomed` is a parent concept standing in for a type SNOMED has no concept for. */
  snomedIsParent: boolean;
  /** Trinka 2015 t1 in seconds, or null where the paper defines none. */
  t1Sec: number | null;
}

const EPILEPTIC_SEIZURE: SnomedConcept = {
  code: "313307000",
  display: "Epileptic seizure",
};
const FOCAL: SnomedConcept = {
  code: "29753000",
  display: "Focal onset epileptic seizure",
};
const GENERALIZED: SnomedConcept = {
  code: "246545002",
  display: "Generalized onset epileptic seizure",
};

const LA = (code: string, display: string): SnomedConcept => ({
  code,
  display,
});
const LA_FOCAL_AWARE = LA("LA32841-1", "Focal Onset - Aware");
const LA_FOCAL_IMPAIRED = LA("LA32842-9", "Focal Onset - Impaired Awareness");
const LA_FOCAL_BTC = LA("LA32843-7", "Focal Onset - to Bilateral Tonic-clonic");
const LA_GEN_TC = LA("LA32844-5", "Generalized Onset - Motor Tonic-clonic");
const LA_GEN_OTHER_MOTOR = LA("LA32845-2", "Generalized Onset - Other Motor");
const LA_GEN_ABSENCE = LA(
  "LA32846-0",
  "Generalized Onset - Nonmotor (Absence)",
);
const LA_UNKNOWN_TC = LA(
  "LA32847-8",
  "Unknown Onset (if focal or generalized) - Motor Tonic-clonic",
);
const LA_UNCLASSIFIED = LA(
  "LA32850-2",
  "Unclassified (i.e., unsure if epileptic or not)",
);

const T1_TONIC_CLONIC = 5 * 60;
const T1_FOCAL_IMPAIRED = 10 * 60;
const T1_ABSENCE = 10 * 60;

function info(
  ilaeClass: SeizureIlaeClass,
  snomed: SnomedConcept,
  extra: Partial<Omit<IlaeTypeInfo, "ilaeClass" | "snomed">> = {},
): IlaeTypeInfo {
  return {
    ilaeClass,
    snomed,
    isParent: false,
    isConvulsive: false,
    newIn2025: false,
    snomedIsParent: false,
    t1Sec: null,
    ...extra,
  };
}

export const ILAE_TYPE_INFO: Readonly<Record<SeizureIlaeType, IlaeTypeInfo>> =
  Object.freeze({
    FOCAL_PRESERVED: info("FOCAL", {
      code: "117891000119100",
      display: "Focal onset aware epileptic seizure",
    }),
    FOCAL_IMPAIRED: info(
      "FOCAL",
      {
        code: "407675009",
        display: "Focal onset impaired awareness epileptic seizure",
      },
      { t1Sec: T1_FOCAL_IMPAIRED },
    ),
    FOCAL_UNDETERMINED: info("FOCAL", FOCAL, { isParent: true }),
    FOCAL_TO_BILATERAL_TC: info(
      "FOCAL",
      {
        code: "246544003",
        display: "Focal to bilateral tonic-clonic epileptic seizure",
      },
      { isConvulsive: true, t1Sec: T1_TONIC_CLONIC },
    ),
    GENERALIZED_UNDETERMINED: info("GENERALIZED", GENERALIZED, {
      isParent: true,
    }),
    GENERALIZED_TC: info(
      "GENERALIZED",
      {
        code: "1217209006",
        display: "Generalized onset tonic-clonic epileptic seizure",
      },
      { isConvulsive: true, t1Sec: T1_TONIC_CLONIC },
    ),
    GEN_CLONIC: info("GENERALIZED", {
      code: "1208970009",
      display: "Generalized onset clonic epileptic seizure",
    }),
    GEN_TONIC: info("GENERALIZED", {
      code: "1208969008",
      display: "Generalized onset tonic epileptic seizure",
    }),
    GEN_MYOCLONIC: info("GENERALIZED", {
      code: "1208972001",
      display: "Generalized onset myoclonic epileptic seizure",
    }),
    GEN_MYOCLONIC_ATONIC: info("GENERALIZED", {
      code: "1208971008",
      display: "Generalized onset myoclonic-atonic epileptic seizure",
    }),
    GEN_ATONIC: info("GENERALIZED", {
      code: "1208968000",
      display: "Generalized onset atonic epileptic seizure",
    }),
    // No SNOMED concept exists for generalized negative myoclonus; the
    // parent class carries it, with the 2025 name in the text.
    GEN_NEGATIVE_MYOCLONIC: info("GENERALIZED", GENERALIZED, {
      newIn2025: true,
      snomedIsParent: true,
    }),
    GEN_SPASMS: info("GENERALIZED", {
      code: "1208974000",
      display: "Generalized onset epileptic spasms",
    }),
    ABSENCE_TYPICAL: info(
      "GENERALIZED",
      { code: "1173024006", display: "Typical absence seizure" },
      { t1Sec: T1_ABSENCE },
    ),
    ABSENCE_ATYPICAL: info(
      "GENERALIZED",
      { code: "23374007", display: "Atypical absence seizure" },
      { t1Sec: T1_ABSENCE },
    ),
    ABSENCE_MYOCLONIC: info(
      "GENERALIZED",
      { code: "1208629005", display: "Myoclonic absence seizure" },
      { t1Sec: T1_ABSENCE },
    ),
    EYELID_MYOCLONIA: info(
      "GENERALIZED",
      { code: "230447004", display: "Absence seizure with eyelid myoclonia" },
      { t1Sec: T1_ABSENCE },
    ),
    UNKNOWN_UNDETERMINED: info("UNKNOWN", EPILEPTIC_SEIZURE, {
      isParent: true,
      snomedIsParent: true,
    }),
    UNKNOWN_PRESERVED: info("UNKNOWN", EPILEPTIC_SEIZURE, {
      snomedIsParent: true,
    }),
    UNKNOWN_IMPAIRED: info(
      "UNKNOWN",
      {
        code: "1365929003",
        display: "Impaired awareness epileptic seizure of unknown onset",
      },
      { t1Sec: T1_FOCAL_IMPAIRED },
    ),
    UNKNOWN_BILATERAL_TC: info(
      "UNKNOWN",
      {
        code: "1365926005",
        display: "Tonic-clonic epileptic seizure of unknown onset",
      },
      { isConvulsive: true, t1Sec: T1_TONIC_CLONIC },
    ),
    UNCLASSIFIED: info("UNCLASSIFIED", EPILEPTIC_SEIZURE, {
      isParent: true,
      snomedIsParent: true,
    }),
  });

/** The class a stored type belongs to. */
export function ilaeClassOf(type: SeizureIlaeType): SeizureIlaeClass {
  return ILAE_TYPE_INFO[type].ilaeClass;
}

/** Bilateral tonic-clonic (focal to bilateral, generalized, unknown onset). */
export function isConvulsiveType(type: SeizureIlaeType | null): boolean {
  return type !== null && ILAE_TYPE_INFO[type].isConvulsive;
}

/** The types of one class, parent entry last ("not sure"). */
export function ilaeTypesOfClass(
  ilaeClass: SeizureIlaeClass,
): SeizureIlaeType[] {
  const of = SEIZURE_ILAE_TYPES.filter(
    (t) => ILAE_TYPE_INFO[t].ilaeClass === ilaeClass,
  );
  return [
    ...of.filter((t) => !ILAE_TYPE_INFO[t].isParent),
    ...of.filter((t) => ILAE_TYPE_INFO[t].isParent),
  ];
}

/** i18n key of the ILAE 2025 name (`seizures.ilae.<TYPE>.current`). */
export function ilaeLabelKey(type: SeizureIlaeType): string {
  return `seizures.ilae.${type}.current`;
}

/**
 * i18n key of the ILAE 2017 name, or null for a type the 2017 classification
 * did not have (generalized negative myoclonus).
 */
export function ilae2017LabelKey(type: SeizureIlaeType): string | null {
  return ILAE_TYPE_INFO[type].newIn2025
    ? null
    : `seizures.ilae.${type}.ilae2017`;
}

/**
 * The LOINC LL6116-9 answer (99311-3, 2017 categories) each type falls under.
 * A type is absent where the 2017 answer depends on a motor / non-motor split
 * the 2025 type no longer records (the parent classes, unknown onset with
 * preserved or impaired consciousness).
 */
const LOINC_SEIZURE_TYPE_ANSWER: Partial<
  Record<SeizureIlaeType, SnomedConcept>
> = {
  FOCAL_PRESERVED: LA_FOCAL_AWARE,
  FOCAL_IMPAIRED: LA_FOCAL_IMPAIRED,
  FOCAL_TO_BILATERAL_TC: LA_FOCAL_BTC,
  GENERALIZED_TC: LA_GEN_TC,
  GEN_CLONIC: LA_GEN_OTHER_MOTOR,
  GEN_TONIC: LA_GEN_OTHER_MOTOR,
  GEN_MYOCLONIC: LA_GEN_OTHER_MOTOR,
  GEN_MYOCLONIC_ATONIC: LA_GEN_OTHER_MOTOR,
  GEN_ATONIC: LA_GEN_OTHER_MOTOR,
  GEN_NEGATIVE_MYOCLONIC: LA_GEN_OTHER_MOTOR,
  GEN_SPASMS: LA_GEN_OTHER_MOTOR,
  ABSENCE_TYPICAL: LA_GEN_ABSENCE,
  ABSENCE_ATYPICAL: LA_GEN_ABSENCE,
  ABSENCE_MYOCLONIC: LA_GEN_ABSENCE,
  EYELID_MYOCLONIA: LA_GEN_ABSENCE,
  UNKNOWN_BILATERAL_TC: LA_UNKNOWN_TC,
  UNCLASSIFIED: LA_UNCLASSIFIED,
};

/** The 99311-3 answer for a type, or null (see above). */
export function loincSeizureTypeAnswer(
  type: SeizureIlaeType,
): SnomedConcept | null {
  return LOINC_SEIZURE_TYPE_ANSWER[type] ?? null;
}
