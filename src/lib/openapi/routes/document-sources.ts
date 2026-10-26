/**
 * OpenAPI route table for the document picker (`/api/documents/sources/*`,
 * #1038): a person's connection to Paperless-ngx or Papra, searching it, and
 * importing picked documents into the vault.
 *
 * Every operation is cookie-only (declared per operation as `cookieAuth`): a
 * Bearer, even a `["*"]` one, is refused 403 `documents.sources.browserOnly`,
 * and so is a request acting on another person's record. The native client does
 * not use these routes. Request bodies reuse the runtime Zod schemas.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  DOCUMENT_PICKER_LINK_KINDS,
  DOCUMENT_PICKER_MAX_PAGE,
  DOCUMENT_PICKER_QUERY_MAX,
  DOCUMENT_PICKER_SYSTEMS,
} from "@/lib/documents/sources/types";
import {
  documentSourceImportSchema,
  documentSourceSaveSchema,
} from "@/lib/validations/document-sources";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const cookieOnly = [{ cookieAuth: [] }];

const systemParameter = {
  name: "system",
  in: "path" as const,
  required: true,
  description: "`paperless` (Paperless-ngx) or `papra` (Papra).",
  schema: { type: "string" as const, enum: ["paperless", "papra"] },
};

const systemEnum = z.enum(DOCUMENT_PICKER_SYSTEMS);

const connectionSchema = z
  .object({
    system: systemEnum,
    baseUrl: z.string(),
    organizationId: z.string().nullable(),
    hasToken: z.literal(true),
    lastVerifiedAt: z.string().nullable(),
    originAllowed: z.boolean(),
  })
  .meta({ id: "DocumentSourceConnection" });

const statusSchema = z
  .object({
    available: z.boolean(),
    allowedOrigins: z.array(z.string()),
    connections: z.array(connectionSchema),
  })
  .meta({ id: "DocumentSourcesStatus" });

const tagSchema = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: "DocumentSourceTag" });

const resultSchema = z
  .object({
    sourceId: z.string(),
    title: z.string(),
    date: z.string().nullable(),
    tags: z.array(z.string()),
    sizeBytes: z.number().int().nullable(),
    state: z.enum(["new", "imported", "deleted"]),
    documentId: z
      .string()
      .nullable()
      .describe(
        "The vault document for `imported`. For `deleted`, the document while it is still in Recently deleted (restorable), null once it has been removed for good.",
      ),
  })
  .meta({ id: "DocumentSourceResult" });

const searchSchema = z
  .object({
    results: z.array(resultSchema),
    page: z.number().int(),
    hasMore: z.boolean(),
  })
  .meta({ id: "DocumentSourceSearch" });

const importResultSchema = z
  .object({
    outcome: z
      .enum(["imported", "duplicate", "deleted", "restored"])
      .describe(
        "`restored` only answers a request that sent `revive: true`: the deleted document was still in Recently deleted and is back in the vault.",
      ),
    documentId: z.string().nullable(),
    linked: z.boolean(),
  })
  .meta({ id: "DocumentSourceImport" });

const refusal = {
  description:
    "Refused before any request to the source: `documents.sources.browserOnly` for a Bearer caller, `sharing.not_permitted` while acting on another person's record (a delegate or guardian never uses the owner's archive), or `module.disabled` when the Documents module is off.",
  content: { "application/json": { schema: errorEnvelope } },
};

const unavailable = {
  description:
    "`documents.sources.unavailable`: the operator has not listed any origin in `DOCUMENT_SOURCE_ORIGINS`, so the picker is off. `documents.sources.notConnected`: no connection is saved for this system. `documents.sources.notFound`: the source has no such document, or (Papra) no such organization, including one the key's user is not a member of (Papra 403 `user.not_in_organization`) and one Papra cannot parse (400).",
  content: { "application/json": { schema: errorEnvelope } },
};

const upstream = {
  description:
    "The source could not answer usefully, with the reason in `meta.errorCode` and, when the source answered at all, its HTTP status in `meta.upstreamStatus` (its body is never passed on): `documents.sources.unreachable` (no connection, timeout, or a destination refused at dial time), `documents.sources.redirected` (the source answered with a redirect, which is never followed), `documents.sources.authRefused` (401/403 from the source), `documents.sources.permissionMissing` (Papra: the key cannot read tags; needs `tags:read`), `documents.sources.versionTooOld` (Paperless-ngx older than 2.16 / API version 9), `documents.sources.badResponse` (not the documented JSON, or larger than 1 MiB).",
  content: { "application/json": { schema: errorEnvelope } },
};

const originRefusal = {
  description:
    "`documents.sources.originNotAllowed`: the base address's origin is not on the operator's list (checked on every request, so a connection saved earlier is cut off once its origin is removed), or another validation failure.",
  content: { "application/json": { schema: errorEnvelope } },
};

export const documentSourcePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/documents/sources": {
    get: {
      tags: ["Documents"],
      summary: "Document archives: availability and connections",
      description:
        "Whether the operator enabled the document picker (`available`, true when `DOCUMENT_SOURCE_ORIGINS` lists at least one origin), the listed origins, and the caller's own saved connections to Paperless-ngx or Papra. A connection never carries its token: `hasToken` is always true for a saved one, and no route returns the token in whole or in part. `originAllowed` is false once the operator removed the connection's origin from the list. No request leaves the server. Needs neither the Documents module nor the list: with the list unset, `available` is false and any connection still stored is listed (with `originAllowed: false`) so it can be removed. Cookie session only; not delegable.",
      security: cookieOnly,
      responses: {
        "200": {
          description: "The picker's state for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                statusSchema,
                "DocumentSourcesStatusEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        ...stdResponses,
      },
    },
  },
  "/api/documents/sources/{system}": {
    put: {
      tags: ["Documents"],
      summary: "Save a connection to a document archive",
      description:
        "Saves or replaces the caller's connection to Paperless-ngx (`paperless`: base address and API token) or Papra (`papra`: base address, organization id, API key with `documents:read` and `tags:read`). The base address may carry a path; its origin must be listed in `DOCUMENT_SOURCE_ORIGINS`. The connection is tested live before anything is stored. Leaving out `token` keeps the stored one, but only when the new address is on the same origin as the saved one: the first save and a move to another origin must carry it (422 `documents.sources.tokenRequired`), so a stored token is never sent to an address it was not saved for. A Papra organization id is letters, digits, `_` and `-`. The token is stored encrypted (AES-256-GCM) and never returned. Ten saves and tests a minute per person. Cookie session only; not delegable.",
      security: cookieOnly,
      parameters: [systemParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: documentSourceSaveSchema } },
      },
      responses: {
        "200": {
          description: "Saved and verified. The connection, without its token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                connectionSchema,
                "DocumentSourceConnectionEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        "404": unavailable,
        "422": {
          description:
            "`documents.sources.originNotAllowed`, `documents.sources.invalidAddress`, `documents.sources.organizationRequired` (Papra), `documents.sources.tokenRequired` (first save without a token), or body validation.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "502": upstream,
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
    delete: {
      tags: ["Documents"],
      summary: "Remove a connection to a document archive",
      description:
        "Deletes the caller's connection for this system, and its token with it. Works even after the operator removed the origin from the list, and with the Documents module switched off. `disconnected` is false when there was nothing to delete. Cookie session only; not delegable.",
      security: cookieOnly,
      parameters: [systemParameter],
      responses: {
        "200": {
          description: "Removed, or there was nothing to remove.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({ disconnected: z.boolean() })
                  .meta({ id: "DocumentSourceDisconnect" }),
                "DocumentSourceDisconnectEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        ...stdResponses,
      },
    },
  },
  "/api/documents/sources/{system}/test": {
    post: {
      tags: ["Documents"],
      summary: "Test a saved connection",
      description:
        "One request to the source with the stored token. Answers `ok` with the round-trip time and stamps `lastVerifiedAt`, or the reason in `meta.errorCode`. Shares the save's allowance of ten a minute. Cookie session only; not delegable.",
      security: cookieOnly,
      parameters: [systemParameter],
      responses: {
        "200": {
          description: "The source answered.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    ok: z.literal(true),
                    latencyMs: z.number().int(),
                    lastVerifiedAt: z.string(),
                  })
                  .meta({ id: "DocumentSourceTest" }),
                "DocumentSourceTestEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        "404": unavailable,
        "422": originRefusal,
        "502": upstream,
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
  },
  "/api/documents/sources/{system}/tags": {
    get: {
      tags: ["Documents"],
      summary: "Tags of a connected archive",
      description:
        "The source's tags for the picker's filter, the first 250 by name, in the source's own ids. Shares the search allowance of sixty a minute. Cookie session only; not delegable.",
      security: cookieOnly,
      parameters: [systemParameter],
      responses: {
        "200": {
          description: "The tags.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({ tags: z.array(tagSchema) })
                  .meta({ id: "DocumentSourceTags" }),
                "DocumentSourceTagsEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        "404": unavailable,
        "422": originRefusal,
        "502": upstream,
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
  },
  "/api/documents/sources/{system}/search": {
    get: {
      tags: ["Documents"],
      summary: "Search a connected archive by name, tag and date",
      description:
        "Searches the source 25 documents at a time. `q` matches the document's name (Paperless-ngx title, Papra name); `tag` narrows to one of the source's tags by id; `from` / `to` to a date range, inclusive (Paperless-ngx filters on `created__gte` / `created__lte`; Papra's range is applied to each page after it arrives). When a filter applied after arrival empties a page, the route reads on, up to five source pages, and `page` in the answer is the last source page read; ask for `page + 1` next. Each result carries what the vault already holds under that source key: `new`, `imported` with the vault document's `documentId`, or `deleted` (deleted in HealthLog; importing it again stores nothing). Nothing is stored. Sixty searches a minute, shared with the tag read. Cookie session only; not delegable.",
      security: cookieOnly,
      parameters: [
        systemParameter,
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: DOCUMENT_PICKER_QUERY_MAX },
        },
        {
          name: "tag",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 64 },
        },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "to",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: DOCUMENT_PICKER_MAX_PAGE,
            default: 1,
          },
        },
      ],
      responses: {
        "200": {
          description: "One page of results.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                searchSchema,
                "DocumentSourceSearchEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        "404": unavailable,
        "422": originRefusal,
        "502": upstream,
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
  },
  "/api/documents/sources/{system}/import": {
    post: {
      tags: ["Documents"],
      summary: "Import one picked document",
      description:
        "`sourceId` must be an id the system issues (Paperless-ngx: digits; Papra: letters, digits, `_`, `-`), else 422 before anything is fetched. Fetches one document from the source and stores it in the vault through the same path as an upload, with `sourceSystem` / `sourceId` / `sourceInstance` (the connection's origin) provenance; the same id from another instance is another document. One import per key runs at a time; a concurrent second one waits and then answers `duplicate`. The key check counts toward the lookup allowance, the fetch toward the search allowance, and only a file that arrived toward the upload allowance. A source key the vault already holds is answered without a download: `duplicate` for a live document (same id), `deleted` for one the person deleted in HealthLog, which is not stored again unless the request sends `revive: true`: then a document still in Recently deleted is restored (`restored`), and one already removed for good is fetched and stored again, its key leaving the import ledger. A token upload (`POST /api/documents/inbound`) has no such switch, so an importer never brings a deleted document back. Bytes already in the vault under another key are `duplicate` too, and the key is remembered for that document. `link` files the document against the record the picker was opened from (a condition, a visit or a vaccination, which must be the caller's own and live; checked before anything is fetched), including a duplicate. `kind` sets the document type (default OTHER). Automatic AI reading follows the person's own setting. Counts against the person's upload allowance (60 an hour) and storage quota. 201 for a new document, 200 otherwise. Cookie session only; not delegable.",
      security: cookieOnly,
      parameters: [systemParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: documentSourceImportSchema },
        },
      },
      responses: {
        "201": {
          description: "Imported.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                importResultSchema,
                "DocumentSourceImportEnvelope",
              ),
            },
          },
        },
        "200": {
          description:
            "Already held (`duplicate`), deleted in HealthLog (`deleted`), or brought back from Recently deleted (`restored`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                importResultSchema,
                "DocumentSourceImportHeldEnvelope",
              ),
            },
          },
        },
        "403": refusal,
        "404": {
          description: `${unavailable.description} \`documents.sources.linkTargetNotFound\`: the record in \`link\` is not the caller's own live ${DOCUMENT_PICKER_LINK_KINDS.join(" / ")}.`,
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "`documents.inbound.sourceAliasLimit`: these bytes are already stored under too many source ids.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description:
            "`documents.inbound.fileTooLarge` (with `maxFileBytes`) or `documents.inbound.quotaExceeded` (with `quotaBytes` and `usedBytes`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "`documents.inbound.fileType`: the file is not a type the vault accepts.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": originRefusal,
        "502": upstream,
        "401": stdResponses["401"],
        "429": {
          description:
            "`documents.inbound.rateLimited` (the person's hourly upload allowance, with the rate-limit headers) or `documents.inbound.uploadBusy` (too many uploads in progress; `Retry-After: 1`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
