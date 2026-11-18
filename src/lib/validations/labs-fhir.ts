/**
 * `POST /api/labs/fhir-batch` (#1400): lab results from Apple Health's Health
 * Records, as the iOS app reads them from HealthKit (`HKClinicalRecord` →
 * `HKFHIRResource`). Each record carries the FHIR resource as parsed JSON and
 * the four HealthKit fields the identity is built from. The resource itself is
 * checked by the mapper, not here: an unknown shape is a per-record skip, not
 * a refusal of the batch.
 *
 * No `userId` field: the owner is the authenticated caller.
 */
import { z } from "zod/v4";

export const MAX_FHIR_LAB_RECORDS_PER_BATCH = 200;
/** A serialised resource past this is skipped as `too_large`. */
export const MAX_FHIR_LAB_RESOURCE_BYTES = 256 * 1024;

export const fhirLabRecordSchema = z.object({
  resource: z.record(z.string(), z.unknown()).meta({
    description:
      "The FHIR resource as JSON (`HKFHIRResource.data`), DSTU2 or R4. Only Observations of the laboratory category are kept.",
  }),
  fhirVersion: z.string().max(16).optional().meta({
    description: "`HKFHIRResource.fhirVersion` (e.g. `4.0.1`).",
  }),
  identifier: z.string().max(256).optional().meta({
    description:
      "`HKFHIRResource.identifier`, the resource's id at its source.",
  }),
  sourceURL: z.string().max(2048).optional().meta({
    description:
      "`HKFHIRResource.sourceURL`, the issuing institution's FHIR base.",
  }),
  sourceName: z.string().max(200).optional().meta({
    description:
      "The institution as the Health app names it (`sourceRevision.source.name`).",
  }),
});

export const fhirLabBatchSchema = z
  .object({
    records: z
      .array(fhirLabRecordSchema)
      .min(1)
      .max(MAX_FHIR_LAB_RECORDS_PER_BATCH),
  })
  .strict();

export type FhirLabBatchBody = z.infer<typeof fhirLabBatchSchema>;
