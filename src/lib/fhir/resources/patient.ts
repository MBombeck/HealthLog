/**
 * The `Patient` resource: display name, administrative gender, birth date and
 * the KVNR identifier. Every absent field collapses its slot.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import type { FhirPatient } from "@/lib/fhir/types";
import {
  KVNR_SYSTEM,
  PATIENT_RESOURCE_ID,
  type FhirPatientIdentity,
} from "@/lib/fhir/resources/common";

/**
 * Stored gender → the R4 `administrative-gender` code.
 *
 * The stored value is the free-text projection of the app's own three-member
 * enum. The mapping is exhaustive over it and closed to everything else: an
 * unrecognised string omits the element rather than picking a side, because a
 * clinical document that names a gender the person did not record states
 * something false about them.
 *
 * `unknown` is deliberately never emitted. In FHIR it means "asked, and the
 * answer is not known" — a positive claim about an interaction that did not
 * happen. An unrecorded field is honestly absent instead.
 */
const ADMINISTRATIVE_GENDER: Record<string, FhirPatient["gender"]> = {
  MALE: "male",
  FEMALE: "female",
  OTHER: "other",
};

/** The R4 gender code for a stored value, or `null` to omit the element. */
export function administrativeGender(
  stored: string | null | undefined,
): FhirPatient["gender"] | null {
  if (!stored) return null;
  return ADMINISTRATIVE_GENDER[stored] ?? null;
}

/**
 * Emit the `Patient` resource from the aggregated report data + decrypted
 * identity.
 */
export function patientResource(
  data: DoctorReportData,
  identity: FhirPatientIdentity,
): FhirPatient {
  const patient: FhirPatient = {
    resourceType: "Patient",
    id: PATIENT_RESOURCE_ID,
  };
  if (data.patient.name) patient.name = [{ text: data.patient.name }];
  const gender = administrativeGender(data.patient.gender);
  if (gender) patient.gender = gender;
  if (data.patient.dateOfBirth) {
    patient.birthDate = data.patient.dateOfBirth.slice(0, 10);
  }
  if (identity.insuranceNumber) {
    patient.identifier = [
      { system: KVNR_SYSTEM, value: identity.insuranceNumber },
    ];
  }
  return patient;
}
