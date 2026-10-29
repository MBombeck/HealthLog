/**
 * OpenAPI route table — the backups-console routes that read a stored copy, and
 * the restore job they start, and the upload that stores a copy to restore.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * Most of `/api/admin/backups/*` is deliberately unpublished: it is a
 * cookie-only console, `requireAdmin()` refuses every Bearer caller, and a
 * contract nobody can call against is a contract nobody reads. The two readers
 * are here for the opposite reason. Both open the encrypted stored copy (pieces in
 * `data_backup_chunks`, or one value in `data_backups.data` for a copy written
 * before v1.39.2), and both therefore have a refusal an operator meets on
 * the day a key rotation went one step too far — the case
 * `docs/ops/encryption-key-rotation.md` warns about. That refusal is a promise
 * (422, `backup.payload.undecryptable`, nothing changed) rather than whatever
 * the handler happens to answer, and a promise belongs somewhere it can be
 * quoted from.
 *
 * The upload is here for the same reason: it refuses a file the operator has
 * in hand for reasons they have to be able to look up (a key this server does
 * not hold, an owner that does not exist here, a newer schema), and its answer
 * is the copy id the restore takes.
 *
 * The restore answers 202 and runs as a background job, so the two routes that
 * report on that job are published with it: a 202 without its status route is
 * half a contract.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  stdResponses,
} from "./shared";

const restoreRequest = z
  .object({
    confirm: z.literal("RESTORE"),
    restoreInstanceSettings: z.boolean().optional(),
  })
  .meta({
    id: "AdminBackupRestoreRequest",
    description:
      "`confirm` is the literal typed gate; anything else is refused with 422 and nothing is read. `restoreInstanceSettings` defaults to false: the restore then replaces the snapshot owner's data tables and leaves the singleton instance settings — registration, MFA requirement, default locale and timezone, module availability, notification and AI configuration, document cap and quota — exactly as they are. Send `true` only when this server's instance settings themselves need to go back to the ones in the copy, because those settings apply to every account on the installation. An account copy restores one existing account on this server; it does not rebuild a lost server, which takes a database dump and the encryption keys (`docs/ops/disaster-recovery.md`).",
  });

const restoreSkipEntry = z
  .object({
    catalogue: z.string(),
    key: z.string(),
    links: z.number().int(),
  })
  .meta({
    id: "AdminBackupRestoreSkipEntry",
    description:
      "One catalogue key the file referenced and this instance could not resolve, with the number of links it cost.",
  });

const restoreQueued = z
  .object({
    jobId: z.string(),
    status: z.literal("queued"),
    statusUrl: z.string(),
  })
  .meta({
    id: "AdminBackupRestoreQueued",
    description:
      "The restore was accepted and queued. Poll `statusUrl` (`GET /api/admin/backups/restores/{jobId}`) for its progress and outcome.",
  });

const restorePhase = z
  .enum(["validating", "clearing", "measurements", "sections", "rebuilding"])
  .meta({
    id: "AdminBackupRestorePhase",
    description:
      "Where a running restore is: reading and checking the file, clearing the account's current data, writing the readings, writing the other sections, rebuilding the chart tiers after the commit.",
  });

const restoreProgress = z
  .object({
    measurementsChecked: z.number().int(),
    measurementsTotal: z.number().int().nullable(),
    measurementsWritten: z.number().int(),
    sectionsDone: z.number().int(),
    sectionsTotal: z.number().int(),
  })
  .meta({
    id: "AdminBackupRestoreProgress",
    description:
      "Counts only. `measurementsTotal` is null until the first read of the file has counted the readings.",
  });

const restoreFailure = z
  .object({
    code: z.string().meta({
      description:
        "Stable reason: `backup_not_found`, `backup_changed`, `backup.payload.undecryptable`, `schema_invalid`, `incompatible_schema_version`, `owner_mismatch`, `owner_not_found`, `backup.section.missing`, `document_ciphertext_missing`, `backup.key.missing`, `backup.foreign_reference`, `time_budget`, `transaction_failed`, `interrupted`, `not_started`, `enqueue_failed`, `failed_after_commit`, `unexpected`. Every code but `failed_after_commit` means the account was not changed.",
    }),
    message: z.string(),
    sections: z.array(z.string()).optional(),
    keyIds: z.array(z.string()).optional(),
    cause: z
      .enum(["timeout", "lock", "constraint", "storage", "connection", "other"])
      .optional(),
  })
  .meta({
    id: "AdminBackupRestoreFailure",
    description:
      "Why the restore did not happen, in a sentence an operator can act on. `sections` names the missing sections for `backup.section.missing`; `keyIds` names the encryption key ids the file needs and this server cannot open it with, for `backup.key.missing`; `cause` says what the database refused a `transaction_failed` restore over: it ran out of time, waited on a lock, rejected a record, ran out of disk space or memory, lost the connection, or something else.",
  });

const restoreJob = z
  .object({
    id: z.string(),
    userId: z.string(),
    username: z.string().nullable(),
    backupId: z.string(),
    restoreInstanceSettings: z.boolean(),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    phase: restorePhase.nullable(),
    progress: restoreProgress.nullable(),
    result: z
      .object({
        summary: z.record(z.string(), z.unknown()),
        skipped: z.object({
          catalogueKeys: z.array(restoreSkipEntry),
          links: z.number().int(),
        }),
        cleared: z.record(z.string(), z.number().int()),
      })
      .nullable(),
    failure: restoreFailure.nullable(),
    waiting: z
      .enum(["backup", "busy"])
      .nullable()
      .describe(
        "Why a `queued` job has not started. A restore never runs beside a backup or another large job: while one holds the server it goes back to the queue for a minute at a time. `backup` when a backup pass holds it, `busy` for anything else (an import, a nightly pass, the memory guard). Null while the job only waits for the worker, and on every job that is not queued.",
      ),
    attempts: z.number().int(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .meta({
    id: "AdminBackupRestoreJob",
    description:
      "One restore job. `phase` and `progress` describe a running job; `result` is set once it `succeeded` (the same report the synchronous restore used to answer with, less `restored`); `failure` once it `failed`. `attempts` counts the starts: a job whose worker stopped before the data was committed is started once more; one that stopped after the commit is closed as `failed_after_commit` and never run again.",
  });

/**
 * The one refusal both routes share, worded once.
 *
 * A stored copy that will not open is bad stored input, not a fault in the
 * server: either the key that wrote it is no longer in `ENCRYPTION_KEYS`, or
 * the stored bytes are not the bytes that were written. It answers 422 like
 * every other bad input on these routes, and never as a 500.
 */
const undecryptableResponse = {
  description:
    "The stored copy could not be opened: either the key that wrote it is no longer in `ENCRYPTION_KEYS` (a rotation that dropped the legacy entry too early), or the stored bytes are not the ones that were written (a stored piece missing, moved, altered, taken from another copy, or the copy cut short), or the row holds both a single value and pieces, which only an older release writing to it after an upgrade produces. Every piece is checked before any of the copy is read. `meta.errorCode` = `backup.payload.undecryptable`. Nothing was changed.",
  content: { "application/json": { schema: errorEnvelope } },
};

/**
 * A copy replaced by a newer one (the weekly backup) while it was being
 * opened or read. Not damage: the reader starts again on the new copy.
 */
const replacedResponse = {
  description:
    "The stored copy was replaced by a newer one while it was being read. `meta.errorCode` = `backup_changed`. Nothing was changed; start again to use the new copy.",
  content: { "application/json": { schema: errorEnvelope } },
};

const adminOnlyResponse = {
  description:
    "Caller is not an admin. `requireAdmin()` is cookie-only, so a Bearer token lands here whatever its scope.",
  content: { "application/json": { schema: errorEnvelope } },
};

const notFoundResponse = {
  description: "No stored copy with this id.",
  content: { "application/json": { schema: errorEnvelope } },
};

const uploadSummary = z
  .object({
    schemaVersion: z.string(),
    userId: z.string(),
    exportedAt: z.string(),
  })
  .catchall(z.number().int())
  .meta({
    id: "AdminBackupUploadSummary",
    description:
      "What the stored file holds: its `schemaVersion`, the account it was exported from (`userId`) and when (`exportedAt`), and one count per serialised class (`measurements`, `medications`, `intakeEvents`, `moodEntries`, …). The set of counts grows with the backup format; read the ones you know and show the rest generically.",
  });

const uploadStored = z
  .object({
    id: z.string().meta({
      description:
        "`DataBackup.id` of the stored copy; pass it to `POST /api/admin/backups/{id}/restore`.",
    }),
    valid: z.literal(true),
    summary: uploadSummary,
  })
  .meta({
    id: "AdminBackupUploadResponse",
    description:
      "The file was read, checked and stored as a new copy. Nothing was restored.",
  });

export const adminBackupPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/backups/upload": {
    post: {
      tags: ["Admin"],
      summary: "Store an uploaded backup file as a new copy",
      description:
        "Reads a backup file, checks it, and stores it encrypted as a new copy beside the weekly one; it does NOT restore anything. Restoring is the separate `POST /api/admin/backups/{id}/restore`, so an operator can review what was uploaded first. The file goes up as the raw request body, plain JSON or gzip-compressed JSON (sniffed from the bytes, not the content type), up to 512 MB as sent; or, for a file up to 10 MB, as `multipart/form-data` with one `file` field. It is read as a stream, checked as it arrives, and stored in the same pass; a file that fails any check leaves nothing behind. It is refused when it is not valid JSON, fails the backup schema, was written by a newer schema version than this server reads, needs an encryption key this server does not hold (`meta.errorCode` = `backup.key.missing`, `meta.keyIds` naming them), or belongs to an account that does not exist here (`meta.errorCode` = `backup.owner.missing`). A file of an account that no longer exists here (erased, say) can be sent again with a target in the query: `into=existing&userId=<id>&confirm=<username>` for an account that holds no records yet, or `into=new&username=<name>` for a new account created for the copy, with no password and no email (an admin sets its first password with the existing password reset). The file's owner is rewritten to that account as it is read, so the stored copy is that account's copy and restores like any other; the erased account's id is not stored. A target is refused before the file is read when the account does not exist, is a managed profile, is pending deletion, or holds records (a restore replaces records, it does not merge them); a file whose own account is still here is refused with a target (`backup.owner.exists`). Three uploads a minute per administrator. Admin session cookie required; Bearer tokens cannot reach admin endpoints. A browser session needs a fresh proof as well as a live one: a sign-in or `POST /api/auth/reproof` within the last five minutes (with a second factor, on an account that has one). Without it the answer is 401 `auth.reproof.required`, with `meta.methods` naming the proofs the account can give.",
      requestParams: {
        query: z.object({
          into: z.enum(["existing", "new"]).optional().meta({
            description:
              "Where the copy goes when the account the file names does not exist here. Absent: the file's own account, which has to exist.",
          }),
          userId: z.string().max(64).optional().meta({
            description: "With `into=existing`: the account's id.",
          }),
          confirm: z.string().max(64).optional().meta({
            description:
              "With `into=existing`: the account's username, typed by the operator.",
          }),
          username: z.string().min(3).max(30).optional().meta({
            description:
              "With `into=new`: the new account's username (letters, digits, `_` and `-`).",
          }),
        }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z.record(z.string(), z.unknown()).meta({
              description:
                "The backup document, as `GET /api/admin/backups/{id}/download` or the account export wrote it.",
            }),
          },
          "application/gzip": {
            schema: z.string().meta({ format: "binary" }),
          },
          "multipart/form-data": {
            schema: z.object({
              file: z.string().meta({
                format: "binary",
                description:
                  "The backup file, plain or gzip-compressed, up to 10 MB.",
              }),
            }),
          },
        },
      },
      responses: {
        "201": {
          description: "The file was stored as a new copy.",
          content: {
            "application/json": {
              schema: dataEnvelope(uploadStored, "AdminBackupUploadEnvelope"),
            },
          },
        },
        "400": {
          description:
            "A `multipart/form-data` body that could not be parsed as a form. Nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": {
          description:
            "No session (`auth.missing`), or a session without a recent proof (`auth.reproof.required`, with `meta.methods`). A Bearer token lands here too: the admin gate reads only the session cookie.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "The account chosen with `into=existing` does not exist (`backup.target.not_found`). Nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The chosen target cannot take the copy, and nothing was stored: a managed profile (`backup.target.managed_profile`), an account pending deletion (`backup.target.pending_deletion`), an admin account (`backup.target.admin_account`), an account that already holds records (`backup.target.holds_records`, `meta.models` naming them), a username already taken (`backup.target.username_taken`), or a file whose own account is still here (`backup.owner.exists`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description:
            "Too large: over 512 MB as sent (10 MB in a form), a gzip file that expands past what any backup this server wrote does, or larger than the stored-copy limit once encrypted (`meta.errorCode` = `backup.upload.too_large`, the numbers and the setting in the message). Nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "The file was refused and nothing was stored: no file in the request, not valid JSON or not readable as gzip, failed the backup schema (`meta.issues`), an unsupported schema version, a key this server does not hold (`meta.errorCode` = `backup.key.missing`, `meta.keyIds`), an owner account that does not exist here (`backup.owner.missing`), a target query that does not parse (`details.issues`), or an `into=existing` whose `confirm` is not the account's username (`backup.target.unconfirmed`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          ...stdResponses["429"],
          description:
            "More than three uploads in a minute by this administrator. Nothing was stored. The `Retry-After` and `X-RateLimit-*` headers describe the bucket.",
        },
      },
    },
  },
  "/api/admin/backups/{id}/download": {
    get: {
      tags: ["Admin"],
      summary: "Download one stored backup as JSON",
      description:
        "Decrypts one stored copy and returns the backup document itself, with `Content-Disposition: attachment` and `Cache-Control: no-store`. The response is the raw document, not the standard envelope — it is the artefact an operator keeps. The ciphertext stays in the database. Admin session cookie required; Bearer tokens cannot reach admin endpoints. A browser session needs a fresh proof as well as a live one: a sign-in or `POST /api/auth/reproof` within the last five minutes (with a second factor, on an account that has one). Without it the answer is 401 `auth.reproof.required`, with `meta.methods` naming the proofs the account can give.",
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: "`DataBackup.id`." }),
        }),
      },
      responses: {
        "200": {
          description: "The decrypted backup document.",
          content: {
            "application/json": {
              schema: z.record(z.string(), z.unknown()).meta({
                id: "AdminBackupDocument",
                description:
                  "The backup payload as the writer serialised it: `schemaVersion`, `exportedAt`, `userId`, and one array or object per serialised class.",
              }),
            },
          },
        },
        "403": adminOnlyResponse,
        "404": notFoundResponse,
        "409": replacedResponse,
        "422": undecryptableResponse,
        "500": {
          description:
            "The copy decrypted and then failed schema validation — a document this instance wrote and cannot parse. This one genuinely is a server fault, and is reported as one.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/admin/backups/{id}/restore": {
    post: {
      tags: ["Admin"],
      summary: "Queue the restore of one stored backup over its owner's record",
      description:
        "Queues a restore that replaces the snapshot owner's data tables from the stored copy, in one transaction, under the ids the file carries, and answers 202 with the job's id. Replacing is not merging: every row the account gained after the snapshot was taken is deleted with the rest of its class. The target is the account the snapshot was taken for, never the admin running it. The request refuses a missing confirmation, an unknown backup and a copy that cannot be decrypted; the file's own checks (schema, declared owner, manifest, documents) run in the job before anything is deleted, and a refusal there ends the job as `failed` with the same reason. One restore per account at a time. Admin session cookie required; Bearer tokens cannot reach admin endpoints. A browser session needs a fresh proof as well as a live one: a sign-in or `POST /api/auth/reproof` within the last five minutes (with a second factor, on an account that has one). Without it the answer is 401 `auth.reproof.required`, with `meta.methods` naming the proofs the account can give.",
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: "`DataBackup.id`." }),
        }),
      },
      // The one write here, and the destructive one: the console sends a
      // per-row key so a double-click replays the first answer instead of
      // running the transaction twice.
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: restoreRequest } },
      },
      responses: {
        "202": {
          description:
            "The restore is queued. Its progress and outcome are at `statusUrl`.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                restoreQueued,
                "AdminBackupRestoreQueuedResponse",
              ),
            },
          },
        },
        "400": {
          description: "Body was not JSON.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": adminOnlyResponse,
        "404": notFoundResponse,
        "409": {
          description:
            "A restore of the same account is already queued or running (`meta.errorCode` = `backup.restore.active`, `meta.jobId` names it), the stored copy was replaced by a newer one while it was being checked (`meta.errorCode` = `backup_changed`), or a request under the same `Idempotency-Key` is still in flight. Nothing was changed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "The request was refused before anything was queued: `confirm` missing, or the copy undecryptable (`meta.errorCode` = `backup.payload.undecryptable`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "The restore could not be handed to the background worker. Nothing was changed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/admin/backups/restores": {
    get: {
      tags: ["Admin"],
      summary: "List the restores the backups console shows",
      description:
        "Every queued or running restore, and those created in the last day, newest first, at most 20. What the console reads when it opens, so a reload during a restore picks its progress up again. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      responses: {
        "200": {
          description: "The restore jobs.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ jobs: z.array(restoreJob) }),
                "AdminBackupRestoreJobListResponse",
              ),
            },
          },
        },
        "403": adminOnlyResponse,
      },
    },
  },
  "/api/admin/backups/restores/{jobId}": {
    get: {
      tags: ["Admin"],
      summary: "Read one restore job",
      description:
        "The status, phase and counts of one restore, and its report or its failure once it finished. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      requestParams: {
        path: z.object({
          jobId: z.string().meta({
            description: "The `jobId` the restore request answered with.",
          }),
        }),
      },
      responses: {
        "200": {
          description: "The restore job.",
          content: {
            "application/json": {
              schema: dataEnvelope(restoreJob, "AdminBackupRestoreJobResponse"),
            },
          },
        },
        "403": adminOnlyResponse,
        "404": {
          description: "No restore job with this id.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
