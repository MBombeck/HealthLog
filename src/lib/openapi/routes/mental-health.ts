/**
 * OpenAPI route table for the opt-in mental-health screeners
 * (`/api/mental-health/assessments`). PHQ-9 / GAD-7 / WHO-5 / SCI.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request body
 * reuses the runtime Zod schema from `@/lib/validations/mental-health` so the
 * wire contract stays single-source. The list / create responses deliberately
 * exclude the raw item answers — only the server-authoritative total / band /
 * safety flag are exposed there; the per-administration detail read is the one
 * surface that returns the decrypted answers. The iOS client mirrors these
 * DTOs and MUST surface its own crisis-resource card on a positive item-9
 * flag (never rely on server text alone).
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  createAssessmentSchema,
  listAssessmentsSchema,
} from "@/lib/validations/mental-health";

import {
  dataEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so each annotated schema is bound to a const and the
// route table below references that const — a bare call would register nothing.
const createMentalHealthAssessmentRequest = createAssessmentSchema.meta({
  id: "CreateMentalHealthAssessmentRequest",
  description:
    "Record one completed screener administration: PHQ-9 (9 items, 0–3), GAD-7 (7 items, 0–3), WHO-5 (5 items, 0–5) or SCI (8 items, 0–4). The array length and per-item ceiling must match the instrument. The item answers are encrypted at rest and never returned. The server computes the total (WHO-5 reports raw-sum × 4 as 0–100) + severity band + item-9 safety flag. Opt-in, beside mood tracking — this is a screening surface, not a diagnosis.",
});

const listMentalHealthAssessmentsQuery = listAssessmentsSchema.meta({
  id: "ListMentalHealthAssessmentsQuery",
  description:
    "Filter the caller's screener history by instrument; paginate with limit/offset.",
});

const assessmentRow = z
  .object({
    id: z.string(),
    instrument: z.enum(["PHQ9", "GAD7", "WHO5", "SCI"]),
    locale: z.string(),
    version: z.string(),
    totalScore: z.number(),
    severityBand: z.string(),
    item9Flagged: z.boolean(),
    crisisShownAt: z.string().nullable(),
    takenAt: z.string(),
    createdAt: z.string(),
  })
  .meta({
    id: "MentalHealthAssessment",
    description:
      "One completed screener administration. `severityBand` is a descriptive label for the screen (never a diagnosis). `item9Flagged` is true when the PHQ-9 self-harm item was answered > 0 — the client MUST show crisis resources when it is. Raw per-item answers are intentionally absent from list rows; the by-id detail read returns them decrypted.",
  });

const assessmentDetail = assessmentRow
  .extend({
    items: z.array(z.number().int()).nullable(),
    functionalDifficulty: z.number().int().nullable(),
    itemsUnavailable: z.boolean(),
  })
  .meta({
    id: "MentalHealthAssessmentDetail",
    description:
      "One administration with its decrypted per-item answers, in the order the instrument presents its items (PHQ-9/GAD-7 answers 0–3, SCI 0–4, WHO-5 0–5). `functionalDifficulty` is the PHQ-9's unscored functional follow-up when it was answered. When the stored blob cannot be decrypted the read degrades honestly: `items` is null, `itemsUnavailable` is true, and the denormalised score fields still answer.",
  });

const crisisResource = z
  .object({
    id: z.string(),
    contacts: z.array(z.string()),
  })
  .meta({ id: "CrisisResource" });

const crisisSet = z
  .object({
    emergencyNumber: z.string(),
    resources: z.array(crisisResource),
  })
  .meta({
    id: "CrisisResourceSet",
    description:
      "Locale-aware crisis-resource signposting, present only when item-9 is flagged. Names resolve via i18n on the client; contacts are literal.",
  });

const createResponse = z
  .object({
    assessment: assessmentRow,
    actionThreshold: z.number(),
    crisis: crisisSet.nullable(),
  })
  .meta({ id: "CreateMentalHealthAssessmentResponse" });

const listResponse = z
  .object({ assessments: z.array(assessmentRow) })
  .meta({ id: "ListMentalHealthAssessmentsResponse" });

const detailResponse = z
  .object({ assessment: assessmentDetail })
  .meta({ id: "GetMentalHealthAssessmentResponse" });

export const mentalHealthPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/mental-health/assessments": {
    get: {
      tags: ["Mental health"],
      summary: "List the caller's screener history",
      description:
        "Returns PHQ-9 / GAD-7 / WHO-5 / SCI administrations (newest first). Totals + bands + flags only; raw item answers are never returned.",
      requestParams: { query: listMentalHealthAssessmentsQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Screener history.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                listResponse,
                "ListMentalHealthAssessmentsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Mental health"],
      summary: "Record a completed screener",
      description:
        "Stores one administration (item answers encrypted) and writes the derived total as a server-owned PHQ9_SCORE / GAD7_SCORE / WHO5_SCORE / SCI_SCORE measurement (source COMPUTED — never client-writable). WHO-5 and SCI totals run HIGHER = better; their follow-up thresholds point downwards (≤ 50 / ≤ 16). On a positive PHQ-9 item-9 the response carries the locale-aware crisis-resource set.\n\n" +
        "The projection row is the one write this operation makes outside its declared section: the operation is fenced on `mind`, and the measurement it derives lands in `measurements`. It is deliberate and unconditional — a screener whose own total is missing from the record would be an inconsistency inside the section the grant does open. The consent copy for the mood-and-mind section names it.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        content: {
          "application/json": { schema: createMentalHealthAssessmentRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Assessment recorded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                createResponse,
                "CreateMentalHealthAssessmentEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mental-health/assessments/{id}": {
    get: {
      tags: ["Mental health"],
      summary: "Read one administration with its decrypted answers",
      description:
        "Returns a single screener administration including the decrypted per-item answers (and the PHQ-9's unscored functional follow-up when answered) — the one surface that reads them back. When the stored blob cannot be decrypted the read degrades to `items: null` + `itemsUnavailable: true` instead of failing; the total / band / flag still answer. A soft-deleted or foreign row answers 404.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The administration with its answer breakdown.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                detailResponse,
                "GetMentalHealthAssessmentEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
