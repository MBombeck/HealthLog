/**
 * OpenAPI route table — cycle tracking (day logs, periods, calendar, insights, prefs).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  flowLevelEnum,
  ovulationTestEnum,
  cervicalMucusEnum,
  secondarySymptomEnum,
  cervixPositionEnum,
  cervixFirmnessEnum,
  cervixOpeningEnum,
  homeTestResultEnum,
  cycleTrackingGoalEnum,
  cycleDayLogInputSchema,
  cycleDayLogPatchSchema,
  cycleDayLogQuerySchema,
  cycleBulkSchema,
  cyclePeriodSchema,
  cyclePrefsSchema,
} from "@/lib/validations/cycle";
import {
  createCustomSymptomSchema,
  updateCustomSymptomSchema,
} from "@/lib/cycle/custom-symptoms-shared";
import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  malformedJsonResponse,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

// ── Cycle tracking (v1.15.0) ─────────────────────────────────────────
// The `/api/cycle/*` capture / calendar / history / settings surface +
// the cycle-prefs PATCH. Request bodies come from the Zod validation
// module so the spec stays single-source; response DTOs are declared
// here mirroring `src/lib/cycle/dto.ts`. Every `/api/cycle/*` route also
// 403s `{ errorCode:"cycle.disabled" }` when the feature gate is off.

const predictionMethodEnumOpenapi = z
  .enum(["CALENDAR", "SYMPTOTHERMAL", "TEMPERATURE_TREND", "BLENDED"])
  .meta({ id: "CyclePredictionMethod" });

const cyclePhaseEnumOpenapi = z
  .enum(["MENSTRUAL", "FOLLICULAR", "OVULATORY", "LUTEAL"])
  .meta({ id: "CyclePhase" });

// `.meta()` CLONES in Zod 4 rather than annotating in place, so the returned
// schema has to be captured and referenced. A bare `schema.meta({...})`
// statement registers nothing and the component id it names never reaches the
// emitted document.
const flowLevelEnumOpenapi = flowLevelEnum.meta({
  id: "FlowLevel",
  description: "Menstrual-flow intensity.",
});
const ovulationTestEnumOpenapi = ovulationTestEnum.meta({
  id: "OvulationTest",
  description: "Ovulation predictor-kit (OPK) reading.",
});
const cervicalMucusEnumOpenapi = cervicalMucusEnum.meta({
  id: "CervicalMucus",
  description: "Cervical-mucus quality.",
});
const homeTestResultEnumOpenapi = homeTestResultEnum.meta({
  id: "HomeTestResult",
  description: "At-home test result (pregnancy / progesterone).",
});
const cycleTrackingGoalEnumOpenapi = cycleTrackingGoalEnum.meta({
  id: "CycleTrackingGoal",
  description: "Drives cycle copy + fertile-window gating.",
});

const cycleDayLogInput = cycleDayLogInputSchema.meta({
  id: "CycleDayLogInput",
  description:
    "One day's cycle capture. `note` is encrypted at rest; every other field is queryable plaintext. UPSERT key: `(userId, source, externalId)` when externalId present, else `(userId, date)`. Shared by the single POST, the bulk drain, and the period shortcut.",
});

const cycleDayLogBulkRequest = cycleBulkSchema.meta({
  id: "CycleDayLogBulkRequest",
  description:
    "Outbox / HealthKit drain. Up to 500 entries per call; wrapped in `withIdempotency`; rate-limited 60/min. Each entry upserts per the day-log key.",
});

const cyclePeriodRequest = cyclePeriodSchema.meta({
  id: "CyclePeriodRequest",
  description:
    "One-tap period boundary. `start` opens a new cycle (closing the prior), `end` stamps the current cycle's periodEndDate; both write a boundary day-log.",
});

const cyclePrefsRequest = cyclePrefsSchema.meta({
  id: "CyclePrefsRequest",
  description:
    "Partial cycle-preferences deep-merge. `enabled` flips the feature gate (`cycleTrackingEnabled`). Omitted fields are left untouched.",
});

const cycleDayLogPatchRequest = cycleDayLogPatchSchema.meta({
  id: "CycleDayLogPatchRequest",
  description:
    "Partial day-log edit. Every field optional; `note` re-encrypts (explicit null clears it). `date` / `source` / `externalId` are immutable on update.",
});

const cycleSymptomDto = z.object({
  key: z.string(),
  severity: z.number().int().min(1).max(4).nullable(),
});

export const cycleDayLogDto = z
  .object({
    id: z.string(),
    date: z.string(),
    cycleId: z.string().nullable(),
    flow: flowLevelEnumOpenapi.nullable(),
    intermenstrualBleeding: z.boolean(),
    basalBodyTempC: z.number().nullable(),
    temperatureExcluded: z.boolean(),
    ovulationTest: ovulationTestEnumOpenapi.nullable(),
    cervicalMucus: cervicalMucusEnumOpenapi.nullable(),
    cervixPosition: cervixPositionEnum.nullable(),
    cervixFirmness: cervixFirmnessEnum.nullable(),
    cervixOpening: cervixOpeningEnum.nullable(),
    sexualActivity: z.boolean(),
    protectedSex: z.boolean().nullable(),
    pregnancyTest: homeTestResultEnumOpenapi.nullable(),
    progesteroneTest: homeTestResultEnumOpenapi.nullable(),
    contraceptive: z.string().nullable(),
    symptoms: z.array(cycleSymptomDto),
    note: z.string().nullable(),
    source: z.string(),
    externalId: z.string().nullable(),
    syncVersion: z.number().int(),
    updatedAt: z.iso.datetime({ offset: true }),
    deletedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({
    id: "CycleDayLogDTO",
    description:
      "The canonical day-log row iOS mirrors. `note` is decrypted on read. Soft-deleted rows ride `/api/sync/changes` as tombstones.",
  });

export const menstrualCycleDto = z
  .object({
    id: z.string(),
    startDate: z.string(),
    endDate: z.string().nullable(),
    periodEndDate: z.string().nullable(),
    lengthDays: z.number().int().nullable(),
    ovulationDate: z.string().nullable(),
    ovulationConfirmed: z.boolean(),
    isPredicted: z.boolean(),
    syncVersion: z.number().int(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MenstrualCycleDTO",
    description: "One menstrual cycle (observed or forward-predicted).",
  });

const cyclePredictionDto = z
  .object({
    method: predictionMethodEnumOpenapi,
    nextPeriodStart: z.string(),
    nextPeriodStartLow: z.string(),
    nextPeriodStartHigh: z.string(),
    fertileWindowStart: z.string().nullable(),
    fertileWindowEnd: z.string().nullable(),
    predictedOvulation: z.string().nullable(),
    ovulationConfirmed: z.boolean(),
    confidence: z.number(),
    cyclesObserved: z.number().int(),
    stillLearning: z.boolean(),
    disclaimer: z.string(),
  })
  .meta({
    id: "CyclePredictionDTO",
    description:
      "The materialised forecast. Fertile-window fields (and predictedOvulation/ovulationConfirmed) are server-suppressed (null/false) unless the goal is TRYING_TO_CONCEIVE or AVOID_PREGNANCY.",
  });

const cycleCalendarDayDto = z.object({
  date: z.string(),
  phase: cyclePhaseEnumOpenapi.nullable(),
  isPredictedPeriod: z.boolean(),
  isFertileWindow: z.boolean(),
  isPredictedOvulation: z.boolean(),
  isPeriodLogged: z.boolean(),
  isCycleStart: z.boolean().meta({
    description:
      "Whether a logged cycle opens on this day. Deleting this day's log removes that cycle start with it.",
  }),
  flow: flowLevelEnumOpenapi.nullable(),
  hasSymptoms: z.boolean(),
  confidence: z.number(),
  // v1.15.0 — logged basal-body-temperature + fertility-sign markers, surfaced
  // so the web BBT chart renders from the calendar read (the values are already
  // loaded server-side for the symptothermal layer; no extra query).
  basalBodyTempC: z.number().nullable(),
  temperatureExcluded: z.boolean(),
  ovulationTest: ovulationTestEnumOpenapi.nullable(),
  cervicalMucus: cervicalMucusEnumOpenapi.nullable(),
  cervixPosition: cervixPositionEnum.nullable(),
  cervixFirmness: cervixFirmnessEnum.nullable(),
  cervixOpening: cervixOpeningEnum.nullable(),
});

const cycleVerdictDto = z
  .object({
    state: z.enum(["IN_CYCLE", "OVERDUE", "INSUFFICIENT_DATA"]),
    dayOfCycle: z.number().int().nullable().meta({
      description:
        "1-based day of the current cycle. Null in OVERDUE and INSUFFICIENT_DATA — beyond the typical length plus the server's grace window the count is no longer an observed fact.",
    }),
    cycleLength: z.number().int().nullable().meta({
      description:
        "Days the ring represents: the observed labelled run, or the profile-derived idealized cycle for a low-data tracker.",
    }),
    phase: cyclePhaseEnumOpenapi.nullable(),
    spans: z.array(
      z.object({ phase: cyclePhaseEnumOpenapi, fraction: z.number() }),
    ),
    cycleStartDate: z.string().nullable().meta({
      description:
        "First day of the current cycle (YYYY-MM-DD). Still set while OVERDUE — the last logged period start remains a fact once the count stops.",
    }),
    overdueDays: z.number().int().nullable().meta({
      description:
        "How many days past the profile's typical cycle length the open cycle has run. Set only in OVERDUE.",
    }),
    daysUntilNext: z.number().int().nullable().meta({
      description:
        "Days from today to the predicted next period start. Null when no prediction ran and null once that start is in the past.",
    }),
    fertileWindow: z.object({
      start: z.string().nullable(),
      end: z.string().nullable(),
      active: z.boolean(),
    }),
  })
  .meta({
    id: "CycleVerdictDTO",
    description:
      "The resolved cycle verdict for the user's own timezone day. Render these values; do not recompute them. The grace window that decides OVERDUE is deliberately not published — read `state` and `overdueDays`.",
  });

const cycleProfileDto = z
  .object({
    goal: cycleTrackingGoalEnumOpenapi,
    cycleTrackingEnabled: z.boolean(),
    secondarySymptom: secondarySymptomEnum,
    rawChartMode: z.boolean(),
    predictionEnabled: z.boolean(),
    discreetNotifications: z.boolean(),
    sensitiveCategoryEncryption: z.boolean(),
    typicalCycleLength: z.number().int().nullable(),
    typicalPeriodLength: z.number().int().nullable(),
    lutealPhaseLength: z.number().int().nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "CycleProfileDTO",
    description: "The full per-user cycle settings row.",
  });

const cycleCalendarResponse = z.object({
  profile: z.object({
    goal: cycleTrackingGoalEnumOpenapi,
    rawChartMode: z.boolean(),
    predictionEnabled: z.boolean(),
    cyclesObserved: z.number().int(),
  }),
  prediction: cyclePredictionDto.nullable(),
  // The resolved verdict — required, never optional. An optional verdict is a
  // plausible default that invites a client to fall back to deriving its own,
  // which is the defect this field exists to remove.
  verdict: cycleVerdictDto,
  // Cold-start gate (mirrors `prediction.stillLearning`): true while < 3 cycles
  // are observed. When set, the `days` grid carries no fertile window, no
  // predicted-ovulation dot, and no phase band (those would rest on a
  // population prior) — the client shows a calm "learning your cycle" state.
  // Additive + back-compatible.
  stillLearning: z.boolean(),
  days: z.array(cycleCalendarDayDto),
  meta: z.object({ generatedAt: z.iso.datetime({ offset: true }) }),
});

const cycleHistoryResponse = z.object({
  cycles: z.array(menstrualCycleDto),
  stats: z.object({
    avgLengthDays: z.number().int().nullable(),
    lengthVariabilityDays: z.number().nullable(),
    avgPeriodLengthDays: z.number().int().nullable(),
    regularity: z.enum(["REGULAR", "IRREGULAR", "LEARNING"]),
  }),
});

const cyclePeriodResponse = z.object({
  cycle: menstrualCycleDto.nullable(),
  dayLog: cycleDayLogDto.nullable(),
});

const cyclePhaseCrosstabRow = z
  .object({
    metricKey: z.enum([
      "restingHeartRate",
      "heartRateVariability",
      "sleepDuration",
      "steps",
      "weight",
      "basalBodyTemp",
      "wristTemperature",
      "skinTemperature",
      "bloodGlucose",
      "mood",
    ]),
    display: z.enum([
      "hours",
      "steps",
      "bpm",
      "ms",
      "kg",
      "celsius",
      "glucose",
      "mood",
    ]),
    lutealDays: z.number().int(),
    follicularDays: z.number().int(),
    lutealAvg: z.number(),
    follicularAvg: z.number(),
    delta: z.number(),
    pValue: z.number(),
    qValue: z.number(),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .meta({
    id: "CyclePhaseCrosstabRow",
    description:
      "One FDR-surviving luteal-vs-follicular contrast for an outcome metric. `delta = lutealAvg − follicularAvg`. Observational, never causal.",
  });

const cyclePhaseLaggedPair = z
  .object({
    behaviour: z.string(),
    outcome: z.string(),
    n: z.number().int(),
    r: z.number(),
    pValue: z.number(),
    qValue: z.number(),
    interpretation: z.string(),
    lagDays: z.number().int(),
  })
  .meta({
    id: "CyclePhaseLaggedPair",
    description:
      "One FDR-surviving lagged-Pearson pair from the continuous CYCLE_PHASE ordinal × outcome matrix (mechanism B). Descriptive, never causal.",
  });

const cyclePhaseEnumForCount = z.enum([
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
]);

const cycleSymptomPhaseRow = z
  .object({
    symptomKey: z.string(),
    counts: z.object({
      MENSTRUAL: z.number().int(),
      FOLLICULAR: z.number().int(),
      OVULATORY: z.number().int(),
      LUTEAL: z.number().int(),
    }),
    total: z.number().int(),
    topPhase: cyclePhaseEnumForCount,
    topShare: z.number(),
  })
  .meta({
    id: "CycleSymptomPhaseRow",
    description:
      "Where a logged symptom clusters across the cycle phases. Surfaced only once logged on ≥3 phase-labelled days. Observational, never causal.",
  });

const cycleInsightsResponse = z.object({
  rows: z.array(cyclePhaseCrosstabRow),
  headline: cyclePhaseCrosstabRow.nullable(),
  lagged: z.object({
    discovered: z.array(cyclePhaseLaggedPair),
    pairsTested: z.number().int(),
    fdrQ: z.number(),
    minPairs: z.number().int(),
  }),
  symptomPatterns: z.array(cycleSymptomPhaseRow),
  contrast: z.object({
    high: z.literal("LUTEAL"),
    low: z.literal("FOLLICULAR"),
  }),
  windowDays: z.number().int(),
  cyclesObserved: z.number().int(),
});

const cycleBulkEntryResult = z.object({
  index: z.number().int(),
  status: z.enum(["inserted", "duplicate", "updated", "skipped"]),
  id: z.string().optional(),
  externalId: z.string().optional(),
  reason: z.string().optional(),
});

const cycleBulkResponse = z.object({
  processed: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  duplicates: z.number().int(),
  skipped: z.number().int(),
  entries: z.array(cycleBulkEntryResult),
});

// A reusable 403 the cycle routes carry (the feature gate).
const CYCLE_DISABLED_DESCRIPTION =
  "Cycle tracking is not enabled for this account (errorCode `cycle.disabled`). Resolved against the RECORD being read, not the caller: a delegate inside somebody else's record sees the owner's setting.";

const cycleDisabledResponse = {
  "403": {
    description: CYCLE_DISABLED_DESCRIPTION,
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

/**
 * The same gate on a delegable route, sharing its status with the sharing
 * refusal. One 403 per operation is all OpenAPI allows, so the two reasons
 * arrive in one description rather than one of them going unpublished.
 */
const cycleDisabledOnADelegableRoute = recordRefusal(
  CYCLE_DISABLED_DESCRIPTION,
);

// ── Custom symptom catalogue (v1.15.1) ───────────────────────────────
// The per-record symptom vocabulary the log-day sheet merges into the seeded
// chip grid. The label is intent-revealing free text, so it is encrypted at
// rest and never reaches a wide event or an audit excerpt — only the icon and
// the minted key do.

const createCycleCustomSymptomRequest = createCustomSymptomSchema.meta({
  id: "CreateCycleCustomSymptomRequest",
  description:
    "Create-a-custom-symptom body. `label` is trimmed and must be 1..40 characters. `icon` is optional and must name one of the twenty allow-listed Lucide icons (unknown names 422 rather than falling back). `categoryKey` is reserved for a future per-symptom category choice and today accepts only the literal `custom`. The minted key, the sort order and the owning record all come from the server.",
});

const updateCycleCustomSymptomRequest = updateCustomSymptomSchema.meta({
  id: "UpdateCycleCustomSymptomRequest",
  description:
    "Partial custom-symptom edit; at least one of `label` / `icon` / `isActive` is required. `isActive: false` hides the symptom while every day log that references it stays intact; `isActive: true` brings it back, and the per-record cap is re-checked on the way in so hiding and re-enabling cannot be used to exceed it.",
});

const cycleCustomSymptom = z
  .object({
    key: z
      .string()
      .describe(
        "The minted `custom:<uuid>` key. Stable, and the value a day-log's symptom list carries for this symptom.",
      ),
    label: z
      .string()
      .nullable()
      .describe(
        "The decrypted label. Null when the stored ciphertext could not be decrypted — one unreadable row fails soft rather than taking the whole catalogue read down, and the client falls back to the generic label.",
      ),
    icon: z
      .string()
      .nullable()
      .describe(
        "Lucide icon name from the closed allow-list, or null. The allow-list is limited to names the iOS client maps to an SF Symbol, so a custom symptom never falls back to the generic glyph on one platform.",
      ),
    custom: z
      .literal(true)
      .describe(
        "Always true. Lets a client merge this list into the seeded catalogue and still tell the two apart.",
      ),
  })
  .meta({
    id: "CycleCustomSymptom",
    description:
      "One user-minted cycle symptom. The label is stored encrypted and decrypted on read; the key is what a day log references.",
  });

export const cyclePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/cycle/symptoms/custom": {
    get: {
      tags: ["Cycle"],
      summary: "List the record's custom cycle symptoms (v1.15.1)",
      description:
        "Returns the active custom symptoms in `sortOrder`, labels decrypted, so the log-day sheet can merge them into the seeded chip grid. Deactivated symptoms are excluded. Gated: `cycle.disabled` 403 when cycle tracking is off for the RECORD. Delegable at READ level over the `cycle` section. Cookie or Bearer auth.",
      responses: {
        "200": {
          description: "The active custom symptoms (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ symptoms: z.array(cycleCustomSymptom) }),
                "CycleCustomSymptomListEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Cycle"],
      summary: "Create a custom cycle symptom (v1.15.1)",
      description:
        "Mints a `custom:<uuid>` key, encrypts the label at rest, and stores the row under the global `custom` category owned by the record. Returns 201 with the created symptom, the submitted label echoed back in plaintext. Capped at 50 active custom symptoms per record. Rate-limited 30/min keyed on the ACTOR, so a delegate burns their own allowance rather than locking the owner out and cannot collect a fresh one by switching records. Audits as `cycle.symptom.custom.create` with the icon only — never the label. Delegable at MANAGE level over the `cycle` section: the record's own symptom vocabulary is what the day-log writes need in order to say anything.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createCycleCustomSymptomRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        "201": {
          description: "The created custom symptom.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleCustomSymptom,
                "CycleCustomSymptomCreatedEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
        "422": {
          description:
            "Either the body failed validation — the multi-issue envelope with `meta.errorCode` = `cycle.symptom.custom.invalid` (an empty or over-40-character label, an icon outside the allow-list, a `categoryKey` other than `custom`) — or the record already holds 50 active custom symptoms, in which case `meta.errorCode` = `cycle.symptom.custom.limit` and there is no issue list. Branch on the code, not on the presence of issues.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 30 creates in the trailing minute for this ACTOR (`cycle:symptom:custom:<actorId>`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/cycle/symptoms/custom/{key}": {
    patch: {
      tags: ["Cycle"],
      summary: "Rename, re-icon or hide a custom cycle symptom (v1.15.1)",
      description:
        "Edits one custom symptom the CALLER owns. The key must carry the `custom:` prefix — a catalogue key is refused as not-found before anything is read — and it is resolved against the caller's own rows only, so another account's key is a 404 and never a 403. A re-activation re-checks the 50-symptom cap, because a hidden row does not count toward it and skipping the check would make hide-then-enable a way around the limit. The audit row records which FIELDS the write touched and the resulting active state, never the decrypted label. Rate-limited 30/min. Gated: `cycle.disabled` 403 when cycle tracking is off. NOT delegable — unlike the collection this hangs off, both verbs here resolve the caller as themselves, so a delegate can create a symptom in a shared record and cannot then rename or hide it. Cookie or Bearer auth.",
      requestParams: {
        path: z.object({
          key: z
            .string()
            .describe("The `custom:<uuid>` key. A catalogue key 404s."),
        }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateCycleCustomSymptomRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The edited symptom, with the stored label decrypted and the resulting `isActive` — a field the create response does not carry.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleCustomSymptom.extend({ isActive: z.boolean() }),
                "CycleCustomSymptomUpdatedEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "The key is not a `custom:` key, or names no symptom this account owns. The two are indistinguishable.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
        "422": {
          description:
            "Either the body failed validation — the multi-issue envelope with `meta.errorCode` = `cycle.symptom.custom.invalid` — or re-activating would exceed the 50 active custom symptoms, in which case `meta.errorCode` = `cycle.symptom.custom.limit` and there is no issue list.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 30 edits or deletes in the trailing minute for this account (`cycle:symptom:custom:<userId>`, shared with the DELETE below — and note this bucket keys on the USER, where the create on the collection keys on the ACTOR).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
    delete: {
      tags: ["Cycle"],
      summary: "Hide or purge a custom cycle symptom (v1.15.1)",
      description:
        "Two different operations behind one verb, chosen by `purge`. By DEFAULT this is not a delete at all: the row is deactivated, so it leaves the chip grid while every day log that recorded it keeps its reference and its history reads unchanged. With `purge=true` the row is HARD-deleted and the foreign-key cascade takes every `cycle_symptom_link` with it — the days that recorded the symptom lose that fact, and nothing reconstructs it. There is no confirmation step on the wire and no undo. The response reports which of the two happened in `purged`. The key must carry the `custom:` prefix and resolves against the caller's own rows only. The audit row records the mode and nothing else — never the decrypted label. Rate-limited 30/min. Gated: `cycle.disabled` 403. NOT delegable. Cookie or Bearer auth.",
      requestParams: {
        path: z.object({
          key: z
            .string()
            .describe("The `custom:<uuid>` key. A catalogue key 404s."),
        }),
        query: z.object({
          purge: z
            .literal("true")
            .optional()
            .describe(
              "Send exactly `true` for the hard delete with its cascade. Any other value, and omitting it, deactivates instead — the test is an equality against the string, not a boolean parse.",
            ),
        }),
      },
      responses: {
        "200": {
          description:
            "Done. `purged: true` means the row and its day-log links are gone; `false` means it was deactivated and its history is intact.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ key: z.string(), purged: z.boolean() }),
                "CycleCustomSymptomDeletedEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "The key is not a `custom:` key, or names no symptom this account owns.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
        "429": {
          description:
            "More than 30 edits or deletes in the trailing minute for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/cycle/day-logs": {
    get: {
      tags: ["Cycle"],
      summary: "Read a single day's cycle day-log (v1.15.0)",
      description:
        "Returns the full `CycleDayLogDTO` for the tz-anchored `date`, or `null` when nothing is logged that day. Lets a client pre-fill an edit sheet. Gated; owner-scoped; soft-deleted rows excluded.",
      requestParams: { query: cycleDayLogQuerySchema },
      responses: {
        "200": {
          description: "The day-log for that date, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleDayLogDto.nullable(),
                "CycleDayLogReadEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Cycle"],
      summary: "Capture a single cycle day-log (v1.15.0)",
      description:
        "Upserts on `(userId, source, externalId)` when externalId present, else `(userId, date)`. `note` encrypts at rest. 201 on insert, 200 on update. Gated: `cycle.disabled` 403 when the feature is off.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogInput } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Existing day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogEnvelope"),
            },
          },
        },
        "201": {
          description: "New day-log created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleDayLogDto,
                "CycleDayLogCreatedEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/cycle/day-logs/{id}": {
    patch: {
      tags: ["Cycle"],
      summary: "Edit a single cycle day-log (v1.15.0)",
      description:
        "Partial edit; an omitted field is left untouched. Owner-scoped (a cross-user id 404s). Gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogPatchRequest } },
      },
      responses: {
        "200": {
          description: "Day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogPatchEnvelope"),
            },
          },
        },
        "404": {
          description: "Day-log not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Cycle"],
      summary: "Soft-delete a cycle day-log (v1.15.0)",
      description:
        "Sets `deletedAt` + bumps `syncVersion`; surfaces as a tombstone on the next `/api/sync/changes` page. 204. Idempotent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        "404": {
          description: "Day-log not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/day-logs/bulk": {
    post: {
      tags: ["Cycle"],
      summary: "Bulk drain cycle day-logs (Outbox / HealthKit) (v1.15.0)",
      description:
        "Up to 500 entries; `withIdempotency`; rate-limited `cycle:day-logs:bulk:<userId>` 60/min. Per-entry status: inserted | duplicate | updated | skipped. Always 200.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogBulkRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Batch processed (per-entry results).",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleBulkResponse, "CycleBulkEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/period": {
    post: {
      tags: ["Cycle"],
      summary: "Period-boundary shortcut (v1.15.0)",
      description:
        "One-tap started/ended period. `start` opens a new cycle (closing the prior); `end` stamps periodEndDate. Writes the boundary day-log. Gated.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: cyclePeriodRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Cycle + boundary day-log.",
          content: {
            "application/json": {
              schema: dataEnvelope(cyclePeriodResponse, "CyclePeriodEnvelope"),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/calendar": {
    get: {
      tags: ["Cycle"],
      summary: "Predicted cycle calendar (v1.15.0)",
      description:
        "Runs the deterministic engine to build `{ profile, prediction, days }`. Fertile-window fields are server-suppressed unless goal is TRYING_TO_CONCEIVE. Default range: today − 90d … +180d. Gated.",
      requestParams: {
        query: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
        }),
      },
      responses: {
        "200": {
          description: "Calendar grid + forecast.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleCalendarResponse,
                "CycleCalendarEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/cycles": {
    get: {
      tags: ["Cycle"],
      summary: "Cycle history + stats (v1.15.0)",
      description:
        "Most-recent cycles (newest first) + `{ avgLengthDays, lengthVariabilityDays (MAD), avgPeriodLengthDays, regularity }`. `limit` default 24. Gated.",
      requestParams: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(60).optional(),
        }),
      },
      responses: {
        "200": {
          description: "Cycle history.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleHistoryResponse,
                "CycleHistoryEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/insights": {
    get: {
      tags: ["Cycle"],
      summary: "Cycle-phase correlation insights (v1.15.0)",
      description:
        "FDR-guarded luteal-vs-follicular phase contrast per outcome metric (RHR / HRV / sleep / steps / weight / temperatures), plus the single headline finding (resting-heart-rate-by-phase, falling back to HRV). The same Welch t-test + Benjamini-Hochberg machinery the mood-factor crosstab runs; only rows with p < 0.05 AND q ≤ 0.10 surface. Strictly gender-gated — phase never appears on the general `/api/insights/correlations` route. Observational only, never causal. Gated: `cycle.disabled` 403 when the feature is off.",
      responses: {
        "200": {
          description: "Phase-correlation rows + headline.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleInsightsResponse,
                "CycleInsightsEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/cycles/{id}": {
    delete: {
      tags: ["Cycle"],
      summary: "Soft-delete a menstrual cycle (v1.15.0)",
      description:
        "Sets `deletedAt` + bumps `syncVersion`; tombstones on the next sync page. 204. Idempotent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        "404": {
          description: "Cycle not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/all": {
    delete: {
      tags: ["Cycle"],
      summary: "Hard-purge all cycle data (v1.15.0)",
      description:
        "One-click privacy purge: HARD-deletes every cycle day-log (+ symptom links by cascade), menstrual cycle, prediction, the cycle audit trail, and the cycle reminder rows in the push-attempts ledger — no dated reproductive trace survives. The CycleProfile row is left in place. Gated + owner-scoped + audited.",
      responses: {
        "200": {
          description: "Purge counts.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  purged: z.boolean(),
                  dayLogs: z.number().int(),
                  predictions: z.number().int(),
                  cycles: z.number().int(),
                  auditRows: z.number().int(),
                  pushRows: z.number().int(),
                }),
                "CyclePurgeEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/profile": {
    get: {
      tags: ["Cycle"],
      summary: "Read the full cycle profile (v1.15.0)",
      description: "Returns the resolved CycleProfileDTO. Gated.",
      responses: {
        "200": {
          description: "Cycle profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CycleProfileEnvelope"),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/cycle-prefs": {
    get: {
      tags: ["Cycle"],
      summary: "Read cycle preferences (v1.15.0)",
      description:
        "Returns the resolved CycleProfileDTO. NOT gated — this is the surface that flips the gate.",
      responses: {
        "200": {
          description: "Cycle preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CyclePrefsGetEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Cycle"],
      summary: "Update cycle preferences (v1.15.0)",
      description:
        "Deep-merges the supplied fields. `enabled` flips `cycleTrackingEnabled`. Returns the merged CycleProfileDTO. NOT gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cyclePrefsRequest } },
      },
      responses: {
        "200": {
          description: "Merged cycle preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CyclePrefsPatchEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...malformedJsonResponse,
      },
    },
  },
};
