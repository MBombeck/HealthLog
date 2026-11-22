/**
 * OpenAPI route table — why background AI work stopped (v1.49, #1404).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The same entry
 * shape rides the document detail as `aiFailures`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { AI_JOB_FAILURE_CODES, AI_JOB_KINDS } from "@/lib/ai/job-failure/types";

import { dataEnvelope, stdResponses } from "./shared";

export const aiJobFailure = z
  .object({
    job: z
      .enum(AI_JOB_KINDS as [string, ...string[]])
      .describe(
        "The kind of background AI work: `documentSummary`, `documentIndex` (making a document searchable), `documentRead` (reading a document's values or filing suggestions), `labScan`, `supplementLabel`, `statusText` (the notes on the cards), `briefing`, `periodNarrative`, `workoutInsight`, `reactionLine`, `coachNudge`, `coachMemory`. Treat an unknown value as other background work.",
      ),
    code: z
      .enum(AI_JOB_FAILURE_CODES)
      .describe(
        "Why it stopped. `no_provider`: no provider is set up that could do this work. `chain_no_provider`: the work is bound to a named chain and none of its entries is set up. `consent_required`: the provider needs a consent receipt and none is active. `not_permitted`: the work may not run on this record. `check_failed`: the server could not check whether it may run. `credential_expired`: the provider refused the key. `rate_limited`: the provider said too many requests. `provider_timeout`: no answer in time. `provider_unreachable`: the provider could not be reached. `provider_empty`: it answered with nothing. `provider_reasoning_only`: the model reasoned and never answered. `provider_paused`: the provider failed so often that background work waits before trying again. `provider_error`: another provider failure. `budget_exhausted`: today's AI allowance is used up. `unreadable_file`: the file could not be prepared for the provider. Treat an unknown value as `provider_error`.",
      ),
    documentId: z
      .string()
      .nullable()
      .describe("The document the work was for, or null."),
    providerType: z
      .string()
      .nullable()
      .describe(
        "The provider entry that failed (a chain provider type such as `local` or `anthropic`), when one was called.",
      ),
    failCount: z
      .number()
      .int()
      .min(1)
      .describe("Failures in a row since the last success."),
    firstFailedAt: z.string().describe("ISO 8601."),
    lastFailedAt: z.string().describe("ISO 8601."),
  })
  .meta({
    id: "AiJobFailure",
    description:
      "Why the latest background AI work of one kind stopped (v1.49). Recorded by the server from closed codes only; no provider message or payload is stored. A later success removes it; it is no longer served thirty days after its last failure.",
  });

const aiJobFailuresList = z
  .object({ failures: z.array(aiJobFailure) })
  .meta({ id: "AiJobFailuresList" });

export const aiJobFailurePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/ai/job-failures": {
    get: {
      tags: ["Profile"],
      summary: "Why background AI work stopped (v1.49)",
      description:
        "Own account only: a cookie session or a full-scope token. One entry per kind of background AI work (and per document for document work) whose latest run failed, newest first, at most 50. A document's entries are listed only while the document is in the record. Refusals that are somebody's decision (an operator switch, a module or the AI analysis turned off, the usage level) are never listed; a missing provider or consent only when the person started the work or bound the capability to a named chain.",
      responses: {
        "200": {
          description: "The recorded failures.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                aiJobFailuresList,
                "GetAiJobFailuresResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
