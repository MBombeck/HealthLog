/**
 * OpenAPI route module — the unified daily digest (P3).
 *
 * GET /api/daily/digest returns the `DailyDigest` DTO the Today surface, the
 * daily push, and a future iOS widget all consume. It is a pure read of
 * already-cached data (nightly briefing lift + dashboard-snapshot ingredients
 * + two light deterministic reads) — no provider call, no warm-on-mount. No
 * module or AI gate; its AI parts follow their capabilities. Part of the
 * OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { ARRIVAL_KINDS } from "@/lib/arrivals/types";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { dismissPriorityItemSchema } from "@/lib/validations/daily";
import { dataEnvelope, recordRefusal, stdResponses } from "./shared";
import { healthScoreBasis } from "./insights/schemas";
import { aiCapabilityState } from "./profile";

const priorityItemSchema = z
  .object({
    kind: z.enum([...PRIORITY_ITEM_KINDS]).describe("Closed rail-item kind."),
    itemKey: z
      .string()
      .optional()
      .describe(
        "Stable dismiss identity, namespaced `<kind>:...`. Present only on the observational kinds (milestone / ecg_new_recording / tension_window) — absent on the actionable kinds, which are never dismissible.",
      ),
    title: z.string().describe("Localised headline (resolved server-side)."),
    body: z
      .string()
      .optional()
      .describe("Grounded one-liner, rendered as plain text."),
    status: z
      .enum(["success", "warning", "info", "destructive"])
      .optional()
      .describe("Semantic status wash — meaning, not decoration."),
    actions: z
      .array(
        z.object({
          labelKey: z.string().describe("i18n key, resolved client-side."),
          intent: z.string().describe("Stable action token."),
          href: z.string().optional().describe("Deep-link when navigational."),
        }),
      )
      .max(3)
      .describe("1–3 one-tap actions."),
    moduleKey: z
      .string()
      .optional()
      .describe("Provenance of the gate that admitted the item."),
  })
  .meta({
    id: "DailyPriorityItem",
    description:
      "One 'worth a look' rail item. The single model every daily-value consumer renders through PriorityCard.",
  });

const dailyDigestResponse = z
  .object({
    generatedAt: z.string().describe("ISO-8601 instant the digest was read."),
    phase: z
      .enum(["provisional", "final"])
      .describe("Freshness lifecycle — 'final' once last night's sleep is in."),
    sleepPending: z
      .boolean()
      .describe("Sleep tracked but last night not yet recorded."),
    score: z
      .object({
        value: z.number(),
        band: z.string(),
        delta: z.number().nullable(),
        configured: z
          .boolean()
          .optional()
          .describe(
            "True when the account's own recipe narrows the score's composition below what its defaults would resolve to today. Resolved on the server and carried straight from the dashboard snapshot; the configuration itself never rides this wire. Optional so older cached digests without the field stay valid.",
          ),
        // The score's identity fields have ridden this wire since the
        // digest first carried a score, but the object is
        // `additionalProperties: false` and never declared them — a
        // generated strict decoder would have rejected the real payload.
        // Declared here rather than left standing beside a new field
        // that documents itself correctly.
        deltaReason: z
          .string()
          .nullable()
          .optional()
          .describe("Why a delta was suppressed; null when it was not."),
        scoreVersion: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Algorithm version that produced the value."),
        composition: z
          .array(z.string())
          .optional()
          .describe("Registry-ordered pillar ids the value was composed of."),
        scoreBasis: healthScoreBasis
          .optional()
          .describe(
            "What the value rests on. Since v1.38 a score is produced from one or two areas of health as well as three, so this is what distinguishes a narrow score from a broad one. Optional so older cached digests without the field stay valid.",
          ),
      })
      .nullable()
      .describe(
        "Health score + band + week-over-week delta, plus whether the account authored the composition and how broad the set behind it is; null when none.",
      ),
    topSignal: z
      .object({
        sourceMetric: z.string(),
        tone: z.enum(["good", "watch", "info"]),
        headline: z.string(),
        nudge: z.string(),
        delta: z.string().nullable(),
      })
      .nullable()
      .describe(
        "Clinical-priority top signal, lifted from the cached briefing. Null while the `briefing` capability is unavailable.",
      ),
    briefingLead: z
      .string()
      .nullable()
      .describe(
        "First sentence of the cached briefing paragraph. Null while the `briefing` capability is unavailable; `line` then falls to its deterministic floor.",
      ),
    line: z
      .string()
      .describe(
        "Push / lock-screen line: cached-AI lead with a deterministic floor.",
      ),
    worthALook: z
      .array(priorityItemSchema)
      .describe("Bounded 0–3 rail items, never padded."),
    justIn: z
      .object({
        kind: z
          .enum([...ARRIVAL_KINDS])
          .describe("Closed arrival kind that landed."),
        at: z
          .string()
          .describe(
            "ISO-8601 instant of the newest sample. NEVER pre-formatted server-side — the client formats it in its own locale and timezone.",
          ),
      })
      .nullable()
      .describe(
        "The day's newest data arrival while it is still news (under three hours old), else null. Additive since v1.31.0.",
      ),
    reactionLine: z
      .string()
      .nullable()
      .describe(
        "One-sentence generated reaction to that arrival, standing for the rest of the local day. Null whenever no line was generated (no provider, no consent, budget exhausted, or generation failed), and whenever the `reactionLines` capability is unavailable, however recent the stored line — consumers fall back to `briefingLead` / `line`. Additive since v1.31.0.",
      ),
    ai: z
      .object({
        briefing: aiCapabilityState,
        coach: aiCapabilityState,
        reactionLines: aiCapabilityState,
      })
      .describe(
        "The three AI capabilities the digest carries text or a card for: `briefing` (the lead and top signal), `coach` (the Coach check-in card, which opens the Coach) and `reactionLines` (the reaction line). Everything else in the digest is data.",
      ),
  })
  .meta({
    id: "DailyDigest",
    description:
      "The one data spine of the daily-value system — composed from already-cached data, never a fresh AI call. Consumed by the Today surface, the daily push, and a future iOS widget.",
  });

export const dailyPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/daily/digest": {
    get: {
      tags: ["Insights"],
      summary: "The unified daily digest",
      description:
        "Assembles the day's read from already-cached data: the nightly briefing lifted read-only from the insights cache, the dashboard-snapshot health score / meds-today / sleep freshness, plus deterministic integration-status, Vorsorge and visit reads for the 'worth a look' rail. The rail's `preventive_care` item covers every check-up due today or overdue and names up to three of them; `upcoming_visit` items cover every planned visit on the local today (also once it has started, until the day ends) in one item, and the next day with a visit inside the next 48 hours in a second. A due check-up and today's visits always keep a place within the three-item cap. No provider call, no warm-on-mount. No module gate and no AI gate: the digest is data, and the `insights` module is the AI analysis opt-out. Its AI parts follow their capabilities, published in `ai`. Cookie or Bearer auth.",
      responses: {
        "200": {
          description: "The daily digest.",
          content: {
            "application/json": {
              schema: dataEnvelope(dailyDigestResponse, "DailyDigestEnvelope"),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/daily/digest/dismiss": {
    post: {
      tags: ["Insights"],
      summary: "Dismiss a Today rail item",
      description:
        '"Dismiss / mark seen" for the Today rail\'s OBSERVATIONAL PriorityItem kinds only — milestone, ecg_new_recording, tension_window. The ACTIONABLE kinds (dose_window, sync_issue, preventive_care, coach_checkin) are structurally unreachable: itemKey must be namespaced under one of the three dismissible kinds or the request 422s before any lookup runs. Persisted server-side so the dismissal survives reload / a second device; an upsert, so a repeat dismiss of the same instance is a no-op. No module gate. Cookie or Bearer auth.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: dismissPriorityItemSchema },
        },
      },
      responses: {
        "200": {
          description: "The item is dismissed (idempotent).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ dismissed: z.literal(true) }),
                "DismissPriorityItemEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
