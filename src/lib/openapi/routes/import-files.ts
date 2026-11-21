/**
 * OpenAPI route table — the record-file imports that share one queue: a
 * Gadgetbridge database export and a FHIR R4 Bundle
 * (`src/lib/import/file-import/`). Both upload as `multipart/form-data`,
 * answer 202 with a job, and report on a status route with the same result
 * shape: counts, the summary lines and the skipped items, never content.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const recordFileImportResult = z
  .object({
    kind: z.enum(["gadgetbridge", "fhir_bundle"]),
    imported: z.number().int(),
    duplicates: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    lines: z
      .array(
        z.object({
          key: z
            .string()
            .describe(
              "A measurement type (`ACTIVITY_STEPS`, `PULSE`, …) or a record family (`lab`, `condition`, `vaccination`, `medication`, `visit`).",
            ),
          imported: z.number().int(),
          duplicates: z.number().int(),
        }),
      )
      .describe("What each kind of row became."),
    skips: z
      .array(
        z.object({
          key: z
            .string()
            .describe(
              "A Gadgetbridge table name or a FHIR resource type: a schema name, never content.",
            ),
          reason: z
            .string()
            .describe(
              "A closed reason code: `not_read`, `invalid_time`, `invalid_value`, `out_of_range`, `unsupported_type`, `unsupported_category`, `unit_mismatch`, `not_final`, `no_date`, `future_date`, `no_label`, `not_confirmed`, `not_completed`, `not_taken`, `not_a_visit`, or one of the lab mapping's reasons.",
            ),
          count: z.number().int(),
        }),
      )
      .describe("What the file held that was not imported, and why."),
    budgetExceeded: z
      .boolean()
      .describe(
        "The run stopped at its ten-minute budget. The job is `failed` with `time_budget`; uploading the same file again continues, and what was written is found under its identities.",
      ),
    measuredSpan: z.object({ from: z.string(), to: z.string() }).nullable(),
    durationMs: z.number().int(),
  })
  .meta({ id: "RecordFileImportResult" });

const recordFileImportJob = z
  .object({
    jobId: z.string(),
    status: z.string(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    uploadBytes: z.number().int(),
    result: recordFileImportResult.nullable(),
    failureReason: z
      .string()
      .nullable()
      .describe(
        "On `failed`, a reason led by a closed code and a colon: `not_gadgetbridge`, `unsafe_schema`, `not_fhir_bundle`, `too_many_entries`, `too_large`, `time_budget`, `staging_missing`.",
      ),
  })
  .meta({ id: "RecordFileImportJob" });

function uploadPath(input: {
  summary: string;
  description: string;
  cap: string;
  fileDescription: string;
  envelope: string;
}): NonNullable<ZodOpenApiObject["paths"]>[string] {
  return {
    post: {
      tags: ["Import"],
      summary: input.summary,
      description: input.description,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().describe(input.fileDescription),
            }),
          },
        },
      },
      responses: {
        "202": {
          description:
            "Accepted and queued, or matched to a job already carrying these bytes (`idempotent: true`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  jobId: z.string(),
                  status: z.string(),
                  idempotent: z.boolean().optional(),
                }),
                input.envelope,
              ),
            },
          },
        },
        "400": {
          description: "The request carried no body at all.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "An import for this account (of any kind) is already queued or running. The upload was discarded. `errorCode` is `import.apple_health.busy`, `jobId` names the running job.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: `The file is larger than ${input.cap} (\`import.file.too_large\`).`,
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The multipart body could not be read. Whether the file is readable is decided by the worker and reported on the job.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No background worker is bound, or the queue did not take the job.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  };
}

function statusPath(
  summary: string,
  envelope: string,
): NonNullable<ZodOpenApiObject["paths"]>[string] {
  return {
    get: {
      tags: ["Import"],
      summary,
      description:
        "The caller's most recent import of this kind, or `null` when there has never been one. Counts and closed reasons only.",
      responses: {
        "200": {
          description: "The latest job, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ job: recordFileImportJob.nullable() }),
                envelope,
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  };
}

const SHARED =
  "Body is `multipart/form-data` with the file under `file`, streamed to disk after authentication. The response is **202 with a `jobId`**; poll the status route. Re-uploading the same bytes resolves to the still-viable job. One import per account at a time, whatever its kind. Five uploads a minute per account. A run stops at a ten-minute budget, keeps what it wrote and fails with `time_budget`; uploading the same file again continues. Cookie or wildcard Bearer.";

export const importFilePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/import/gadgetbridge": uploadPath({
    summary: "Upload a Gadgetbridge database export for background import",
    description: `Takes the SQLite file Gadgetbridge's "Export database" writes, at most 512 MB. Tables are found by name and columns, so the importer reads every device family's schema version: activity samples become one ACTIVITY_STEPS total per local day (the device with the most steps that day) and one PULSE mean per local hour; SpO2 samples OXYGEN_SATURATION; resting and manual heart rate RESTING_HEART_RATE and PULSE; sleep sessions SLEEP_DURATION in minutes; weight samples WEIGHT. Rows carry \`source = IMPORT\` and a stable identity, so a second import writes nothing twice; a later export's larger day total replaces the earlier one. Every other table with rows is named in the result's \`skips\`. ${SHARED}`,
    cap: "512 MB",
    fileDescription: "The Gadgetbridge database file, under the field `file`.",
    envelope: "GadgetbridgeImportKickoffEnvelope",
  }),
  "/api/import/gadgetbridge/status": statusPath(
    "The caller's latest Gadgetbridge import",
    "GadgetbridgeImportStatusEnvelope",
  ),
  "/api/import/fhir-bundle": uploadPath({
    summary: "Upload a FHIR R4 Bundle for background import",
    description: `Takes a FHIR R4 Bundle (JSON) from a patient portal, at most 32 MB and 50 000 entries. Laboratory Observations go through the Health Records lab mapping (marker matching, unit normalisation, panels) under \`source = IMPORT\`; vital-sign Observations become measurements by a closed LOINC table and are refused in a unit it does not list; Conditions become illness entries, Immunizations vaccinations, MedicationStatements medications (no schedule, reminders off), Encounters visits. Every resource is deduplicated by its issuer and id, so the same Bundle imported again writes nothing. Other resource types are counted in \`skips\`. C-CDA documents are not read. ${SHARED}`,
    cap: "32 MB",
    fileDescription: "The Bundle as a JSON file, under the field `file`.",
    envelope: "FhirBundleImportKickoffEnvelope",
  }),
  "/api/import/fhir-bundle/status": statusPath(
    "The caller's latest FHIR Bundle import",
    "FhirBundleImportStatusEnvelope",
  ),
};
