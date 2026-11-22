/**
 * OpenAPI route table — the record-file imports that share one queue: a
 * Gadgetbridge database export and a FHIR R4 Bundle
 * (`src/lib/import/file-import/`). Both upload as `multipart/form-data`,
 * answer 202 with a job, and report on a status route with the same result
 * shape: counts, the summary lines and the skipped items, never content.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { healthConnectRemoteSchema } from "@/lib/validations/health-connect-remote";

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

/**
 * The refusals every staged file upload answers alike
 * (`src/lib/import/staged-upload.ts`). Spread after the 202.
 */
export function stagedUploadErrorResponses(cap: string) {
  return {
    "400": {
      description: "The request carried no body at all.",
      content: { "application/json": { schema: errorEnvelope } },
    },
    "409": {
      description:
        "An import for this account (of any kind) is already queued or running. The upload was discarded. `meta.errorCode` is `import.apple_health.busy` for every kind, `meta.jobId` names the running job; poll it, then upload again.",
      content: { "application/json": { schema: errorEnvelope } },
    },
    "413": {
      description: `The file is larger than ${cap}. Answered alike whether the declared \`Content-Length\` says so (beyond a 64 KiB allowance for the multipart envelope) or the stream finds it while reading; \`meta.errorCode\` is \`import.file.too_large\`. Nothing was kept.`,
      content: { "application/json": { schema: errorEnvelope } },
    },
    ...stdResponses,
    "422": {
      description:
        "The multipart body could not be read: no `file` part, a malformed boundary, or a dropped connection. The message names the failure. Whether the file itself is readable is decided by the worker and reported on the job (`status: failed`, `failureReason`).",
      content: { "application/json": { schema: errorEnvelope } },
    },
    "429": {
      ...stdResponses["429"],
      description: `More than five uploads of this kind in a minute by this account (the bucket \`import:<kind>:<account>\`, spent before the body is read). ${stdResponses["429"].description}`,
    },
    "503": {
      description:
        "No background worker is bound, or the queue did not take the job (the job is then marked failed), so nothing would run the import. The upload was discarded; retry once a worker runs.",
      content: { "application/json": { schema: errorEnvelope } },
    },
  };
}

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
        ...stagedUploadErrorResponses(input.cap),
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
  "Body is `multipart/form-data` with the file under `file`, streamed to disk after authentication. The response is **202 with a `jobId`**; poll the status route. Re-uploading the same bytes resolves to the still-viable job. One import per account at a time, whatever its kind. Five uploads a minute per account and kind. A run stops at a ten-minute budget, keeps what it wrote and fails with `time_budget`; uploading the same file again continues. Cookie or wildcard Bearer.";

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

const healthConnectRemoteState = z
  .object({
    source: z
      .object({
        folderUrl: z.string(),
        fileName: z.string(),
        enabled: z.boolean(),
        lastAttemptAt: z.string().nullable(),
        lastOutcome: z
          .string()
          .nullable()
          .describe(
            "The closed outcome of the last attempt: `imported`, `unchanged`, `busy`, `not_found`, `unauthorized`, `redirected`, `upstream_error`, `too_large`, `timeout`, `network`, `private_origin_not_approved`, `invalid_origin`, `no_worker`.",
          ),
        nextAttemptAt: z.string(),
        consecutiveFailures: z.number().int(),
        lastImportJobId: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "HealthConnectRemoteState" });

const remoteRefusal = {
  description:
    "The folder cannot be used: `import.health_connect.remote.invalid_url` (not a URL, or one with credentials, a query or a fragment), `import.health_connect.remote.private_origin_not_approved` (a private address not listed in `HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS`), `import.health_connect.remote.https_required` (a public address over plain `http:`; the password travels in a Basic header), `import.health_connect.remote.origin_config_invalid`, or `import.health_connect.remote.password_required` on a first save, or a save that moves the folder to another origin, without a password.",
  content: { "application/json": { schema: errorEnvelope } },
};

export const healthConnectRemotePaths: NonNullable<ZodOpenApiObject["paths"]> =
  {
    "/api/import/health-connect-remote": {
      get: {
        tags: ["Import"],
        summary: "The folder a scheduled Health Connect export is fetched from",
        description:
          "The account's WebDAV or Nextcloud folder and its last attempt, or `source: null`. The credentials are never returned. Owner-only.",
        responses: {
          "200": {
            description: "The folder, or null.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  healthConnectRemoteState,
                  "HealthConnectRemoteEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
      put: {
        tags: ["Import"],
        summary:
          "Save the folder a scheduled Health Connect export is fetched from",
        description:
          "Saves the folder (`folderUrl`, a WebDAV address such as Nextcloud's `remote.php/dav/files/<user>/<folder>`), the export's `fileName` in it (default `Health Connect.zip`), the WebDAV `username` and, on the first save, on a move to another origin, or to change it, the `password` (sealed at rest, never returned). The stored password only goes to the origin it was given for, so moving the folder to another server without a new one is a 422. A save that carries a `password` asks for a fresh proof: a cookie session that signed in or re-proved within five minutes, else 401 `auth.reproof.required`; a Bearer caller presents an `X-Step-Up` elevation. A public folder must use `https:`; plain `http:` is accepted only for a private origin listed exactly, scheme included. HealthLog then fetches the file about every six hours, through `safeFetch` with no redirects followed, and hands a file it has not seen (by SHA-256) to the Health Connect import queue, the same importer an upload uses. A failure backs off from thirty minutes to a day. A private address needs its exact origin in `HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS`. Ten saves an hour.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: healthConnectRemoteSchema },
          },
        },
        responses: {
          "200": {
            description: "Saved; the folder as it now reads.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  healthConnectRemoteState,
                  "HealthConnectRemoteSavedEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
          "422": remoteRefusal,
        },
      },
      delete: {
        tags: ["Import"],
        summary: "Forget the Health Connect folder",
        description:
          "Deletes the folder and its sealed credentials. Imports already made stay.",
        responses: {
          "200": {
            description: "Whether a folder was removed.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.object({ deleted: z.boolean() }),
                  "HealthConnectRemoteDeletedEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
    },
    "/api/import/health-connect-remote/fetch": {
      post: {
        tags: ["Import"],
        summary: "Fetch the Health Connect folder now",
        description:
          "Marks the folder due and sends one job to the scheduled fetch's queue; the download never runs in the request. Follow the outcome on `GET /api/import/health-connect-remote` and the import on `GET /api/import/health-connect-export/status`. Six an hour.",
        responses: {
          "202": {
            description: "Queued.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.object({ queued: z.boolean() }),
                  "HealthConnectRemoteFetchEnvelope",
                ),
              },
            },
          },
          "404": {
            description:
              "No folder is set up (`import.health_connect.remote.not_configured`).",
            content: { "application/json": { schema: errorEnvelope } },
          },
          ...stdResponses,
        },
      },
    },
  };
