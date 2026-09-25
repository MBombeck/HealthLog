/**
 * Zod schemas — nutrient intake sync (v1.28).
 *
 * Shared between the runtime request parsing
 * (`src/app/api/nutrients/**`) and the OpenAPI route table
 * (`src/lib/openapi/routes/nutrients.ts`) so the wire contract stays
 * single-source. The closed `nutrient` code set comes from the
 * code-side catalog (`src/lib/nutrients/catalog.ts`).
 */
import { z } from "zod/v4";

import { NUTRIENT_CATALOG, NUTRIENT_CODES } from "@/lib/nutrients/catalog";

export const MAX_NUTRIENT_ENTRIES_PER_BATCH = 500;

export const nutrientCodeEnum = z.enum(NUTRIENT_CODES).meta({
  id: "NutrientCode",
  description:
    "Closed nutrient catalog code — 24 HealthKit Dietary vitamin/mineral types plus water and caffeine. Energy, macros and sodium/potassium are out of scope.",
});

/**
 * One day-total entry. `day` is YYYY-MM-DD in the user's IANA timezone,
 * computed client-side (the `stats:` day-key contract); the server
 * trusts the string after regex + calendar sanity, no re-derivation.
 * `unit` deliberately rides the wire even though the catalog pins it:
 * a µg/mg confusion is a silent 1000× corruption and the one-string
 * echo is the cheapest guard — a mismatch skips the entry.
 */
export const nutrientEntrySchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    nutrient: nutrientCodeEnum,
    unit: z.string().min(1).max(10),
    amount: z.number().finite().min(0),
    externalSourceVersion: z.string().min(1).max(120).optional(),
  })
  .meta({
    id: "NutrientIntakeEntry",
    description:
      "One nutrient day total. day = YYYY-MM-DD in the user's IANA timezone; unit must equal the catalog's canonical unit for the code (mg | ug | ml) or the entry is skipped unit_mismatch.",
  });

export const nutrientBatchSchema = z
  .object({
    entries: z
      .array(nutrientEntrySchema)
      .min(1)
      .max(MAX_NUTRIENT_ENTRIES_PER_BATCH),
  })
  .meta({
    id: "NutrientBatchRequest",
    description:
      "Bulk day-total upsert, max 500 entries. Upsert key is the composite primary key (userId, day, nutrient, source); this route always writes the APPLE_HEALTH source row, so a manual water entry is never clobbered. A re-post replaces the stored total (last-writer-wins day-total contract).",
  });

/** Per-entry outcome — a re-post is by definition an update, never a duplicate. */
export const nutrientEntryResultSchema = z
  .object({
    index: z.number().int().min(0),
    status: z.enum(["inserted", "updated", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({
    id: "NutrientEntryResult",
    description:
      "Per-entry ingest outcome. skipped reasons: unit_mismatch | value_out_of_range | day_invalid | upsert_failed. The first three are verdicts on the entry itself and terminal: resending it unchanged is skipped again, so log and drop it. `upsert_failed` is a write failure on the server's side, not a verdict on the entry: nothing was stored for it, and it should be sent again on a later sync. A write failure takes out the whole group it was written in (every new day total, or every existing one), so several entries can carry it at once. A response carrying it is marked `Cache-Control: no-store` and is not kept for `Idempotency-Key` replay, so the retry writes again rather than replaying the failure.",
  });

export const nutrientBatchResponseSchema = z
  .object({
    processed: z.number().int().min(0),
    inserted: z.number().int().min(0),
    updated: z.number().int().min(0),
    skipped: z.array(
      z.object({ index: z.number().int().min(0), reason: z.string() }),
    ),
    entries: z.array(nutrientEntryResultSchema),
  })
  .meta({
    id: "NutrientBatchResponse",
    description:
      "Always 200 when the envelope parses; per-entry failures surface as skipped entries, never a batch failure.",
  });

/** `GET /api/nutrients` query — window size in days, default 14. */
export const nutrientOverviewQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(14),
});

export const nutrientOverviewSchema = z
  .object({
    windowDays: z.number().int().min(1),
    nutrients: z.array(
      z.object({
        nutrient: nutrientCodeEnum,
        unit: z.string(),
        latestDay: z.string(),
        latestAmount: z.number(),
        daysWithData: z.number().int().min(1),
      }),
    ),
    lastAttempt: z
      .object({
        at: z.iso.datetime({ offset: true }),
        topReason: z.string(),
      })
      .nullable()
      .meta({
        description:
          "Non-null only when `nutrients` is empty AND the most recent nutrient-batch call landed nothing — the most common skip reason from that call, so the client can say a sync arrived and why instead of a bare empty state.",
      }),
  })
  .meta({
    id: "NutrientIntakeOverview",
    description:
      "Per-nutrient window summary in catalog order: latest synced day + total, and the count of days carrying data inside the window. Nutrients without data in the window are omitted.",
  });

/**
 * `POST /api/nutrients/water` body (v1.29) — manual water quick-add.
 *
 * Water only in slice 1 (manual vitamin entry is out of scope — see
 * the design memo). `amountMl` is bounded to the catalog's own
 * per-day plausibility cap for water; `mode: "add"` increments the
 * MANUAL row for `day`, `mode: "set"` overwrites it (the "edit
 * today's total" undo path). `day` defaults server-side to the
 * caller's current local day when omitted.
 */
export const nutrientWaterWriteSchema = z
  .object({
    amountMl: z
      .number()
      .finite()
      .min(1)
      .max(NUTRIENT_CATALOG.water.plausibleDailyMax),
    mode: z.enum(["add", "set"]),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .meta({
    id: "NutrientWaterWriteRequest",
    description:
      "Manual water quick-add against the MANUAL source row. add increments today's manual total; set overwrites it. Never touches the APPLE_HEALTH row.",
  });

export const nutrientWaterWriteResponseSchema = z
  .object({
    day: z.string(),
    nutrient: z.literal("water"),
    source: z.literal("MANUAL"),
    amount: z.number(),
    unit: z.string(),
  })
  .meta({
    id: "NutrientWaterWriteResponse",
    description: "The MANUAL water row after the add/set write.",
  });

/** `GET /api/nutrients/daily` query — one nutrient's day-bucketed series. */
export const nutrientDailyQuerySchema = z.object({
  nutrient: nutrientCodeEnum,
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const resolvedNutrientReferenceSchema = z.object({
  kind: z.enum(["PRI", "AI", "safeLevel"]),
  direction: z.enum(["target", "upperGuidance"]),
  value: z.number(),
  source: z.string(),
});

export const nutrientDailySeriesSchema = z
  .object({
    nutrient: nutrientCodeEnum,
    unit: z.string(),
    windowDays: z.number().int().min(1),
    days: z.array(z.object({ day: z.string(), amount: z.number() })),
    reference: resolvedNutrientReferenceSchema.nullable(),
  })
  .meta({
    id: "NutrientDailySeries",
    description:
      "Dense day-bucketed series (one entry per day in the window, 0 for a day with no data) summed across sources, plus the EFSA reference resolved against the caller's profile sex (null when sex is unknown on the profile).",
  });
