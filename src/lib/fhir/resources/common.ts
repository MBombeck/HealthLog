/**
 * Shared anchors for the per-resource FHIR R4 emitters: the patient id every
 * subject reference points at, the terminology-system URIs, the option /
 * identity types threaded from the export route, and the small concept
 * helpers each emitter reuses.
 *
 * Kept in its own module so `patient` / `coverage` / `observation` / `labs` /
 * `glucose` / `medications` / `conditions` / `cycle` can depend on the anchors
 * without depending on each other.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  LOINC_SYSTEM,
  HEALTHKIT_CODESYSTEM,
  type LoincMapping,
} from "@/lib/fhir/loinc-map";
import type { FhirCodeableConcept, FhirReference } from "@/lib/fhir/types";
import { ownValue } from "@/lib/own-key";

/** Patient identity not carried in `DoctorReportData` (KVNR is encrypted). */
export interface FhirPatientIdentity {
  /** German KVNR (decrypted by the route). */
  insuranceNumber: string | null;
}

/** KVNR identifier namespace per the gematik SID. */
export const KVNR_SYSTEM = "http://fhir.de/sid/gkv/kvid-10";

/** German insurer institution-number (IKNR) identifier namespace. */
export const IKNR_SYSTEM = "http://fhir.de/sid/arge-ik/iknr";

/**
 * v1.9.0 — drug-coding system URIs. ATC is the portable WHO default
 * (the iOS export emits the identical URI); RxNorm is the secondary US
 * coding. Both are additive `coding[]` entries on the same concept; the
 * free-text `.text` (the user's medication name) stays the anchor.
 */
export const ATC_SYSTEM = "http://www.whocc.no/atc";
/**
 * German national ATC URI maintained by the BfArM. Same ATC classification
 * as WHO under a national CodeSystem; emitted as an ADDITIONAL coding (never
 * a replacement) when a German-region export is requested, so the WHO entry
 * stays first and byte-identical for every consumer.
 */
export const ATC_BFARM_SYSTEM = "http://fhir.de/CodeSystem/bfarm/atc";
export const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
/** SNOMED CT URI. Concept ids are referenced (not redistributed) in FHIR instances. */
export const SNOMED_SYSTEM = "http://snomed.info/sct";

/**
 * The app locales for which a health-record export defaults `germanAtc` on
 * (the additive BfArM ATC coding). The export route derives the flag from
 * the user's locale against this set; the capabilities endpoint surfaces it
 * verbatim so a client can predict the coding without a round-trip. Keeping
 * it here — beside the BfArM URI it gates — makes the two move together.
 */
export const GERMAN_ATC_DEFAULT_LOCALES = ["de"] as const;

/** Options threaded from the export route into the emitters. Additive, all defaulted. */
export interface FhirBuildOptions {
  /**
   * When true, additionally emit the German BfArM ATC URI alongside the WHO
   * entry on each medication concept. The WHO coding stays first and
   * byte-identical; this only appends a second URI for the same leaf code.
   * Defaults off; the route turns it on for a German-region export.
   */
  germanAtc?: boolean;
}

/** Local-`#`-ref / patient anchor id shared by every subject reference. */
export const PATIENT_RESOURCE_ID = "patient-1";

export const patientRef: FhirReference = {
  reference: `Patient/${PATIENT_RESOURCE_ID}`,
};

export function categoryConcept(category: string): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: category,
      },
    ],
  };
}

/**
 * R4 vital-signs profiles require a "magic" LOINC code on `Observation.code`
 * and allow a more specific code beside it
 * (https://hl7.org/fhir/R4/observation-vitalsigns.html). A resting heart rate
 * is a heart rate (8867-4) and a pulse-oximetry SpO2 is an oxygen saturation
 * (2708-6); without the magic code the validator rejects both Observations.
 */
const VITAL_SIGNS_MAGIC_CODE: Record<
  string,
  { code: string; display: string }
> = {
  "40443-4": { code: "8867-4", display: "Heart rate" },
  "59408-5": {
    code: "2708-6",
    display: "Oxygen saturation in Arterial blood",
  },
};

export function codeableFromMapping(m: LoincMapping): FhirCodeableConcept {
  if (m.loinc) {
    // HealthKit placeholder codes have no published LOINC term; they must not
    // sit under the LOINC namespace (a non-LOINC code there is a conformance
    // violation). Route them onto the shared custom CodeSystem instead —
    // byte-aligned with the iOS exporter.
    const system = m.loinc.startsWith("HKQuantityTypeIdentifier")
      ? HEALTHKIT_CODESYSTEM
      : LOINC_SYSTEM;
    const magic =
      system === LOINC_SYSTEM
        ? ownValue(VITAL_SIGNS_MAGIC_CODE, m.loinc)
        : undefined;
    return {
      coding: [
        { system, code: m.loinc, display: m.display },
        ...(magic
          ? [{ system: LOINC_SYSTEM, code: magic.code, display: magic.display }]
          : []),
      ],
      text: m.display,
    };
  }
  // No stable LOINC — local text-only concept (documented fallback).
  return { text: m.display };
}

/**
 * Latest `{ value, measuredAt }` for a type, or null when no rows.
 *
 * A dense type (pulse, glucose) can be served from day buckets, and then the
 * series' last point is the last day's MEAN stamped at that day's start: a
 * value nobody measured, at a time nobody measured it. Its stats carry the
 * newest actual reading, so that wins whenever it is there.
 */
export function latestReading(
  data: DoctorReportData,
  type: string,
): { value: number; measuredAt: string } | null {
  const series = ownValue(data.measurements, type);
  if (!series || series.length === 0) return null;
  const stat = ownValue(data.stats, type);
  if (stat?.latestAt) return { value: stat.latest, measuredAt: stat.latestAt };
  return series[series.length - 1];
}

/**
 * Mints the shared `obs-N` sequence. The vital / BP / BMI / glucose / lab /
 * adherence / mood / wellness emitters all draw from ONE allocator so the ids
 * run as a single continuous run regardless of which blocks contributed —
 * splitting the emitters across modules must not renumber the output.
 */
export function observationIdSequence(): () => string {
  let seq = 0;
  return () => `obs-${(seq += 1)}`;
}

/**
 * The reporting window an aggregate Observation describes. Every value derived
 * OVER the period (a mean, a share, a rate, an average) carries this rather
 * than an `effectiveDateTime` pinned to the window's last instant — that
 * timestamp asserts a reading that was never taken.
 */
export function reportingPeriod(data: DoctorReportData): {
  start: string;
  end: string;
} {
  return { start: data.period.start, end: data.period.end };
}
