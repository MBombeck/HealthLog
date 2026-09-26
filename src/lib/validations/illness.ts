/**
 * Illness / condition-journal request/response validation (v1.18.1).
 *
 * Source of truth for the `/api/illness/*` wire contract. The Zod schemas
 * here are reused by the OpenAPI registry so the spec stays single-source.
 * `userId` is NEVER a body field — it is narrowed from the session/Bearer
 * in every route and fed to the Prisma `where`.
 *
 * The journal is a CONDITION journal (any illness/condition kept for
 * oneself), retrospective-only — NEVER a predictor/diagnoser. Day-log
 * dates are `YYYY-MM-DD` strings (the CycleDayLog / MoodEntry tz-anchored
 * convention); instants are ISO-8601 with offset. Free-text notes are
 * encrypted at rest (`noteEncrypted` Bytes column); every other field is
 * queryable plaintext.
 */
import { z } from "zod/v4";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";
import { lateralityEnum } from "@/lib/validations/encounters";

/**
 * Plausible-instant bound shared with the measurement / mood / cycle
 * paths: no future instant beyond the 5-min skew, no instant before 1900.
 * Stays a string on the wire (iOS reads it back verbatim).
 */
const boundedInstant = z.iso
  .datetime({ offset: true })
  .refine((s) => isPlausibleEntryInstant(new Date(s)), {
    message: "must be a plausible instant (not future, not pre-1900)",
  });

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/* ── enums (mirror the Prisma enums) ─────────────────────────────── */

export const illnessTypeEnum = z.enum([
  "INFECTION",
  "ALLERGY",
  "INJURY",
  "MENTAL_HEALTH",
  "AUTOIMMUNE",
  "CHRONIC",
  "OTHER",
]);

export const illnessLifecycleEnum = z.enum([
  "ACUTE",
  "CHRONIC_ONGOING",
  "RECURRING",
  "FLARE",
]);

/* ── episode CRUD ─────────────────────────────────────────────────── */

/**
 * Where on the body, in the person's own words (v1.39.2). Becomes
 * `bodySiteEncrypted`. Bounded like the procedure's site: a label, not prose.
 * Absent leaves the stored value alone on an edit; `null` or blank clears it.
 */
const bodySite = z.string().max(200).nullable().optional();
const laterality = lateralityEnum.nullable().optional();

/**
 * Create an episode. `label` is the user-facing name; `note` is encrypted
 * at rest. `parentConditionId` threads a FLARE/RECURRING bout under a
 * parent condition. `onsetAt` defaults to "now" server-side when omitted.
 */
export const illnessEpisodeCreateSchema = z
  .object({
    label: z.string().min(1).max(120),
    type: illnessTypeEnum,
    lifecycle: illnessLifecycleEnum.optional().default("ACUTE"),
    onsetAt: boundedInstant.optional(),
    resolvedAt: boundedInstant.nullable().optional(),
    parentConditionId: z.string().min(1).max(40).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    bodySite,
    laterality,
  })
  // An episode can never resolve before it began. `onsetAt` defaults to "now"
  // server-side when omitted, so the invariant only bites when BOTH instants
  // are supplied (the inverted-window case).
  .superRefine((v, ctx) => {
    if (v.resolvedAt && v.onsetAt && v.resolvedAt < v.onsetAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "resolvedAt must be on or after onsetAt",
      });
    }
  });

export type IllnessEpisodeCreate = z.infer<typeof illnessEpisodeCreateSchema>;

/**
 * Edit an episode — every field optional; an omitted field is left
 * untouched. A `null` `resolvedAt` re-opens a resolved episode.
 */
export const illnessEpisodeUpdateSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    type: illnessTypeEnum.optional(),
    lifecycle: illnessLifecycleEnum.optional(),
    onsetAt: boundedInstant.optional(),
    resolvedAt: boundedInstant.nullable().optional(),
    parentConditionId: z.string().min(1).max(40).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    bodySite,
    laterality,
  })
  .strict()
  // When BOTH instants are in the same edit body, enforce the window order at
  // parse time. A partial edit touching only one is validated against the
  // stored value in the route (it must load the row anyway).
  .superRefine((v, ctx) => {
    if (v.resolvedAt && v.onsetAt && v.resolvedAt < v.onsetAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "resolvedAt must be on or after onsetAt",
      });
    }
  });

export type IllnessEpisodeUpdate = z.infer<typeof illnessEpisodeUpdateSchema>;

/** Resolve (mark recovered) — a dedicated PATCH `/resolve` endpoint. */
export const illnessEpisodeResolveSchema = z.object({
  resolvedAt: boundedInstant.optional(),
});

export type IllnessEpisodeResolve = z.infer<typeof illnessEpisodeResolveSchema>;

/** History/list query — newest-first, bounded. */
export const illnessEpisodeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  includeResolved: z.union([z.literal("true"), z.literal("false")]).optional(),
});

/* ── day-log capture (one row per day of an episode) ─────────────── */

/**
 * The canonical day-log input for an episode. Upserts on the
 * `(episodeId, date)` key. `note` is encrypted at rest (`noteEncrypted`);
 * `functionalImpact` (0–3) and `feverC` are queryable plaintext. Symptoms
 * carry a 0–3 Jackson/WURSS severity on the link.
 */
export const illnessDayLogInputSchema = z.object({
  date: dateString,
  functionalImpact: z.number().int().min(0).max(3).nullable().optional(),
  feverC: z.number().min(30).max(45).nullable().optional(),
  symptoms: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        // 1–3 graded intensity (Jackson/WURSS). A link's mere PRESENCE already
        // means "present"; `null`/omitted = a plain presence link, so 0 is not
        // a distinct state and the selector offers 1–3 to match this contract.
        severity: z.number().int().min(1).max(3).optional(),
      }),
    )
    .max(40)
    .optional(),
  note: z.string().max(2000).nullable().optional(),
  loggedAt: boundedInstant.optional(),
});

export type IllnessDayLogInput = z.infer<typeof illnessDayLogInputSchema>;

/** The single-day read query: `GET .../day-logs?date=YYYY-MM-DD`. */
export const illnessDayLogQuerySchema = z.object({ date: dateString });

/**
 * The date-less LIST query: `GET .../day-logs` with NO `date` param returns
 * the episode's day-logs newest-first, paginated. Mirrors the Labs
 * limit/offset/sortDir + `meta.total` pattern so iOS (healthlog-iOS#30) can
 * page a full history without anchoring on today. `date` and the list params
 * are mutually exclusive at the route: a `date` triggers the single-day read,
 * its absence triggers the list.
 */
export const illnessDayLogListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type IllnessDayLogListQuery = z.infer<
  typeof illnessDayLogListQuerySchema
>;

/* ── P3 retrospective insight window ─────────────────────────────────── */

/**
 * The retrospective-insight window query: `GET /api/illness/insights?
 * windowDays=365`. Bounded 30..1095 days; defaults to a trailing year.
 * Retrospective only — the engine summarises past episodes, never forecasts.
 *
 * `includeRecoveryGap` (default false) gates the EXPENSIVE per-episode
 * correlation fan-out. The illness LIST loads with it off so the page paints
 * on a single fast count query; only the explicit "Analyse" expansion sets it
 * true and pays for the recovery-gap computation. Withholding it leaves the
 * typical-gap null (the surface shows the calm "still learning" line).
 */
export const illnessInsightsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(30).max(1095).optional(),
  includeRecoveryGap: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
