/**
 * OpenAPI route table — nutrient intake sync (v1.28).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request
 * and response bodies come from `src/lib/validations/nutrients.ts` so
 * the wire contract stays single-source. The batch description embeds
 * the code ↔ HealthKit-identifier ↔ unit table generated from the
 * code-side catalog — the iOS client reads the pinned HK query unit
 * per type from here (this is the documented home of that table).
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { NUTRIENT_DEFINITIONS } from "@/lib/nutrients/catalog";
import {
  nutrientBatchSchema,
  nutrientBatchResponseSchema,
  energyBalanceQuerySchema,
  energyBalanceResponseSchema,
  nutrientDailyQuerySchema,
  nutrientDailySeriesSchema,
  nutrientOverviewQuerySchema,
  nutrientOverviewSchema,
  nutrientUpperLimitSchema,
  nutrientWaterWriteSchema,
  nutrientWaterWriteResponseSchema,
} from "@/lib/validations/nutrients";
import {
  nutrientTargetsPatchSchema,
  nutrientTargetsResponseSchema,
} from "@/lib/validations/nutrient-targets";
import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

const NUTRIENTS_DISABLED_DESCRIPTION =
  "The opt-in `nutrients` module is off for this account (errorCode `module.disabled`). Stop syncing and do not retry; offer the enable-in-settings hint. Only run the HealthKit read-authorization flow while the module is on.";

const moduleDisabled = {
  "403": {
    description: NUTRIENTS_DISABLED_DESCRIPTION,
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

/**
 * The catalog table, rendered into the endpoint description so the
 * OpenAPI file is the one authoritative home of the code ↔ HK ↔ unit
 * contract (µg is `ug` on the wire; water is mL; energy is kcal; never IU,
 * never kJ). Only the codes HealthKit carries; the batch also accepts
 * `alcohol`, which no HealthKit type does.
 */
const catalogTable = NUTRIENT_DEFINITIONS.filter((d) => d.hkIdentifier !== null)
  .map((d) => `| ${d.code} | ${d.hkIdentifier} | ${d.unit} |`)
  .join("\n");

const nutrientCatalogEntry = z
  .object({
    code: z.string(),
    unit: z.string().describe("The canonical unit amounts are stored in."),
    labelKey: z.string(),
    label: z.string().describe("The nutrient's name in the account language."),
    syncable: z
      .boolean()
      .describe(
        "Whether the nutrient batch accepts this code. `dha` and `epa` are not syncable: they appear in responses only.",
      ),
    ingredient: z
      .boolean()
      .describe(
        "Whether a supplement's composition may name this code. False for water, energy, the macronutrients and alcohol.",
      ),
    inputUnits: z
      .array(z.object({ unit: z.string(), factorToCanonical: z.number() }))
      .describe(
        "Units an amount may be entered in, with the factor to the canonical unit (vitamin D: `IU` = 0.025 µg).",
      ),
    upperLimit: nutrientUpperLimitSchema.nullable(),
  })
  .meta({
    id: "NutrientCatalogEntry",
    description:
      "One nutrient of the catalogue as the composition form uses it. Clients build the form from this and never convert units themselves.",
  });

export const nutrientPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/nutrients/catalog": {
    get: {
      tags: ["Nutrients"],
      summary: "The nutrient catalogue (v1.43)",
      description:
        "Every nutrient code with its canonical unit, label in the account language, input units and upper intake level. Behind the opt-in `nutrients` module (403 `module.disabled` when off).",
      responses: {
        ...recordRefusal(NUTRIENTS_DISABLED_DESCRIPTION),
        "200": {
          description: "The catalogue.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ entries: z.array(nutrientCatalogEntry) }),
                "NutrientCatalogEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nutrients/batch": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Nutrients"],
      summary: "Ingest nutrient day totals (v1.28)",
      description:
        "Bulk upsert of daily nutrient totals: vitamins, minerals, water, caffeine, energy (kcal), the macronutrients (g) and alcohol (g of ethanol). Two kinds of caller. The native client syncs from HealthKit with a cookie session or its login token, and its rows are stored as source APPLE_HEALTH. A bridge (a food tracker, a script) posts with a `measurements:write` token, and its rows are stored as source EXTERNAL; the body never chooses the source. A bridge may post any past day, and posts 0 to correct a day it got wrong. On the reads, the largest of the day-total sources (EXTERNAL, APPLE_HEALTH, HEALTH_CONNECT) counts for a day, so a tracker that also writes into Apple Health is not counted twice. Units are fixed per code (table below); energy is kcal, and a kJ value is skipped `unit_mismatch`, never converted.\n\nFor the native client: day totals only: compute HKStatisticsCollectionQuery cumulative sums day-anchored in the user's current IANA timezone; `day` is yyyy-MM-dd in that timezone (the same rule as the `stats:` day keys). Never post raw samples. Upsert key is (day, nutrient): a re-post replaces the stored total and reports `updated`. Post the current + previous local day per sync; backfill 30 days on first enable. Max 500 entries; Idempotency-Key supported; rate limit 60/min. Per-entry skips (`unit_mismatch` | `value_out_of_range` | `day_invalid`) are terminal — log and drop, do not retry the entry. `upsert_failed` is not one of them: it is a server-side write failure for the entry's whole write group, nothing was stored, and the entry should be sent again on a later sync; a response carrying it is `Cache-Control: no-store` and is not replayed for its `Idempotency-Key`. Behind the opt-in `nutrients` module (403 `module.disabled` when off). Query HealthKit with exactly the listed unit per code (`ug` = microgram; do not convert to IU). `alcohol` has no HealthKit type and is posted by bridges only, in g:\n\n| code | HealthKit identifier | unit |\n| --- | --- | --- |\n" +
        catalogTable,
      requestBody: {
        required: true,
        content: { "application/json": { schema: nutrientBatchSchema } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description:
            "Batch processed; per-entry statuses inserted | updated | skipped.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientBatchResponseSchema,
                "NutrientBatchEnvelope",
              ),
            },
          },
        },
        ...moduleDisabled,
        ...stdResponses,
      },
    },
  },
  "/api/nutrients": {
    get: {
      tags: ["Nutrients"],
      summary: "Synced-nutrient window summary (v1.28)",
      description:
        "Per-nutrient summary of the last `days` days (default 14): latest synced day + total and the days-with-data count, in catalog order. Read-only; feeds the settings card. Behind the opt-in `nutrients` module.",
      requestParams: { query: nutrientOverviewQuerySchema },
      responses: {
        "200": {
          description: "The window summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientOverviewSchema,
                "NutrientOverviewEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(NUTRIENTS_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/nutrients/daily": {
    get: {
      tags: ["Nutrients"],
      summary: "One nutrient's day-bucketed series (v1.29)",
      description:
        "Dense per-day series for one catalog code over the last `days` days (default 30) — one entry per calendar day, 0 for a day with no logged data, folded across sources (the largest of the day-total sources APPLE_HEALTH, HEALTH_CONNECT and EXTERNAL, plus MANUAL and SUPPLEMENT on top). Feeds the `/insights/nutrients` charts. Also returns the dietary reference resolved against the caller's profile sex — `null` when the profile has no sex on file (never guessed) or the nutrient has none — and the user's own target for the nutrient, if set. Behind the opt-in `nutrients` module.",
      requestParams: { query: nutrientDailyQuerySchema },
      responses: {
        "200": {
          description: "The day-bucketed series + resolved reference.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientDailySeriesSchema,
                "NutrientDailySeriesEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(NUTRIENTS_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/nutrients/energy-balance": {
    get: {
      tags: ["Nutrients"],
      summary: "The daily energy balance",
      description:
        "Intake against resting plus active energy over the last `days` local days (7 to 90, default 30), computed live: intake is the folded `energy` nutrient total, resting and active energy are the day sums of `BASAL_ENERGY_BURNED` and `ACTIVE_ENERGY_BURNED`. A day without a resting reading takes the Mifflin-St Jeor estimate from the weight carried forward, the height, the age and the profile sex (`restingEstimated`); without them, or without an active reading or an intake, the day has no balance rather than a guessed one. Today is `partial` and stays out of the seven-day trend and the window means. Descriptive figures, not a target. Behind the opt-in `nutrients` module.",
      requestParams: { query: energyBalanceQuerySchema },
      responses: {
        "200": {
          description: "The balance per day, the trend and the window means.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                energyBalanceResponseSchema,
                "EnergyBalanceEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(NUTRIENTS_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/nutrients/water": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Nutrients"],
      summary: "Manual water quick-add (v1.29)",
      description:
        'Writes ONLY the `source="MANUAL"` row for `(day, "water")` — never the `source="APPLE_HEALTH"` row the batch endpoint owns, so a manual entry and an Apple sync coexist instead of one clobbering the other. `mode: "add"` increments the manual day total (quick-add chips); `mode: "set"` overwrites it (the "edit today\'s total" undo path — there is no per-entry ledger). `day` defaults to the caller\'s current local day when omitted. Idempotency-Key supported; rate limit 60/min. Behind the opt-in `nutrients` module.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: nutrientWaterWriteSchema },
        },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "The MANUAL water row after the write.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientWaterWriteResponseSchema,
                "NutrientWaterWriteEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(NUTRIENTS_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/nutrients/targets": {
    get: {
      tags: ["Nutrients"],
      summary: "Daily nutrient targets",
      description:
        "The daily targets the person set for themselves, keyed by catalog code, each `{ value, direction }` in the code's canonical unit: `target` is an amount to reach, `limit` one to stay under. Only codes with a target appear; there is no default. Owner only. `GET /api/nutrients/daily` carries the one for its code as `personalTarget`. Behind the opt-in `nutrients` module.",
      responses: {
        "200": {
          description: "The targets.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientTargetsResponseSchema,
                "NutrientTargetsEnvelope",
              ),
            },
          },
        },
        ...moduleDisabled,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Nutrients"],
      summary: "Set daily nutrient targets",
      description:
        "Sets the targets the body names and keeps the rest; `null` clears one. An unknown code, or a value at or below 0 or above the code's plausibility cap, is refused with the multi-issue 422. Owner only: a shared or delegated session cannot change another person's targets. Behind the opt-in `nutrients` module.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: nutrientTargetsPatchSchema },
        },
      },
      responses: {
        "200": {
          description: "The targets after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nutrientTargetsResponseSchema,
                "NutrientTargetsPatchEnvelope",
              ),
            },
          },
        },
        ...moduleDisabled,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
};
