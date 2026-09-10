/**
 * OpenAPI route table — the whole export surface: the mixed plaintext
 * download, the three per-type CSV downloads, the restore-compatible full
 * backup, and the passphrase-encrypted archive.
 *
 * All of it predated the registry, and none of it was caught, because
 * `pnpm openapi:check` compares the registry against the YAML and never the
 * ROUTE TREE against the registry: a route registered nowhere drifts with
 * every gate green.
 *
 * One property is worth reading before any of the operations below: NONE of
 * these responses is the standard `{ data, error }` envelope. Each route
 * builds its own `NextResponse` so it can stream and set a filename, so a
 * client decoding these with the shared envelope decoder will fail on all of
 * them. Every one of them shares the `export:<userId>` rate bucket, so ten
 * downloads an hour is the budget across the whole family and not per route.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { backupPayloadSchema } from "@/lib/validations/backup";
import {
  errorEnvelope,
  SHARING_NOT_PERMITTED_DESCRIPTION,
  stdResponses,
} from "./shared";

const exportQuery = z
  .object({
    format: z
      .enum(["csv", "json"])
      .optional()
      .describe(
        "Serialisation. Omitted means `json`. Anything else is refused with 422 — the value is NOT clamped to the default.",
      ),
    type: z
      .enum(["measurements", "medications", "intake", "mood", "all"])
      .optional()
      .describe(
        "Which sections to include. Omitted means `all`. Anything else is refused with 422.",
      ),
  })
  .meta({ id: "ExportQuery" });

const forgivingSince = z.iso
  .datetime({ offset: true })
  .optional()
  .describe(
    "Inclusive lower bound. Parsed with the plain Date constructor, so an ISO date (`2026-07-14`) works as well as a full instant — and an UNPARSEABLE value is silently DROPPED from the filter rather than refused, which widens the export instead of erroring. Validate on your side.",
  );

const forgivingUntil = z.iso
  .datetime({ offset: true })
  .optional()
  .describe("Inclusive upper bound, with the same forgiving parse as `since`.");

const exportRangeQuery = z
  .object({ since: forgivingSince, until: forgivingUntil })
  .meta({ id: "ExportRangeQuery" });

const exportMeasurementsQuery = z
  .object({
    since: forgivingSince,
    until: forgivingUntil,
    granularity: z
      .literal("raw")
      .optional()
      .describe(
        "Send `raw` for one row per stored sample, per-sleep-stage rows included. Anything else — including a misspelling — falls through to the default night aggregation rather than 422-ing.",
      ),
  })
  .meta({ id: "ExportMeasurementsQuery" });

const exportMedicationsQuery = z
  .object({
    intake: z
      .literal("false")
      .optional()
      .describe(
        "Send exactly `false` to omit the intake-history section. Any other value, and omitting it, leaves the history IN — the test is an equality against the string, not a boolean parse.",
      ),
    medicationId: z
      .string()
      .optional()
      .describe(
        "Scope both sections to one medication. Always narrowed by the account, so an id this account does not hold answers 404.",
      ),
    since: forgivingSince,
    until: forgivingUntil,
  })
  .meta({ id: "ExportMedicationsQuery" });

const exportJsonBody = z
  .object({
    data: z
      .object({
        measurements: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened measurement rows, streamed page by page. Present for `type=measurements` and `type=all`.",
          ),
        medications: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened medications with their schedules. Present for `type=medications` and `type=all`.",
          ),
        intakeEvents: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened intake events (tombstoned rows excluded), newest scheduled slot first. Present for `type=intake` and `type=all`.",
          ),
        moodEntries: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened mood entries with the note decrypted. Present for `type=mood` and `type=all`.",
          ),
      })
      .describe(
        "Only the sections the `type` parameter selected are present; the others are absent keys, not empty arrays. Row shapes are the export formatters' flat column sets (the same columns the CSV variant emits as headers), not the API resource shapes — they are deliberately typed loosely here rather than restated, because the formatter is the single source and a restatement would drift.",
      ),
  })
  .meta({
    id: "ExportJsonBody",
    description:
      "The JSON download body. NOTE: this is NOT the standard `{ data, error }` envelope — the route builds the response itself so it can stream, and it carries `data` alone with no `error` key. Do not decode it with the shared envelope decoder.",
  });

const encryptedExportRequest = z
  .object({
    passphrase: z.string().min(12).max(1024).meta({
      description:
        "User-chosen passphrase (>= 12 chars). Derives the archive key via Argon2id; never stored, never logged, no server-side recovery.",
    }),
  })
  .meta({ id: "EncryptedExportRequest" });

// ── The restore-compatible full backup ───────────────────────────────
//
// The payload is described by the canonical `backupPayloadSchema` — the same
// object the admin restore parses the uploaded file with — rather than by a
// second declaration here. A restatement would be a second thing to keep in
// step with a 130-section wire format, and the previous prose beside the
// route is exactly what went wrong last time: it named six domains as
// export-only that the restore has re-created for releases.
//
// One correction the prose has to carry, because the shape does not: the
// builder has TWO modes and this route only ever produces one of them. The
// route calls the builder with no options, so `purpose` is undefined and the
// PORTABLE mode is what a user downloads. The disaster-recovery mode — row
// ids, tombstones, ciphertext verbatim, operator settings, the mental-health
// screeners and the consent receipts — is reached only by the weekly worker
// and the admin path. Describing this route as if it could produce either
// would be describing an option no caller has.
const fullBackupPayload = backupPayloadSchema.meta({
  id: "FullBackupPayload",
  description:
    "The canonical restore-compatible backup, in its PORTABLE form. Every section a user's own record holds rides it, and the `manifest` key declares what does not. Portable specifics: soft-deleted rows are dropped rather than carried as tombstones; encrypted columns arrive DECRYPTED as plain text, so the file is readable by whoever holds it and readable by an instance that does not hold this one's key; row ids are omitted for the sections that only carry them in a disaster-recovery file. Three things are omitted outright and say so in `manifest`: original uploaded document BYTES (metadata and any generated summary ride, the files do not — download them individually), workout GPS routes and per-sample heart-rate / pace series (summary records ride), and the sensitive pair — completed WHO-5 / PHQ / GAD administrations, whose encrypted per-item answers include the PHQ-9 self-harm item, and consent receipts, which are given to ONE operator and would assert elsewhere an agreement that operator never obtained. Both of the sensitive sections arrive as empty arrays with their `manifest` entry set to `omitted`, so their absence is stated rather than inferred. Beyond the declared omissions there is a real, undeclared gap: roughly thirty of the models the backup plan marks as backed up have neither a reader here nor a restore branch yet, and `src/lib/export/backup-plan.ts` is the enumeration of which. `schemaVersion` is `2` on everything written today; the parser still accepts `1`.",
});

export const exportPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/export": {
    get: {
      tags: ["Export"],
      summary: "Download measurements, medications, intake and mood",
      description:
        "The plaintext download. Returns `application/json` or `text/csv` (never the standard response envelope) with a `Content-Disposition: attachment` filename of `healthlog-export-<YYYY-MM-DD>.<ext>`. Measurements stream page by page, so a multi-year account does not buffer its whole history in memory; the other sections are assembled in full first. The CSV variant concatenates the selected sections under `# Measurements` / `# Medications` / `# Intake Events` / `# Mood Entries` headings, so it is a CONCATENATION of tables rather than one table — a single-table CSV parser will choke on it. Mood notes are decrypted into the download; measurement notes ride their exported column. Shares the `export:<userId>` bucket with the encrypted variant (10 per hour) and audits every attempt as `export.download`. Cookie or Bearer auth; the caller is always resolved as themselves, so this download cannot be delegated to a shared record. Not module-gated: a disabled module's rows are still exported, because this is the account's own data leaving on request.",
      requestParams: { query: exportQuery },
      responses: {
        "200": {
          description:
            "The export. `Content-Type` follows `format`; the body is `ExportJsonBody` for JSON and a multi-section CSV document for CSV.",
          content: {
            "application/json": { schema: exportJsonBody },
            "text/csv": { schema: z.string() },
          },
        },
        "422": {
          description:
            "`format` or `type` carried a value outside its enum. The message names the accepted set; nothing is exported. Note that this route validates by hand rather than through Zod, so the response is the single-message error envelope and NOT the multi-issue 422 the rest of the surface returns.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 10 exports in the trailing hour for this account (`export:<userId>`, shared with POST /api/export/encrypted).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/export/full-backup": {
    get: {
      tags: ["Export"],
      summary: "Download the restore-compatible full backup",
      description:
        "The disaster-recovery-shaped JSON dump, in its PORTABLE form. It matches the canonical backup payload byte for byte with the weekly worker's file, so a user can hand this to an operator and the admin restore accepts it without conversion. Two things the shape cannot state: this route ALWAYS produces the portable mode — it calls the builder with no options, so there is no parameter that reaches the disaster-recovery mode, which is the worker and admin path alone — and the file is NOT the standard response envelope but the raw payload, because the restore expects the payload and not `{ data: … }`. Encrypted columns arrive decrypted, so the file is as sensitive as the record it came from; the `manifest` key inside it declares what was deliberately left out. `Content-Disposition: attachment` with `healthlog-backup-<userId>-<YYYY-MM-DD>.json`, `Cache-Control: no-store`. Shares the `export:<userId>` bucket (10 per hour) with every other export route. Audits as `user.export.full-backup` with the row counts. Cookie or Bearer auth; the caller is always resolved as themselves, so this download cannot be delegated to a shared record.",
      responses: {
        "200": {
          description:
            "The backup payload. `application/json; charset=utf-8`, served as an attachment.",
          content: {
            "application/json": { schema: fullBackupPayload },
          },
        },
        "429": {
          description:
            "More than 10 exports in the trailing hour for this account (`export:<userId>`, shared across the export family).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/export/measurements": {
    get: {
      tags: ["Export"],
      summary: "Download measurements as CSV",
      description:
        "Streams the account's measurements as a single-table CSV, page by page, so a multi-year history never buffers whole. Soft-deleted rows are excluded, so an undone entry or a pending-sync tombstone never reaches the file. Sleep is night-aggregated by default; `granularity=raw` emits the per-stage rows instead. Glucose is written in the account's display unit rather than the canonical storage unit — which is the one way this file differs from the mixed `/api/export` download, whose measurement section pins mg/dL. `since` and `until` are FORGIVING: an unparseable date is dropped from the filter rather than refused, so a typo widens the export silently instead of erroring. Errors from authentication and the first page are returned normally; a failure after the first page arrives mid-stream, with a 200 already sent. `Content-Disposition: attachment` with `healthlog-measurements-<userId>-<YYYY-MM-DD>.csv`. Shares the `export:<userId>` bucket (10 per hour). Audits as `user.export.measurements`. Cookie or Bearer auth; not delegable.",
      requestParams: { query: exportMeasurementsQuery },
      responses: {
        "200": {
          description:
            "The CSV. `text/csv; charset=utf-8`, served as an attachment, `Cache-Control: no-store`.",
          content: { "text/csv": { schema: z.string() } },
        },
        "429": {
          description:
            "More than 10 exports in the trailing hour for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/export/medications": {
    get: {
      tags: ["Export"],
      summary: "Download medications (and their intake history) as CSV",
      description:
        "The medication list, plus the intake history unless it is switched off. The two ride one file as SEPARATE tables under `# Medications` and `# Intake history` headings, so a single-table CSV parser will choke on it. `medicationId` scopes both sections to one medication — the id is always narrowed by the account, so a foreign or unknown id resolves to no medication and answers 404 rather than an empty file. `since` / `until` bound the intake section only, on `scheduledFor`, and are FORGIVING: an unparseable date is dropped from the filter rather than refused. Tombstoned intake rows are excluded. Note the default: `intake` is on unless the caller sends exactly `false`, so any other value — including `0` or `no` — leaves the history in. `Content-Disposition: attachment` with `healthlog-medications-<userId>-<YYYY-MM-DD>.csv`. Shares the `export:<userId>` bucket (10 per hour). Audits as `user.export.medications`. Cookie or Bearer auth; not delegable.",
      requestParams: { query: exportMedicationsQuery },
      responses: {
        "200": {
          description:
            "The CSV. `text/csv; charset=utf-8`, served as an attachment, `Cache-Control: no-store`.",
          content: { "text/csv": { schema: z.string() } },
        },
        "404": {
          description:
            "`medicationId` named a medication this account does not hold. An unknown id and another account's id are indistinguishable.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 10 exports in the trailing hour for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/export/mood": {
    get: {
      tags: ["Export"],
      summary: "Download mood entries as CSV",
      description:
        "The account's mood entries as a single-table CSV, newest first, with the note DECRYPTED into the file — the whole point of a portable export, and the reason the file is as sensitive as the entries themselves. Tombstoned rows are excluded. `since` / `until` bound `moodLoggedAt` and are FORGIVING: an unparseable date is dropped from the filter rather than refused. Assembled in full before it is sent, unlike the measurement download. `Content-Disposition: attachment` with `healthlog-mood-<userId>-<YYYY-MM-DD>.csv`. Shares the `export:<userId>` bucket (10 per hour). Audits as `user.export.mood`. NOT module-gated — a switched-off mood module still exports its entries, because this is the account's own data leaving on request. Cookie or Bearer auth; not delegable.",
      requestParams: { query: exportRangeQuery },
      responses: {
        "200": {
          description:
            "The CSV. `text/csv; charset=utf-8`, served as an attachment, `Cache-Control: no-store`.",
          content: { "text/csv": { schema: z.string() } },
        },
        "429": {
          description:
            "More than 10 exports in the trailing hour for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/export/encrypted": {
    post: {
      tags: ["Export"],
      summary: "Download the full backup as a passphrase-encrypted archive",
      description:
        "v1.23. Same restore-compatible payload as the plaintext full backup, sealed into an `HLX1` archive (Argon2id-derived key + AES-256-GCM) under the supplied `passphrase`. Returns `application/octet-stream` (a `.hlx` file). When the account has a second factor enrolled, the call is step-up gated (`requireFreshMfa`, cookie-only) and returns 401 `auth.stepup.required` without a fresh factor; single-factor accounts use a normal session or Bearer. Shared `export:<userId>` rate bucket (10/h). The passphrase is never stored — a forgotten passphrase makes the archive unrecoverable.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: encryptedExportRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Encrypted archive. `application/octet-stream`; the body is the `HLX1` binary (magic | version | Argon2 params | salt | iv | tag | ciphertext).",
          content: {
            "application/octet-stream": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "403": {
          description:
            "The Bearer token carries a narrow scope. The encrypted archive needs a cookie session or a full-access token; the refusal happens before any second-factor proof is looked at.\n\n" +
            SHARING_NOT_PERMITTED_DESCRIPTION,
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
