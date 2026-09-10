/**
 * OpenAPI route table for the immunization log (`/api/vaccinations`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request bodies
 * and queries reuse the runtime Zod schemas so the wire contract stays
 * single-source. Response shapes are declared here to mirror the
 * server-authoritative DTOs.
 *
 * The one contract worth reading twice is `series`. "Dose 3 of 3" is a
 * property of a person's whole history for an antigen, not of the row it is
 * printed beside, so it is derived once on the server and published as
 * resolved numbers. A client renders text from those numbers. It must never
 * recompute them, and it is not given the input it would need to try.
 *
 * Note what is NOT here: the reminder contract does not move. Logging a dose
 * satisfies the booster reminders it answers, and that happens through the
 * ordinary preventive-care engine — same endpoints, same shape, same
 * two-member `origin` enum. The match key that connects them is a server-side
 * column and reaches no response.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  vaccinationCreateSchema,
  vaccinationUpdateSchema,
  vaccinationListQuerySchema,
  vaccinationLinkSchema,
  vaccinationSiteEnum,
  vaccinationBoosterSchema,
  vaccinationSuggestQuerySchema,
} from "@/lib/validations/vaccinations";
import { measurementReminderDto } from "@/lib/validations/measurement-reminders";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so each annotated schema is bound to a const and the
// route table below references that const — a bare call would register nothing.
const createVaccinationRequest = vaccinationCreateSchema.meta({
  id: "CreateVaccinationRequest",
  description:
    "Log one administered dose. `occurredAt` is required and must not be in the future — a vaccination is recorded after the fact, and a planned booster is a reminder rather than a record. Exactly one identity arm is required: either `antigenSlug` (a slug the catalogue offers) or `vaccineName` (whatever the person's own record says, verbatim, which may be a trade name). Everything else is optional, so a decades-old paper entry with nothing but a date and a name is loggable. `note` is encrypted at rest. `documentIds` pre-links the scanned pages; an id naming nothing the caller owns is dropped rather than refused, so a link never blocks a save. Logging a dose satisfies any booster reminder keyed to one of its component antigens.",
});

const updateVaccinationRequest = vaccinationUpdateSchema.meta({
  id: "UpdateVaccinationRequest",
  description:
    "Partial edit of a dose; an omitted key leaves the column untouched, and a body naming nothing is a 422. `occurredAt` is editable because a transcription typo is the common case — and editing it deliberately does NOT re-run the booster satisfaction, so correcting a date can never move a reminder's due date. An edit that would leave the record with neither identity arm is refused. A present `documentIds` array replaces the links, empty array included.",
});

const listVaccinationsQuery = vaccinationListQuerySchema.meta({
  id: "ListVaccinationsQuery",
  description:
    "Filters for the immunization list: `antigenSlug`, `from` / `to` (ISO-8601 instants) and `limit` (1–500, default 300). The list is full and bounded rather than paged — a vaccination record is a lifetime document but a short one.",
});

const vaccinationBoosterRequest = vaccinationBoosterSchema.meta({
  id: "VaccinationBoosterRequest",
  description:
    "The confirm body for a booster reminder — the person's own values, accepted or edited from the catalogue's prefill. `intervalMonths` is bounded at 600 (a decade booster is 120); `label` is composed client-side so its locale is the person's own. There is no antigen field: the server reads the antigen from the dose's catalogue entry, never from the request, so a client cannot key a reminder onto an antigen the dose does not contain.",
});

const vaccinationSuggestQuery = vaccinationSuggestQuerySchema.meta({
  id: "VaccinationSuggestQuery",
  description:
    "The single input to the upload suggestion: the document's anchor date (ISO-8601 with offset). No ids — the candidate doses come from the caller's own record, narrowed from the session.",
});

const vaccinationLinkRequest = vaccinationLinkSchema.meta({
  id: "VaccinationLinkRequest",
  description:
    "Documents to file against, or unfile from, a dose. Idempotent in both directions and capped at 100 ids. Ids naming nothing the caller owns come back in `unknown` rather than failing the request.",
});

const catalogEntry = z
  .object({
    slug: z.string(),
    atc: z.string(),
    category: z.string(),
  })
  .meta({
    id: "VaccinationCatalogEntry",
    description:
      "What the catalogue this release ships knows about the record's `antigenSlug`: the slug itself, its WHO ATC code from the J07 subtree, and its picker grouping. Null when the slug does not resolve — a slug written by an older release, or one restored verbatim from an older backup. Null is the signal to render `vaccineName` instead; it is not an error and not missing data.",
  });

const seriesPosition = z
  .object({
    antigen: z.string(),
    position: z.number().int(),
    total: z.number().int().nullable(),
    booster: z.boolean(),
  })
  .meta({
    id: "VaccinationSeriesPosition",
    description:
      "Where this dose sits in ONE antigen's series, derived server-side over the whole history. `position` is the person's own recorded dose number when they gave one, otherwise the chronological index among their doses for that antigen. `total` is the record's own series length, then the catalogue's typical one, then null when neither knows — a seasonal vaccine has no 'of M'. `booster` is true once the series is complete and this dose comes after it. Render text from these values: both resolved reads as 'N of M', position alone as 'dose N', `booster` as a booster. Do not recompute them — a client cannot see the whole history and the two would drift.",
  });

const vaccinationDocument = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    date: z.string().nullable(),
    redacted: z.boolean(),
  })
  .meta({
    id: "VaccinationLinkedDocument",
    description:
      "One page filed against a dose, resolved. The label and the date are computed server-side from the document itself, so the client never re-derives them. Both go null together, with `redacted: true`, when the caller's grant does not cover the document vault: a dose lives in the health background but points into the vault, and a page's filename is itself the sensitive part. The link is still listed — the caller may know the dose was transcribed from a page — and `redacted` tells a withheld name apart from a page that simply has no date.",
  });

const vaccinationEncounter = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    kind: z.string(),
  })
  .meta({
    id: "VaccinationEncounterStub",
    description:
      "The visit the dose was given at, enough to recognise it by. Null when no visit is linked.",
  });

const practitioner = z
  .object({
    id: z.string(),
    name: z.string(),
    specialty: z.string().nullable(),
    practice: z.string().nullable(),
    location: z.string().nullable(),
    phone: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "VaccinationPractitioner",
    description:
      "The practice that administered the dose, resolved rather than an id. Null when the record names none.",
  });

const vaccination = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    antigenSlug: z.string().nullable(),
    vaccineName: z.string().nullable(),
    doseNumber: z.number().int().nullable(),
    seriesDoses: z.number().int().nullable(),
    lotNumber: z.string().nullable(),
    site: vaccinationSiteEnum.nullable(),
    catalogEntry: catalogEntry.nullable(),
    series: z.array(seriesPosition),
    practitioner: practitioner.nullable(),
    encounter: vaccinationEncounter.nullable(),
    reminderId: z.string().nullable(),
    note: z.string().nullable(),
    documents: z.array(vaccinationDocument).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "Vaccination",
    description:
      "One administered dose. `occurredAt` is a day at UTC midnight — the source record carries dates, never times. `series` carries one entry per component antigen, so a combined preparation reports several at once and each may be at a different position: a dose can be a booster for one antigen and a first dose for another in the same act. An empty `series` means the dose has no resolvable antigen (free text only, or a slug this release does not know) and nothing is guessed from the name. `note` is the decrypted free text, or null on a key-rotation gap — fail-soft, never a 500. `reminderId` names the booster reminder this dose settled, when one matched. `documents` is present on the detail response and absent from the list.",
  });

const vaccinationList = z.object({ vaccinations: z.array(vaccination) }).meta({
  id: "VaccinationList",
  description:
    "The caller's immunization history, newest dose first, with every entry's series already resolved over the whole live set — never over the filtered page, which would report the oldest dose in a window as the first ever given.",
});

const vaccinationSuggestion = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    antigenSlug: z.string().nullable(),
    vaccineName: z.string().nullable(),
  })
  .meta({
    id: "VaccinationSuggestion",
    description:
      "One candidate dose, resolved enough to render without a second round trip: `antigenSlug` when the dose carries a catalogue slug (name it from the catalogue), `vaccineName` when the person's own wording is all the dose has.",
  });

const vaccinationSuggestResult = z
  .union([
    z.object({
      kind: z.literal("one"),
      vaccination: vaccinationSuggestion,
    }),
    z.object({
      kind: z.literal("many"),
      vaccinations: z.array(vaccinationSuggestion),
    }),
    z.object({ kind: z.literal("none") }),
  ])
  .meta({
    id: "VaccinationSuggestResult",
    description:
      "The SHAPE of the answer, decided server-side: `one` pre-selects that dose, `many` offers a picker over `vaccinations` (bounded at 20 candidates), `none` offers nothing. A client renders the verdict and must not collapse `many` into a silent auto-pick — the rule lives on the server so every client agrees.",
  });

const vaccinationNotFound = {
  "404": {
    description: "Vaccination not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

const idPath = { path: z.object({ id: z.string() }) };

export const vaccinationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/vaccinations": {
    get: {
      tags: ["Records"],
      summary: "List vaccinations",
      description:
        "Returns the caller's live doses, newest first, each with its series resolved per component antigen. Soft-deleted doses are excluded.",
      requestParams: { query: listVaccinationsQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The caller's immunization history.",
          content: {
            "application/json": {
              schema: dataEnvelope(vaccinationList, "ListVaccinationsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Records"],
      summary: "Log a vaccination",
      description:
        "Records one administered dose and satisfies every live booster reminder keyed to one of its component antigens — so a single combined dose settles each of the antigens it contains. Satisfaction is forward-only: a dose older than a reminder's last satisfaction is a no-op, which is what makes back-entering an old paper record safe. Honours `Idempotency-Key`. Audits as `vaccination.record.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createVaccinationRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Dose logged.",
          content: {
            "application/json": {
              schema: dataEnvelope(vaccination, "CreateVaccinationEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/vaccinations/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read a single vaccination",
      description:
        "Returns the dose with its linked pages resolved. Owner-scoped; a cross-user or tombstoned id 404s.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The dose.",
          content: {
            "application/json": {
              schema: dataEnvelope(vaccination, "GetVaccinationEnvelope"),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit a vaccination",
      description:
        "Partial edit; omitted fields are left untouched. Never re-runs booster satisfaction. Audits as `vaccination.record.update`. Owner-scoped.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateVaccinationRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Dose updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(vaccination, "UpdateVaccinationEnvelope"),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Soft-delete a vaccination",
      description:
        "Stamps `deletedAt`. A booster reminder the dose once satisfied is deliberately not rewound: the reminder belongs to the preventive-care list and outlives the record, and tidying a transcription is not evidence the dose never happened. Idempotent. Audits as `vaccination.record.delete`.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteVaccinationEnvelope",
              ),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/vaccinations/{id}/restore": {
    post: {
      tags: ["Records"],
      summary: "Restore a soft-deleted vaccination",
      description:
        "Clears the tombstone. The link rows survived the soft delete, so the dose returns with its pages still filed against it. Restoring a live dose is a no-op that still succeeds.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Dose restored.",
          content: {
            "application/json": {
              schema: dataEnvelope(vaccination, "RestoreVaccinationEnvelope"),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/vaccinations/{id}/booster": {
    post: {
      tags: ["Records"],
      summary: "Plan a booster reminder from a dose",
      description:
        "Mints (or re-anchors) the booster reminder a logged dose suggests. The minted row is an ordinary `origin: VORSORGE` measurement reminder carrying the dose's primary antigen as a server-side match key; it lists on the preventive-care surface and rings through the same engine as every other checkup. Re-confirming re-anchors the existing reminder instead of minting a second one: 201 carries a fresh mint (`minted: true`), 200 a re-anchor. A free-text-only dose has no antigen to remind on and is refused with 422. Audits as `vaccination.booster.planned`.\n\n" +
        "The operation is declared under the health background and the row it mints belongs to the measurements section, so it crosses a section boundary: a delegate whose grant does not also open `measurements` is refused with 403 `vaccination.booster-out-of-scope` and nothing is written. The dose itself still logs — only the booster does not.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: vaccinationBoosterRequest } },
      },
      responses: {
        ...recordRefusal(
          "Refused: the caller's grant does not open this record's measurements, and the booster reminder lives there (`meta.errorCode` = `vaccination.booster-out-of-scope`). Nothing was written.",
        ),
        "200": {
          description: "Existing booster reminder re-anchored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  reminder: measurementReminderDto,
                  minted: z.boolean(),
                }),
                "ReanchorVaccinationBoosterEnvelope",
              ),
            },
          },
        },
        "201": {
          description: "Booster reminder minted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  reminder: measurementReminderDto,
                  minted: z.boolean(),
                }),
                "MintVaccinationBoosterEnvelope",
              ),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/vaccinations/suggest": {
    get: {
      tags: ["Records"],
      summary: "Suggest the dose a document belongs to",
      description:
        "Which dose does a document dated `anchor` most plausibly belong to? The document upload review asks this when a scan is classified `VACCINATION`. The window (±7 days, shared with the visit moment) and the one-pre-selects / many-offer-a-picker verdict are decided server-side so the browser never re-derives them. Owner-scoped; the anchor is the only input and it is a date, not an id.",
      requestParams: { query: vaccinationSuggestQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The suggestion verdict.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                vaccinationSuggestResult,
                "VaccinationSuggestEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/vaccinations/{id}/links": {
    post: {
      tags: ["Records"],
      summary: "File documents against a vaccination",
      description:
        "Adds links. Idempotent: a pair that already exists succeeds and changes nothing. Session-authenticated only, matching document and visit link and unlink.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: vaccinationLinkRequest } },
      },
      responses: {
        "200": {
          description: "The dose's linked pages after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  documents: z.array(vaccinationDocument),
                  unknown: z.array(z.string()),
                }),
                "LinkVaccinationEnvelope",
              ),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Unfile documents from a vaccination",
      description:
        "Removes links. Idempotent, and it still works for a page the account has since deleted — refusing would leave a filing nobody can clear.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: vaccinationLinkRequest } },
      },
      responses: {
        "200": {
          description: "The dose's linked pages after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  documents: z.array(vaccinationDocument),
                  unknown: z.array(z.string()),
                }),
                "UnlinkVaccinationEnvelope",
              ),
            },
          },
        },
        ...vaccinationNotFound,
        ...stdResponses,
      },
    },
  },
};
