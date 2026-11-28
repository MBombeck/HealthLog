/**
 * The `Coverage` resource — the insurer relationship, with the payor as a
 * CONTAINED `Organization` referenced by a local `#`-ref.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import type { FhirCoverage, FhirOrganization } from "@/lib/fhir/types";
import {
  COVERAGE_CLASS_SYSTEM,
  IKNR_SYSTEM,
  patientRef,
  type FhirPatientIdentity,
} from "@/lib/fhir/resources/common";

/**
 * Emit the `Coverage`, or `null` when no payor is known.
 *
 * R4 marks `Coverage.payor` as `1..*`: a Coverage names who pays, and one that
 * cannot is not a Coverage. A record that carries only a member id (a bare
 * insurance number, no insurer name and no IKNR) therefore emits none — nothing is lost,
 * because the member id already rides `Patient.identifier` and doubles as the
 * `subscriberId` when a real Coverage does go out.
 */
export function coverageResource(
  data: DoctorReportData,
  identity: FhirPatientIdentity,
): FhirCoverage | null {
  const insurerName = data.patient.insurerName ?? null;
  const insurerIkNumber = data.patient.insurerIkNumber ?? null;
  if (!insurerName && !insurerIkNumber) return null;

  const orgId = "insurer-org-1";
  const payorOrg: FhirOrganization = {
    resourceType: "Organization",
    id: orgId,
  };
  if (insurerIkNumber) {
    payorOrg.identifier = [{ system: IKNR_SYSTEM, value: insurerIkNumber }];
  }
  if (insurerName) payorOrg.name = insurerName;

  const coverage: FhirCoverage = {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: patientRef,
    contained: [payorOrg],
    payor: [{ reference: `#${orgId}` }],
  };
  if (identity.insuranceNumber) {
    coverage.subscriberId = identity.insuranceNumber;
  }
  if (identity.insuranceGroupNumber) {
    coverage.class = [
      {
        type: { coding: [{ system: COVERAGE_CLASS_SYSTEM, code: "group" }] },
        value: identity.insuranceGroupNumber,
      },
    ];
  }
  return coverage;
}
