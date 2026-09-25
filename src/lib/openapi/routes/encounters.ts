/**
 * OpenAPI route table for visits (`/api/encounters`) and the address book
 * behind them (`/api/practitioners`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request bodies
 * and queries reuse the runtime Zod schemas so the wire contract stays
 * single-source. Response shapes are declared here to mirror the
 * server-authoritative DTOs: the practitioner arrives resolved rather than as
 * an id, the links arrive with a label and a date, and the appointment's next
 * due instant arrives computed. A client renders these, it never rebuilds them.
 *
 * Note what is NOT here: the reminder `origin` enum is unchanged. A booked
 * visit mints a reminder with a third origin value internally, and that value
 * reaches no response, because every preventive-care read excludes it. The
 * published contract stays at two members deliberately.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  encounterCreateSchema,
  encounterUpdateSchema,
  encounterListQuerySchema,
  encounterSuggestQuerySchema,
  encounterLinkSchema,
  encounterStatusEnum,
  encounterKindEnum,
  lateralityEnum,
  procedureListQuerySchema,
} from "@/lib/validations/encounters";
import {
  practitionerCreateSchema,
  practitionerUpdateSchema,
  practitionerListQuerySchema,
} from "@/lib/validations/practitioners";
import { bodySiteQuerySchema } from "@/lib/validations/body-sites";
import {
  illnessLifecycleEnum,
  illnessTypeEnum,
} from "@/lib/validations/illness";

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
const createEncounterRequest = encounterCreateSchema.meta({
  id: "CreateEncounterRequest",
  description:
    "File a visit, or book one. `occurredAt` is the only required field — a visit saves with a date and nothing else. A future instant with `status: PLANNED` books an appointment and mints exactly one reminder for it. `reason`, `outcome` and `bodySite` are encrypted at rest. `kind: PROCEDURE` marks a procedure or surgery; `bodySite` (free text) and `laterality` (LEFT / RIGHT / BOTH, null when not stated) say where, and are accepted on any kind. The three id arrays pre-link documents, lab results and condition episodes; an id naming nothing the caller owns is dropped rather than refused, so a link never blocks a save.",
});

const updateEncounterRequest = encounterUpdateSchema.meta({
  id: "UpdateEncounterRequest",
  description:
    "Partial edit of a visit; an omitted key leaves the column untouched, and a body naming nothing is a 422. Moving `occurredAt` re-anchors the appointment reminder the visit already owns and never mints a second. Moving `status` to DONE closes the checkup named by `reminderId`, on the transition only. CANCELLED and NO_SHOW stop the reminder without deleting the row. A present id array replaces that link family, empty array included. Switching an existing visit to `kind: PROCEDURE` is an ordinary edit of this kind; nothing has to be entered again.",
});

const listEncountersQuery = encounterListQuerySchema.meta({
  id: "ListEncountersQuery",
  description:
    "Window and filters for the visit list: `from` / `to` (ISO-8601 instants), `status`, `practitionerId`, `episodeId` (only visits filed against that condition episode — the condition side of the link, and the only direction it is offered in), and `limit` (1–200, default 100).",
});

const suggestEncounterQuery = encounterSuggestQuerySchema.meta({
  id: "SuggestEncounterQuery",
  description:
    "The date to resolve around, as an ISO-8601 instant with an offset. A document uses `reportDate ?? documentDate`; a lab panel uses `takenAt`.",
});

const encounterLinkRequest = encounterLinkSchema.meta({
  id: "EncounterLinkRequest",
  description:
    "Targets to file against, or unfile from, a visit. Idempotent in both directions and capped at 100 ids. Ids naming nothing the caller owns come back in `unknown` rather than failing the request.",
});

const listProceduresQuery = procedureListQuerySchema.meta({
  id: "ListProceduresQuery",
  description:
    "Filters for the procedure history. `q` must match every word, case- and accent-insensitively, somewhere in the body site, the side (English or the record owner's language) or the reason. `laterality` filters the side exactly. Both run server-side after the decrypt, because the body site is encrypted at rest.",
});

const createPractitionerRequest = practitionerCreateSchema.meta({
  id: "CreatePractitionerRequest",
  description:
    "Add a doctor or practice to the caller's own address book. `name` is the only required field and is stored as queryable plaintext so the picker can search and sort it; `note` is encrypted at rest. `specialty` is free text rather than an enum. Nothing is unique across accounts.",
});

const updatePractitionerRequest = practitionerUpdateSchema.meta({
  id: "UpdatePractitionerRequest",
  description:
    "Partial edit; an omitted key leaves the column untouched, an explicit null clears it, and a body naming nothing is a 422.",
});

const listPractitionersQuery = practitionerListQuerySchema.meta({
  id: "ListPractitionersQuery",
  description:
    "Query params for the address book: `q` (case-insensitive substring of the name OR the practice — a person looks one up by whichever of the two they remember) and `limit` (1–200, default 100). Name-ordered.",
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
    id: "Practitioner",
    description:
      "One entry in the caller's address book. `note` is the decrypted free text, or null on a key-rotation gap — fail-soft, never a 500.",
  });

const linkedTarget = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    date: z.string().nullable(),
    redacted: z.boolean(),
  })
  .meta({
    id: "EncounterLinkedTarget",
    description:
      "One thing filed against a visit, resolved. The label and date are computed server-side from the target itself — a document's title and filing date, a lab result's panel and analyte and draw date, a condition's label and onset — so the client never re-derives them and the two cannot drift. Both go null together, with `redacted: true`, when the caller's grant does not cover the target's own domain: a visit lives in the health background but points at the vault, the labs and the illness journal, and a grant that opened only the first was never consent for the names in the other three. The link itself is still listed — the caller may know the visit produced a lab result — and `redacted` is what tells a withheld name apart from a target that simply has no date.",
  });

const encounterLinks = z
  .object({
    documents: z.array(linkedTarget),
    labResults: z.array(linkedTarget),
    conditions: z.array(linkedTarget),
  })
  .meta({
    id: "EncounterLinks",
    description:
      "The three link families of one visit, each ordered by when it was filed. Present on BOTH the list and the detail: a card shows counts of what the visit produced, and an edit opened from a list row seeds its pickers from that row — a list without them would make the first read zero and the second unfile everything on save. The list resolves them in three grouped queries for the whole page, not three per row.",
  });

const skipReport = z
  .object({
    catalogueKeys: z.array(
      z.object({
        catalogue: z.string(),
        key: z.string(),
        links: z.number(),
      }),
    ),
    links: z.number(),
  })
  .meta({
    id: "EncounterSkipReport",
    description:
      "What the write could not do, named. `links: 0` with an empty list is the ordinary answer. Anything else is a side effect the caller's grant did not reach — today only `checkupClosure`, the closing of a preventive-care checkup, which is a measurements-domain write a health-background delegate cannot perform. The visit still saves; the checkup stays due and the response says so, because somebody who believes a checkup was closed will not look at it again.",
  });

const encounter = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    status: encounterStatusEnum,
    kind: encounterKindEnum,
    practitioner: practitioner.nullable(),
    reason: z.string().nullable(),
    outcome: z.string().nullable(),
    bodySite: z.string().nullable(),
    laterality: lateralityEnum.nullable(),
    reminderNextDueAt: z.string().nullable(),
    links: encounterLinks.optional(),
    skipped: skipReport.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "Encounter",
    description:
      "One contact with the healthcare system: a visit that happened, or one that is booked. `practitioner` is resolved rather than an id. `reason`, `outcome` and `bodySite` are the decrypted free text (null on a key-rotation gap). `kind: PROCEDURE` marks a procedure or surgery, and `bodySite` with `laterality` say where; both are carried on every kind so switching a visit's kind away and back loses nothing. `reminderNextDueAt` is the server-computed instant a booked appointment next nudges, and is null for a visit that already happened or whose one-shot reminder is spent.",
  });

const encounterList = z
  .object({
    upcoming: z.array(encounter),
    past: z.array(encounter),
  })
  .meta({
    id: "EncounterList",
    description:
      "Visits split server-side rather than client-side. `upcoming` reads soonest-first and `past` reads newest-first — opposite directions, resolved once here so the ordering lives in one place.",
  });

const bodySiteFacet = z
  .object({
    bodySite: z.string(),
    laterality: lateralityEnum.nullable(),
    count: z.number().int(),
  })
  .meta({
    id: "BodySiteFacet",
    description:
      "One body site and side in the procedure history, with how many procedures carry it. Keyed case- and space-insensitively; `bodySite` is the first spelling seen.",
  });

const procedureList = z
  .object({
    procedures: z.array(encounter),
    bodySites: z.array(bodySiteFacet),
    total: z.number().int(),
  })
  .meta({
    id: "ProcedureList",
    description:
      "The procedure history. `procedures` is the filtered list, newest first. `bodySites` and `total` are computed over the whole history before the filter, so the filter choices never shrink to the one just picked.",
  });

const bodySitesQuery = bodySiteQuerySchema.meta({
  id: "BodySitesQuery",
  description:
    "Without `site`: only the list of sites. With `site`: also what is filed there. `site` is compared to the whole stored site, case- and accent-insensitively, after the decrypt; it names a site from the list rather than searching words. `laterality` narrows to one side and needs `site`; LEFT and RIGHT include records on BOTH sides, and a record whose side was never stated is left out once a side is picked.",
});

const bodySiteSide = z
  .object({
    laterality: lateralityEnum.nullable(),
    count: z.number().int(),
  })
  .meta({
    id: "BodySiteSide",
    description:
      "How many records sit on one side of a site. `laterality: null` counts the records whose side was not stated.",
  });

const bodySite = z
  .object({
    bodySite: z.string(),
    procedures: z.number().int(),
    conditions: z.number().int(),
    sides: z.array(bodySiteSide),
  })
  .meta({
    id: "BodySite",
    description:
      "One body site the record holds, across visits (procedures, mostly) and conditions. Keyed case-, accent- and space-insensitively; `bodySite` is the first spelling met, newest record first. `conditions` is 0 when the caller may not read conditions.",
  });

const bodySiteCondition = z
  .object({
    id: z.string(),
    label: z.string(),
    type: illnessTypeEnum,
    lifecycle: illnessLifecycleEnum,
    onsetAt: z.string(),
    resolvedAt: z.string().nullable(),
    bodySite: z.string().nullable(),
    laterality: lateralityEnum.nullable(),
    links: z.object({
      documents: z.array(linkedTarget),
      visits: z.array(linkedTarget),
    }),
  })
  .meta({
    id: "BodySiteCondition",
    description:
      "A condition at the picked site, with the documents filed against it and the visits it was linked to. No note: that is read on the condition itself. A document link comes back with `redacted: true` and no label or date when the caller's grant does not cover documents.",
  });

const bodySiteList = z
  .object({
    sites: z.array(bodySite),
    selection: z
      .object({
        bodySite: z.string(),
        laterality: lateralityEnum.nullable(),
        visits: z.array(encounter),
        conditions: z.array(bodySiteCondition).nullable(),
      })
      .optional(),
  })
  .meta({
    id: "BodySiteList",
    description:
      "The record's body sites, most records first, and with `site` the visits and conditions filed there, each newest first with its links. `selection.conditions` is null (not empty) when the caller may not read conditions in this record or the record has the illness module off. Links into a section the caller's grant does not cover carry `redacted: true` and no label.",
  });

const suggestionCandidate = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    status: encounterStatusEnum,
    kind: encounterKindEnum,
    practitionerName: z.string().nullable(),
  })
  .meta({
    id: "EncounterSuggestionCandidate",
    description:
      "One visit a record might belong to, resolved far enough to render a row without a second round trip. `practitionerName` is null when the visit names no practice, which is an absence rather than a gap.",
  });

const encounterSuggestion = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("one"), encounter: suggestionCandidate }),
    z.object({
      kind: z.literal("many"),
      encounters: z.array(suggestionCandidate),
    }),
    z.object({ kind: z.literal("none") }),
  ])
  .meta({
    id: "EncounterSuggestion",
    description:
      "The verdict, as a shape rather than a best guess. There is deliberately no field on the `many` arm a client could read as a pre-selection: collapsing two candidates into one is the failure this union exists to make impossible.",
  });

const encounterNotFound = {
  "404": {
    description: "Visit not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

const practitionerNotFound = {
  "404": {
    description: "Practitioner not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

const idPath = { path: z.object({ id: z.string() }) };

export const encounterPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/encounters": {
    get: {
      tags: ["Records"],
      summary: "List visits",
      description:
        "Returns the caller's live visits, split into `upcoming` and `past`. Bounded and windowed; soft-deleted visits are excluded.",
      requestParams: { query: listEncountersQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The caller's visits.",
          content: {
            "application/json": {
              schema: dataEnvelope(encounterList, "ListEncountersEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Records"],
      summary: "File or book a visit",
      description:
        "Creates one visit. A future instant with `status: PLANNED` books an appointment and mints its reminder; a past instant with `status: DONE` and a `reminderId` closes that checkup. Claiming both is a 422 — a visit that has not happened cannot have closed anything. Honours `Idempotency-Key`. Audits as `encounter.visit.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createEncounterRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Visit filed.",
          content: {
            "application/json": {
              schema: dataEnvelope(encounter, "CreateEncounterEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/encounters/procedures": {
    get: {
      tags: ["Records"],
      summary: "List procedures and surgeries",
      description:
        "The caller's procedure and surgery history: every live visit of kind PROCEDURE with status DONE, newest first, bounded at 500. Planned, cancelled and missed procedures are not in it; a booked one stays in the visit list's `upcoming` half. Read at the same section and level as the visit list.",
      requestParams: { query: listProceduresQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The procedure history.",
          content: {
            "application/json": {
              schema: dataEnvelope(procedureList, "ListProceduresEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/body-sites": {
    get: {
      tags: ["Records"],
      summary: "List body sites, or what is filed at one",
      description:
        "The body sites the record holds, across visits and conditions, and with `site` the visits and conditions filed at that site with their linked documents, lab results and visits. The same list serves as suggestions for a body-site field, so a site is written the same way twice. Body sites are encrypted at rest, so grouping and matching run server-side after the decrypt, over at most 500 rows per kind. Read at the same section and level as the visit list; conditions join only when the caller may read the illness section and the record has the illness module on.",
      requestParams: { query: bodySitesQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The body sites, and the selection when one was named.",
          content: {
            "application/json": {
              schema: dataEnvelope(bodySiteList, "ListBodySitesEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/encounters/suggest": {
    get: {
      tags: ["Records"],
      summary: "Which visit does a record dated around this day belong to?",
      description:
        "Resolves the caller's live DONE or PLANNED visits within ±7 days of `anchor` into a verdict, so the three capture moments that ask the question — a document arriving, a lab panel committed from an extraction, a lab panel typed by hand — all read the same answer. `one` means pre-select it visibly with one undo; `many` means offer a picker with NOTHING pre-selected, because pre-selecting the first of two teaches a person to stop reading suggestions; `none` means offer nothing at all. Cancelled visits and no-shows are never candidates: neither happened, so neither produced the record being filed. No AI provider is involved and none is required.",
      requestParams: { query: suggestEncounterQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The verdict.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                encounterSuggestion,
                "SuggestEncounterEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/encounters/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read a single visit",
      description:
        "Returns the visit with its three link families resolved. Owner-scoped; a cross-user or tombstoned id 404s.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The visit.",
          content: {
            "application/json": {
              schema: dataEnvelope(encounter, "GetEncounterEnvelope"),
            },
          },
        },
        ...encounterNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit a visit",
      description:
        "Partial edit; omitted fields are left untouched. Audits as `encounter.visit.update`. Owner-scoped.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateEncounterRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Visit updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(encounter, "UpdateEncounterEnvelope"),
            },
          },
        },
        ...encounterNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Soft-delete a visit",
      description:
        "Stamps `deletedAt` and retires the visit's own appointment reminder with it — never a checkup the visit closed, which belongs to the preventive-care list and outlives it. Idempotent. Audits as `encounter.visit.delete`.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteEncounterEnvelope",
              ),
            },
          },
        },
        ...encounterNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/encounters/{id}/restore": {
    post: {
      tags: ["Records"],
      summary: "Restore a soft-deleted visit",
      description:
        "Clears the tombstone. The link rows survived the soft delete, so the visit returns with its documents, labs and conditions still filed against it. Its appointment reminder returns only if the appointment is still in the future. Restoring a live visit is a no-op that still succeeds.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Visit restored.",
          content: {
            "application/json": {
              schema: dataEnvelope(encounter, "RestoreEncounterEnvelope"),
            },
          },
        },
        ...encounterNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/encounters/{id}/links": {
    post: {
      tags: ["Records"],
      summary: "File targets against a visit",
      description:
        "Adds links. Idempotent: a pair that already exists succeeds and changes nothing. Session-authenticated only, matching document link and unlink.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: encounterLinkRequest } },
      },
      responses: {
        "200": {
          description: "The visit's links after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  links: encounterLinks,
                  unknown: z.array(z.string()),
                }),
                "LinkEncounterEnvelope",
              ),
            },
          },
        },
        ...encounterNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Unfile targets from a visit",
      description:
        "Removes links. Idempotent, and it still works for a target the account has since deleted — refusing would leave a filing nobody can clear.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: encounterLinkRequest } },
      },
      responses: {
        "200": {
          description: "The visit's links after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  links: encounterLinks,
                  unknown: z.array(z.string()),
                }),
                "UnlinkEncounterEnvelope",
              ),
            },
          },
        },
        ...encounterNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/practitioners": {
    get: {
      tags: ["Records"],
      summary: "List practitioners",
      description:
        "Returns the caller's address book, name-ordered, with an optional case-insensitive name search.",
      requestParams: { query: listPractitionersQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The caller's address book.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(practitioner),
                "ListPractitionersEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Records"],
      summary: "Add a practitioner",
      description:
        "Creates one address-book entry. Honours `Idempotency-Key`. Audits as `practitioner.contact.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createPractitionerRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Practitioner added.",
          content: {
            "application/json": {
              schema: dataEnvelope(practitioner, "CreatePractitionerEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/practitioners/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read a single practitioner",
      description:
        "Returns the entry including its decrypted `note`. Owner-scoped; a cross-user or tombstoned id 404s.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The practitioner.",
          content: {
            "application/json": {
              schema: dataEnvelope(practitioner, "GetPractitionerEnvelope"),
            },
          },
        },
        ...practitionerNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit a practitioner",
      description:
        "Partial edit; omitted fields are left untouched. Audits as `practitioner.contact.update`. Owner-scoped.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updatePractitionerRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Practitioner updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(practitioner, "UpdatePractitionerEnvelope"),
            },
          },
        },
        ...practitionerNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Soft-delete a practitioner",
      description:
        "Stamps `deletedAt`. Every visit that named this entry survives with no practice attached, because the reference nulls rather than cascades. Idempotent. Audits as `practitioner.contact.delete`.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeletePractitionerEnvelope",
              ),
            },
          },
        },
        ...practitionerNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/practitioners/{id}/restore": {
    post: {
      tags: ["Records"],
      summary: "Restore a soft-deleted practitioner",
      description:
        "Clears the tombstone. It does NOT re-attach the visits whose reference was nulled on delete — which visits meant this practice is not recoverable, and guessing would be worse than the gap. Restoring a live entry is a no-op that still succeeds.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Practitioner restored.",
          content: {
            "application/json": {
              schema: dataEnvelope(practitioner, "RestorePractitionerEnvelope"),
            },
          },
        },
        ...practitionerNotFound,
        ...stdResponses,
      },
    },
  },
};
