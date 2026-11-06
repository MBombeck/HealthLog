/**
 * OpenAPI route table for the user-scoped Biomarker catalog (`/api/biomarkers`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies reuse the runtime Zod schemas from `@/lib/validations/biomarkers`
 * so the wire contract stays single-source. The response shape is declared
 * here (the route serialises a derived `hasContext` flag the input schema
 * doesn't carry, and returns the decrypted `context`).
 *
 * The iOS client consumes the biomarker DTO + the `biomarkerId` field on
 * `LabResult` to render the resolved unit + reference range without
 * recomputing — server-authoritative parity for Labs.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { LAB_UNIT_DESCRIPTION } from "@/lib/labs/dimensionless";
import {
  dateKeySchema,
  labSeriesQuerySchema,
  timelineLabSeries,
} from "@/lib/day/wire-schemas";
import { TIMELINE_ZOOMS } from "@/lib/day/contract";

import {
  createBiomarkerSchema,
  updateBiomarkerSchema,
} from "@/lib/validations/biomarkers";
import {
  BIOMARKER_MERGE_CONVERSIONS,
  BIOMARKER_MERGE_REFUSALS,
  biomarkerMergeSchema,
} from "@/lib/validations/biomarker-merge";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

// `.meta()` CLONES in Zod 4 rather than annotating in place, so the returned
// schema has to be captured and referenced. A bare `schema.meta({...})`
// statement registers nothing and the component id it names never reaches the
// emitted document.
const createBiomarkerRequest = createBiomarkerSchema.meta({
  id: "CreateBiomarkerRequest",
  description:
    "Define a user-scoped biomarker ONCE: canonical `name`, `unit`, optional reference bounds (`lowerBound` / `upperBound`; when both present `lowerBound` must not exceed `upperBound`), an optional encrypted `context` note, and an optional `panel` grouping. The name is unique per user (no second 'LDL'). Recording a value later just picks this marker — its unit + range are never re-entered.",
});

const updateBiomarkerRequest = updateBiomarkerSchema.meta({
  id: "UpdateBiomarkerRequest",
  description:
    "Partial edit of a biomarker. An omitted key leaves the column untouched; an explicit `null` on `context` / `panel` / a bound clears it. Set `hidden` to drop / restore the marker in the active list + lab-entry pickers. A rename that collides with another of the caller's markers is rejected 409.",
});

const biomarkerRow = z
  .object({
    id: z.string(),
    name: z.string(),
    unit: z.string().describe(LAB_UNIT_DESCRIPTION),
    lowerBound: z.number().nullable(),
    upperBound: z.number().nullable(),
    panel: z.string().nullable(),
    analyteKey: z.string().nullable(),
    hasContext: z.boolean(),
    context: z.string().nullable(),
    hidden: z.boolean(),
    aliases: z
      .array(z.string())
      .optional()
      .describe(
        "v1.43 — other spellings that resolve to this marker (folded in by a merge, chosen at an import, or typed on the marker), sorted, without the marker's own name. Absent on older servers.",
      ),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "Biomarker",
    description:
      "A user-scoped catalog marker. `context` is the decrypted per-marker note (or null); `hasContext` flags its presence. `analyteKey` is the analyte the marker was recognised as: the catalog slug its name belongs to (e.g. `fasting-glucose`, `ldl`, `hdl`), or a key of the unit-conversion registry for an analyte with no catalog seed (e.g. `urea`, `uric-acid`), or null when its name matches none. It is derived from `name` and `unit`, never chosen: it is set on create and re-derived (or cleared) when an update changes either. A reading in another unit is converted only for a marker that has one. `hidden` drops the marker from the active catalog list and the lab-entry pickers without deleting it (its readings and unit/range survive). A `LabResult` linking this marker resolves its unit + reference bounds from here.",
  });

const labTrend = z
  .union([
    z.object({
      status: z.literal("ok"),
      n: z.number().int(),
      firstAt: z.string().describe("YYYY-MM-DD of the first reading."),
      lastAt: z.string().describe("YYYY-MM-DD of the newest reading."),
      spanDays: z.number().int(),
      slopePerYear: z
        .number()
        .describe("Least-squares change per year, in the marker's unit."),
      slopeCi95: z
        .tuple([z.number(), z.number()])
        .describe("95 % interval of the slope (Student t at n − 2 df)."),
      pValue: z.number(),
      fittedNow: z.number().describe("The line's value on `asOf`."),
      asOf: z
        .string()
        .describe(
          "YYYY-MM-DD the line was evaluated on: today, or `lastAt` when `projection` is `stale`.",
        ),
      horizonYears: z
        .number()
        .describe(
          "How far ahead a bound may be met and still count as `exits`: three years, or the readings' span when shorter.",
        ),
      horizonCapped: z
        .boolean()
        .describe(
          "True when `horizonYears` is the three-year cap, false when the readings' shorter span set it.",
        ),
      projection: z.enum([
        "exits",
        "beyond_horizon",
        "no_exit",
        "already_outside",
        "no_clear_trend",
        "no_band",
        "stale",
      ]),
      exitDate: z
        .string()
        .nullable()
        .describe(
          "Only for `exits`: the day the straight line meets `exitBound`. A projection, never a forecast.",
        ),
      exitBound: z.enum(["low", "high"]).nullable(),
    }),
    z.object({
      status: z.literal("insufficient"),
      reason: z.enum(["too_few_values", "span_too_short"]),
      n: z.number().int(),
      spanDays: z.number().int(),
    }),
  ])
  .meta({
    id: "BiomarkerTrend",
    description:
      "v1.44 — the least-squares line through every numeric reading of the marker (all stored in the marker's unit). Needs at least three readings spanning at least 365 days, else `insufficient`. `projection` places the line against the marker's band: `exits` (with `exitDate`) only when the slope's 95 % interval excludes zero, the line is inside the band today and reaches a bound within `horizonYears` (three years, or the readings' span when shorter). `stale` when the newest reading is more than 365 days old: the line is then reported as of `lastAt`, with no projection. Server-computed; clients render it as given.",
  });

const biomarkerDetail = biomarkerRow
  .extend({
    trend: labTrend.optional().describe("v1.44 — absent on older servers."),
  })
  .meta({ id: "BiomarkerDetail" });

export const biomarkerListResponse = z
  .object({
    biomarkers: z.array(biomarkerRow),
    customPanels: z
      .array(z.string())
      .describe(
        "The caller's panels that are no catalog panel in any language, one spelling per folded form (the most frequent, ties to the alphabetically first), sorted. Suggestions for the panel field; catalog panels are not repeated here.",
      ),
  })
  .meta({ id: "ListBiomarkersResponse" });

const conflict = {
  "409": {
    description: "A biomarker with this name already exists for the caller.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const updateConflict = {
  "409": {
    description:
      "`labs.biomarker.duplicate`: a rename collides with another of the caller's markers. `labs.biomarker.alias.taken` (v1.43): one of `aliases` is already the name or an alias of another marker; `meta.alias` names the spelling and `meta.biomarkerId` the marker that answers to it.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const notFound = {
  "404": {
    description:
      "Biomarker not found (or owned by another user). `meta.errorCode` = `labs.biomarker.notFound`. Since v1.43 a marker that was merged into another answers with `meta.mergedInto` naming the marker it went into: drop the cached marker and open that one.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const biomarkerSeries = z
  .object({
    zoom: z.enum(TIMELINE_ZOOMS),
    range: z.object({
      from: dateKeySchema,
      to: dateKeySchema,
      dataFrom: dateKeySchema
        .nullable()
        .describe(
          "The local day of the marker's first numeric reading; null when it has none. `all` starts here.",
        ),
    }),
    series: timelineLabSeries,
  })
  .meta({ id: "BiomarkerSeries" });

const biomarkerMergeRequest = biomarkerMergeSchema.meta({
  id: "BiomarkerMergeRequest",
  description:
    "Fold `sourceIds` (1..10, unique, without the target) into the marker in the path. `dryRun` (default false) answers the same result and writes nothing; a client shows it before asking to confirm, because a merge cannot be undone.",
});

const biomarkerMergeResult = z
  .object({
    dryRun: z.boolean(),
    target: biomarkerRow.describe(
      "The marker after the merge (unchanged on a dry run).",
    ),
    sources: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        unit: z.string(),
        readingCount: z.number().int(),
        conversion: z.enum(BIOMARKER_MERGE_CONVERSIONS),
        refusal: z.enum(BIOMARKER_MERGE_REFUSALS).nullable(),
      }),
    ),
    movedReadings: z.number().int(),
    convertedReadings: z.number().int(),
    aliasesAdded: z
      .array(z.string())
      .describe("Names that become aliases of the target."),
    mergeId: z.string().nullable().describe("`null` on a dry run."),
  })
  .meta({
    id: "BiomarkerMergeResult",
    description:
      "What a merge did, or would do on a dry run. Readings in another unit are converted where the analyte's conversion table knows it; the printed value stays in `sourceValue` / `sourceUnit` on each reading.",
  });

export const biomarkerPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/biomarkers": {
    get: {
      tags: ["Labs"],
      summary: "List the caller's biomarker catalog",
      description:
        "Returns every biomarker the caller has defined, name-ordered. Each carries its unit, reference bounds, and decrypted context.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Biomarker catalog.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                biomarkerListResponse,
                "ListBiomarkersEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Labs"],
      summary: "Define a biomarker",
      description:
        "Creates a user-scoped biomarker. The optional context note is AES-256-GCM encrypted before write. Audits as `biomarker.create`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createBiomarkerRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Created biomarker.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerRow, "CreateBiomarkerResponse"),
            },
          },
        },
        ...conflict,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/biomarkers/{id}": {
    get: {
      tags: ["Labs"],
      summary: "Fetch a single biomarker",
      description:
        "Returns the biomarker including its decrypted `context`, since v1.43 its `aliases`, and since v1.44 its `trend` over every stored reading. Cross-user rows surface as 404. A marker merged into another answers 404 with `meta.mergedInto`.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Biomarker detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerDetail, "GetBiomarkerResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    put: {
      tags: ["Labs"],
      summary: "Edit a biomarker",
      description:
        "Partial edit; omitted fields are untouched, an explicit null clears `context` / `panel` / a bound. Since v1.43 `aliases` (0..50, each 1..120 characters) replaces the marker's set of other spellings: listed spellings stay or are added, unlisted ones are removed; omitting the field leaves them as they are. Audits as `biomarker.update`. Since v1.40.0 a `unit` different from the stored one is refused with 422 `biomarkers.unit.locked` while any reading is linked to the marker (`meta.readingCount` carries how many): readers label every linked reading with the marker's unit, so a change would relabel stored numbers without converting them. Sending the current unit, or changing it on a marker with no readings, is accepted.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateBiomarkerRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Updated biomarker.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerRow, "UpdateBiomarkerResponse"),
            },
          },
        },
        ...updateConflict,
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Labs"],
      summary: "Delete a biomarker",
      description:
        "Hard-deletes the catalog definition together with every reading filed under it, in one transaction. Since v1.43 it needs the same record authority as the edit (manage on the labs section), so a manager of a shared record may delete and the owner is unaffected. Audits as `biomarker.delete` with the marker's name, unit and the number of readings removed.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteBiomarkerResponse",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
  "/api/biomarkers/{id}/series": {
    get: {
      tags: ["Labs"],
      summary: "One marker's lab line",
      description:
        "The line `labSeries` on `GET /api/timeline` draws for this marker, cut by the same `zoom`, `from` and `to` rules: every numeric reading in the window, oldest first, one point each (never averaged), readings in a unit that does not convert counted in `excluded`, and the band to draw behind them. `all` starts at the marker's first reading. Gated on the `labs` module, not on `timeline`. A point names the report it was read from only when the caller may see documents. Cross-user ids answer 404; a merged marker answers 404 with `meta.mergedInto`.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: labSeriesQuerySchema,
      },
      responses: {
        ...recordRefusal(
          "`module.disabled` with `meta.module = labs`: the record has the labs module switched off, or the operator turned it off server-wide.",
        ),
        "200": {
          description: "The marker's line over the window.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerSeries, "BiomarkerSeriesEnvelope"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
        "422": {
          description:
            "`labs.series.invalid`: an unknown `zoom`, a malformed date, a `range` without both ends or longer than 15 years, or `from` after `to`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/biomarkers/{id}/merge": {
    post: {
      tags: ["Labs"],
      summary: "Merge markers into this one (v1.43)",
      description:
        "Moves every reading of the source markers onto the marker in the path, converting units where the analyte's conversion table knows them, turns the source names into aliases and deletes the sources, in one transaction. A source in a unit without a known conversion refuses the whole merge with 422 `labs.biomarker.merge.unitMismatch` (`meta.sources` names each `{ id, unit, targetUnit, reason }`) and nothing moves. 404 `labs.biomarker.notFound` with `meta.ids` when the target or a source is missing; 422 `labs.biomarker.merge.invalid` for a malformed body or a target among the sources. No undo. Only when `features.biomarkerMerge` is true.",
      parameters: [idempotencyKeyParameter],
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: biomarkerMergeRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "200": {
          description:
            'The merge result, or the dry-run preview. A preview reports a source that cannot be converted with `conversion: "refused"` and its `refusal`; the same request without `dryRun` answers 422 `labs.biomarker.merge.unitMismatch`.',
          content: {
            "application/json": {
              schema: dataEnvelope(
                biomarkerMergeResult,
                "MergeBiomarkersResponse",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
        "422": {
          description:
            "`labs.biomarker.merge.invalid`: a malformed body, or the target among the sources (Zod issues in `details.issues[]`). `labs.biomarker.merge.unitMismatch`: a source holds readings in a unit the registry cannot convert to the target's; `meta.sources` lists each `{ id, unit, targetUnit, reason }` with `reason` one of `unknown_analyte`, `unknown_unit`, `not_finite`. Nothing was moved.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...recordWriteRateLimitResponse,
      },
    },
  },
};
