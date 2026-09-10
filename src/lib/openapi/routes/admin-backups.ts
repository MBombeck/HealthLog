/**
 * OpenAPI route table — the two backups-console routes that read a stored copy.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * Most of `/api/admin/backups/*` is deliberately unpublished: it is a
 * cookie-only console, `requireAdmin()` refuses every Bearer caller, and a
 * contract nobody can call against is a contract nobody reads. These two are
 * here for the opposite reason. Both open the encrypted copy in
 * `data_backups.data`, and both therefore have a refusal an operator meets on
 * the day a key rotation went one step too far — the case
 * `docs/ops/encryption-key-rotation.md` warns about. That refusal is a promise
 * (422, `backup.payload.undecryptable`, nothing changed) rather than whatever
 * the handler happens to answer, and a promise belongs somewhere it can be
 * quoted from.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { dataEnvelope, errorEnvelope, idempotencyKeyParameter } from "./shared";

const restoreRequest = z
  .object({
    confirm: z.literal("RESTORE"),
    restoreInstanceSettings: z.boolean().optional(),
  })
  .meta({
    id: "AdminBackupRestoreRequest",
    description:
      "`confirm` is the literal typed gate; anything else is refused with 422 and nothing is read. `restoreInstanceSettings` defaults to false: the restore then replaces the snapshot owner's data tables and leaves the singleton instance settings — registration, MFA requirement, default locale and timezone, module availability, notification and AI configuration, document cap and quota — exactly as they are. Send `true` only when rebuilding a host from a snapshot, because those settings apply to every account on the installation.",
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

const restoreResult = z
  .object({
    restored: z.literal(true),
    summary: z.record(z.string(), z.unknown()),
    skipped: z.object({
      catalogueKeys: z.array(restoreSkipEntry),
      links: z.number().int(),
    }),
    cleared: z.record(z.string(), z.number().int()),
  })
  .meta({
    id: "AdminBackupRestoreResult",
    description:
      "What the transaction wrote. `cleared` counts the rows each class held before it was rebuilt from the file, `summary` counts what the file carried, and `skipped.links` is the number of links dropped because a catalogue key in the file does not exist here — zero is the normal answer.",
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
    "The stored copy could not be opened: either the key that wrote it is no longer in `ENCRYPTION_KEYS` (a rotation that dropped the legacy entry too early), or the stored bytes are not the ones that were written. `meta.errorCode` = `backup.payload.undecryptable`. Nothing was changed.",
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

export const adminBackupPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/backups/{id}/download": {
    get: {
      tags: ["Admin"],
      summary: "Download one stored backup as JSON",
      description:
        "Decrypts one stored copy and returns the backup document itself, with `Content-Disposition: attachment` and `Cache-Control: no-store`. The response is the raw document, not the standard envelope — it is the artefact an operator keeps. The ciphertext stays in the database. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
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
      summary: "Restore one stored backup over its owner's record",
      description:
        "Replaces the snapshot owner's data tables from the stored copy, in one transaction, under the ids the file carries. Replacing is not merging: every row the account gained after the snapshot was taken is deleted with the rest of its class. The target is the account the snapshot was taken for, never the admin running it, and a payload declaring a different owner than the stored row is refused. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
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
        "200": {
          description: "The restore ran.",
          content: {
            "application/json": {
              schema: dataEnvelope(restoreResult, "AdminBackupRestoreResponse"),
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
            "Either the payload declares a different owner than the stored row, or a request under the same `Idempotency-Key` is still in flight. Nothing was changed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "The request or the file was refused before anything was written: `confirm` missing, the copy undecryptable (`meta.errorCode` = `backup.payload.undecryptable`), the payload failing schema validation, an unsupported `schemaVersion`, a section the file's own manifest says it carries and does not (`meta.errorCode` = `backup.section.missing`), a metadata-only document entry, or an owner who no longer exists here.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
