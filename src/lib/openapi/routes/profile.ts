/**
 * OpenAPI route table — account profile, avatar, coach prefs, disable-coach, source priority.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { notificationPrefsSchema } from "@/lib/validations/notification-prefs";
import { sourcePrioritySchema } from "@/lib/validations/source-priority";
import { modulePrefsPatchSchema } from "@/lib/validations/modules";
import { MODULE_KEYS } from "@/lib/modules/registry";
import { SCORE_PILLAR_IDS } from "@/lib/analytics/score/types";
import { savedReportProfileSchema } from "@/lib/report-selection/profile-shape";
import { injectionSiteEnum } from "@/lib/validations/medication";
import { deviceDeliverySchema } from "@/lib/validations/notification-prefs";
import { locales } from "@/lib/i18n/config";
import {
  thresholdsUpdateSchema,
  ALL_METRICS,
} from "@/lib/validations/thresholds";
import type { ThresholdMetric } from "@/lib/analytics/effective-range";
import {
  documentsAutoAiReadPatchSchema,
  injectionSitePrefsPatchSchema,
  labsLocalOcrPatchSchema,
  unitPreferencePatchSchema,
  glucoseUnitPatchSchema,
  useCentralCodexPatchSchema,
} from "@/lib/validations/user-prefs";
import {
  aiProviderPatchSchema,
  aiTestOverrideSchema,
} from "@/lib/validations/ai-provider";
import {
  HEALTH_PROFILE_FACT_KINDS,
  healthProfileFactKindSchema,
} from "@/lib/validations/health-profile-facts";
import {
  baseUpdatedAtField,
  coachPrefsSchema,
  conflictResponse409,
  dataEnvelope,
  deviceRevokeResponse,
  errorEnvelope,
  invalidBaseTokenResponse,
  malformedJsonResponse,
  recordRefusal,
  stdResponses,
  updatedAtTokenField,
} from "./shared";

// v1.18.0 — module enable/disable. The PATCH request is the REAL runtime
// validator (`modulePrefsPatchSchema` — strict over the toggleable key
// set; a core-domain or unknown key is a 422). The response is the
// fully-resolved `{ <moduleKey>: boolean }` map for every toggleable
// module: `cycle` mirrors the cycle gate, `coach` mirrors the resolved
// `disableCoach` + operator master flag, the rest read the per-user
// disabled-allowlist. The map is the single thing a client needs to gate
// every secondary domain end-to-end.
// v1.32.22 (M3) — the doc request extends the strict runtime schema with the
// optimistic-concurrency `baseUpdatedAt` token. The runtime strips it pre-Zod
// (`takeBaseToken`) BEFORE the strict parse, so the runtime schema alone would
// under-document the wire; documenting it here keeps the contract complete.
const modulePrefsPatchRequest = modulePrefsPatchSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "ModulePrefsPatchRequest",
    description:
      'Partial module enable/disable update. Each key is an optional boolean; an omitted key is left untouched, `false` disables the module, `true` (re-)enables it. Only the toggleable "secondary domains" are accepted — a core-domain key (`weight`, `bloodPressure`, `pulse`, `medications`) or any unknown key is a 422, so the measurement engine + medications can never be disabled here. `cycle`/`coach` are accepted for forward-compat but their real enabled-state is owned elsewhere (the cycle gate / `disableCoach` + the operator assistant flag). `baseUpdatedAt` is the optional optimistic-concurrency token — omit it for the legacy unconditional write.',
  });

const moduleMapResolved = z
  .object(
    Object.fromEntries(
      MODULE_KEYS.map((k) => [
        k,
        z
          .boolean()
          .describe(`Whether the "${k}" module is enabled for this account.`),
      ]),
    ),
  )
  .meta({
    id: "ModuleMap",
    description:
      "Fully-resolved module enable/disable map. Every toggleable module key is present. `false` means the surface should disappear end-to-end (nav, dashboard, insights, …). `cycle` mirrors `cycleTrackingEnabled`; `coach` mirrors the resolved per-user opt-out + operator master flag. On `GET /api/auth/me` it answers for the RECORD the session is inside rather than for the caller, because every surface it gates shows the record's data, and it is masked to the sections the active grant opens — a module outside them reads `false` rather than the record's true state. With no switch — which is every native request, since the Bearer transport carries none — the two are the same account, nothing is masked and the payload is unchanged.",
  });

/**
 * The same answer as `ModuleMap`, with the reason attached.
 *
 * Additive and beside the booleans, which keep their meaning: for every key
 * `modules[key]` is exactly `moduleAccess[key] === "enabled"`. A client that
 * only gates a surface keeps reading the boolean; a client that has to TELL
 * somebody why a surface is missing reads this, because the boolean collapses
 * three different situations into one `false`.
 */
export const moduleAccessMap = z
  .object(
    Object.fromEntries(
      MODULE_KEYS.map((k) => [
        k,
        z
          .enum(["enabled", "disabled", "not_granted", "unavailable"])
          .describe(`Why the "${k}" module is or is not available here.`),
      ]),
    ),
  )
  .meta({
    id: "ModuleAccessMap",
    description:
      "Why each toggleable module is or is not available for the record this session is inside. `enabled` — the module is on and the client may paint it. `disabled` — the record has it switched off. `not_granted` — the active grant's sections do not open the module's section, which also covers every module that reads across the whole record (achievements, the assistant surfaces, the export, environment, the account's own MCP endpoint) since no scoped grant opens one. `unavailable` — the operator switched the module off for the whole instance. Precedence, highest first: `unavailable` > `not_granted` > `disabled` > `enabled`, so the reason published is the one nothing further in can change. Own-record sessions and unscoped grants never produce `not_granted`. Every key is present, and `modules[key] === (moduleAccess[key] === \"enabled\")` holds for every key — this field adds a reason, never a different gate.",
  });

const moduleMapEnvelopeInner = z
  .object({ modules: moduleMapResolved, updatedAt: updatedAtTokenField })
  .meta({ id: "ModulesResponse" });

// v1.4.49 — single schema for the per-user Coach opt-out flag. Previously
// split into `disableCoachBody` (PATCH request) and `disableCoachData`
// (response payload), both `z.object({ disableCoach: z.boolean() })`. The
// payload was passed through `dataEnvelope(..., "GetDisableCoachResponse")`
// / `dataEnvelope(..., "PatchDisableCoachResponse")` which IDs the
// envelope wrapper — the inner flag carries its own `.meta()` and now
// renders as a single `$ref: "#/components/schemas/DisableCoachFlag"` in
// both the request body and both response envelopes.
const disableCoachFlag = z
  .object({
    disableCoach: z.boolean(),
  })
  .meta({
    id: "DisableCoachFlag",
    description:
      "Per-account Coach opt-out toggle (v1.4.47 W3). `true` hides the Coach FAB and short-circuits its API gates.",
  });

// v1.18.6 — explicit diabetes opt-in. Shared by GET (current) and PATCH
// (request body + resolved response). `true` switches the glucose target
// resolver to the tighter ADA glycemic GOAL bands (fasting 80–130,
// postprandial < 180). Never inferred from a reading; asserts no diagnosis.
const diabetesFlag = z
  .object({
    hasDiabetes: z.boolean(),
  })
  .meta({
    id: "DiabetesFlag",
    description:
      "Per-account diabetes opt-in (v1.18.6). `true` selects the ADA glycemic GOAL bands (fasting 80–130, postprandial < 180) for glucose targets instead of the general non-diabetic bands. A user-declared preference only — never inferred from a value, never a diagnosis.",
  });

// v1.16.11 — per-user notification preferences. The PATCH request body
// is the REAL runtime validator (`notificationPrefsSchema` — every
// category and field optional, deep-merged server-side); the response
// is the fully-resolved shape with the documented defaults filled in.
// v1.32.22 (M1) — the doc request extends the runtime validator with the
// optimistic-concurrency `baseUpdatedAt` token (stripped pre-Zod at runtime).
const notificationPrefsPatchRequest = notificationPrefsSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "NotificationPrefsPatchRequest",
    description:
      "Partial per-user notification preferences. Every category and field is optional; the server deep-merges the supplied keys over the persisted row, so a PATCH touching only `medication` leaves the siblings intact. `medication.lowStockRunwayDays` (1–60, nullable) is the low-stock alert threshold in remaining runway days — `null` switches the alert off. `baseUpdatedAt` is the optional optimistic-concurrency token: echo it to have the server refuse (409) a write that would silently revert a category another writer set from a fresher read (e.g. iOS `medication.clientManaged`). Omit it for the legacy unconditional write.",
  });

const notificationPrefsResolved = z
  .object({
    medication: z.object({
      clientManaged: z
        .boolean()
        .describe(
          "True when the iOS app owns local medication reminders; the server-side MEDICATION_REMINDER APNs cron is suppressed.",
        ),
      deliveryDefault: z
        .enum(["server", "client"])
        .describe(
          'Roaming user-level delivery default. "client" implies clientManaged: true.',
        ),
      lowStockRunwayDays: z
        .number()
        .int()
        .min(1)
        .max(60)
        .nullable()
        .describe(
          "Low-stock alert threshold as remaining runway days (1–60). null = alert off. Default 7.",
        ),
      reorderLeadDays: z
        .number()
        .int()
        .min(0)
        .max(60)
        .describe(
          "Reorder lead time in days (0–60) the low-stock alert assumes. The alert fires this lead plus one dose-interval before the supply runs out so a refill arrives before the last dose. Default 10; a per-medication reorderLeadDays overrides it.",
        ),
    }),
    mood: z.object({
      reminderHour: z
        .number()
        .int()
        .min(0)
        .max(23)
        .describe("Local-time hour for the daily mood reminder. Default 22."),
    }),
    cycle: z.object({
      clientManaged: z
        .boolean()
        .describe(
          "True when the iOS app owns local cycle reminders; the server-side cycle APNs cron is suppressed.",
        ),
    }),
    coach: z.object({
      nudgesEnabled: z
        .boolean()
        .describe("Master switch for the proactive Coach nudge cron."),
      nudgeMedication: z
        .boolean()
        .describe("Medication-group nudge triggers (compliance)."),
      nudgeVitals: z
        .boolean()
        .describe("Vitals-group nudge triggers (bp / score / weight / sleep)."),
      nudgeRoutine: z
        .boolean()
        .describe(
          "Routine-group nudge triggers (measurement gap / self-context).",
        ),
      nudgeFrequency: z
        .enum(["weekly", "biweekly"])
        .describe("Nudge frequency cap: one per 7 or per 14 days."),
    }),
  })
  .meta({
    id: "NotificationPrefs",
    description:
      "Fully-resolved per-user notification preferences. Every key is present — a null / drifted persisted row resolves to the documented defaults.",
  });

// v1.32.22 (M1) — GET / PATCH responses carry the optimistic-concurrency token
// as an additive sibling key next to the resolved categories.
const notificationPrefsResponse = notificationPrefsResolved
  .extend({ updatedAt: updatedAtTokenField })
  .meta({ id: "NotificationPrefsResponse" });

// v1.32.22 (M4) — coach-prefs GET / PUT responses carry the token; the PUT
// request extends the runtime validator with the base token.
const coachPrefsResponse = coachPrefsSchema
  .extend({ updatedAt: updatedAtTokenField })
  .meta({ id: "CoachPrefsResponse" });
const coachPrefsPutRequest = coachPrefsSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "PutCoachPrefsRequest",
    description:
      "Coach prompt-tuning preferences to persist, plus the optional optimistic-concurrency `baseUpdatedAt` token. The guarded write covers both `coachPrefsJson` and the mirrored `insightsExcludeMetrics` column atomically. Omit the token for the legacy unconditional write.",
  });

// v1.35.0 — which pillars count toward the Health Score. Shipped with a
// settings surface in front of it and no published contract at all; the
// entry below is that contract, read off the route rather than inferred
// from a neighbour.
//
// The asymmetry is the thing to get right: the REQUEST speaks the positive
// selection (the pillars that should count, which is what a person picks),
// while the RESPONSE carries both sides resolved. The column itself stores
// the complement, but that is storage and no client ever sees it.

const scorePillarId = z
  .enum(SCORE_PILLAR_IDS)
  .meta({ id: "ScorePillarId", description: "A Health Score pillar id." });

const healthScoreConfigResponse = z
  .object({
    pillars: z
      .array(scorePillarId)
      .describe(
        "Registry-ordered pillars that count toward the score. Data availability narrows this further at score time, and that narrowing is not a choice — so this is the composition, not a promise that every pillar has a number today.",
      ),
    excludedPillars: z
      .array(scorePillarId)
      .describe("Registry-ordered pillars the person took out."),
    hasSelection: z
      .boolean()
      .describe(
        "True once a selection has been written. It says the person chose, not that their choice differs from the default: an account that opened the surface and kept every pillar has a selection. False means nobody ever chose, and such an account still inherits a later change of defaults.",
      ),
    version: z
      .number()
      .int()
      .describe(
        "Per-user recipe version, monotonic and incremented on every accepted write. 0 while no selection has been written. A score record names the version that produced it, so a comparison can see the recipe move.",
      ),
    changedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the recipe last changed; null while it never has."),
    updatedAt: updatedAtTokenField,
  })
  .meta({
    id: "HealthScoreConfigResponse",
    description:
      "The resolved Health Score composition. `updatedAt` is ABSENT while the account has never written a selection — there is nothing to guard a write against, so the first save is the unconditional write.",
  });

const healthScoreConfigPatchRequest = z
  .object({
    pillars: z
      .array(scorePillarId)
      .max(SCORE_PILLAR_IDS.length)
      .describe(
        "The pillars that should count — the positive selection, not the exclusions. Replaces the stored recipe whole; it never merges. An id outside the catalogue is a 422 rather than being dropped, because a client has no business sending one.",
      ),
    baseUpdatedAt: baseUpdatedAtField,
  })
  // Mirrors the runtime `.strict()`, so a generated client is told about
  // the rejection rather than only being told in prose.
  .strict()
  .meta({
    id: "PatchHealthScoreConfigRequest",
    description:
      "The pillars that should count toward the score. Strict: any key other than `pillars` and `baseUpdatedAt` is rejected.",
  });

// v1.28-era — the owner's saved doctor-report selection (leaf list plus the
// render choices the export panel restores). `v` is the report-selection
// schema version (currently locked at 2); `leaves` is a closed catalogue of
// section/field ids, canonicalised to a fixed order server-side so two
// clients that chose the same scope persist the same bytes. This is the ONLY
// request body for the PUT — it replaces the stored profile whole, it never
// merges.
const savedReportProfile = savedReportProfileSchema.meta({
  id: "SavedReportProfile",
  description:
    "A saved doctor-report scope: which leaves are included plus the export format, trailing window and chart toggle. Replace-only — there is no partial-merge write.",
});

const reportSelectionGetResponse = z
  .object({
    profile: savedReportProfile
      .nullable()
      .describe(
        "The saved profile, or null when the account has never saved one, or when the stored blob no longer parses against the current leaf catalogue. Null is never resolved to a default scope server-side — the client applies its own named template and shows that as a visible choice.",
      ),
  })
  .meta({ id: "GetReportSelectionResponse" });

const reportSelectionPutResponse = z
  .object({ profile: savedReportProfile })
  .meta({ id: "PutReportSelectionResponse" });

// v1.8.6 — profile read/write surface for the native client. The
// runtime validation lives in `src/lib/validations/auth.ts`
// (`profileSchema`, whose transforms normalise empty → null and run the
// KVNR/IKNR refines); the OpenAPI shapes below mirror the wire contract
// without those transforms so the spec stays a clean nullable-field
// document. `insurerIkNumber` is the new v1.8.6 field: optional, 9-digit
// German IKNR, surfaced on the FHIR `Coverage` payor.
// Shared with `PUT /api/auth/profile`, which is served by the same
// `applyProfileUpdate` helper and therefore accepts the identical body.
// Exported rather than restated so the two paths cannot drift into two
// contracts for one validator; `auth.ts` imports it.
export const profileUpdateRequest = z
  .object({
    email: z.email().nullable().optional(),
    heightCm: z.number().min(50).max(300).nullable().optional(),
    dateOfBirth: z.string().nullable().optional(),
    gender: z
      .enum(["MALE", "FEMALE", "OTHER"])
      .nullable()
      .optional()
      .describe(
        "Stored gender. Null or an empty string clears it; an omitted field is left untouched.",
      ),
    displayName: z.string().min(1).max(80).nullable().optional(),
    locale: z.enum(["de", "en"]).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .optional()
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    dateFormat: z
      .enum(["AUTO", "DMY", "MDY", "YMD"])
      .optional()
      .describe(
        "Date-order display preference. AUTO follows the locale convention, DMY pins day-month-year (dd.MM.yyyy), MDY pins month-day-year (MM/dd/yyyy), YMD pins ISO yyyy-MM-dd.",
      ),
    moodReminderEnabled: z.boolean().optional(),
    fullName: z.string().max(120).nullable().optional(),
    insurerName: z.string().max(120).nullable().optional(),
    insuranceNumber: z
      .string()
      .nullable()
      .optional()
      .describe("German KVNR. Empty/null clears it; mod-10 check enforced."),
    insurerIkNumber: z
      .string()
      .nullable()
      .optional()
      .describe(
        "German insurer institution number (IKNR). Optional; empty/null clears it. A non-empty value must be exactly 9 digits (no checksum enforced).",
      ),
  })
  .meta({
    id: "ProfileUpdateRequest",
    description:
      "Partial profile update. Every field is optional and an omitted field is left untouched. An explicit null clears any nullable field; an empty string also clears `displayName`, `dateOfBirth`, `gender`, `fullName`, `insurerName`, `insuranceNumber` and `insurerIkNumber`. `email` is not among them — it is validated as an address, so send null to clear it. `locale`, `timezone`, `timeFormat` and `dateFormat` are not clearable. `userId` is never accepted — it is narrowed from the session/token.",
  });

const profileResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    dateFormat: z
      .enum(["AUTO", "DMY", "MDY", "YMD"])
      .describe(
        "Date-order display preference. AUTO follows the locale convention, DMY pins day-month-year (dd.MM.yyyy), MDY pins month-day-year (MM/dd/yyyy), YMD pins ISO yyyy-MM-dd.",
      ),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    insuranceNumber: z
      .string()
      .nullable()
      .describe("German KVNR, decrypted for the form prefill."),
    // v1.18.0 — resolved module enable/disable map, identical to the
    // /api/auth/me projection. The native client reads this alias, so it
    // must carry the same server-authoritative module flags.
    modules: moduleMapResolved,
  })
  .meta({
    id: "ProfileResponse",
    description:
      "Flattened profile fields for the native client (GET). The KVNR is decrypted server-side; the IKNR (v1.8.6) is plaintext at rest. The `modules` map mirrors the /api/auth/me projection so the alias carries the same module flags.",
  });

// The PATCH echo mirrors GET but reports KVNR presence as a boolean
// (`hasInsuranceNumber`) rather than re-emitting the decrypted value.
const profileUpdateResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z
      .enum(["AUTO", "H12", "H24"])
      .describe(
        "Hour-cycle display preference. AUTO follows the locale convention, H12 forces AM/PM, H24 forces 24-hour.",
      ),
    dateFormat: z
      .enum(["AUTO", "DMY", "MDY", "YMD"])
      .describe(
        "Date-order display preference. AUTO follows the locale convention, DMY pins day-month-year (dd.MM.yyyy), MDY pins month-day-year (MM/dd/yyyy), YMD pins ISO yyyy-MM-dd.",
      ),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    hasInsuranceNumber: z
      .boolean()
      .describe("Whether a KVNR is on file (the value itself is not echoed)."),
  })
  .meta({
    id: "ProfileUpdateResponse",
    description:
      "Profile echo returned by PATCH /api/user/profile. Reports KVNR presence as a boolean rather than re-emitting the decrypted value. NOT the shape `PUT /api/auth/profile` returns — the two share a handler but project it differently (see `AuthProfileUpdateResponse`), which is why this is no longer described as covering both.",
  });

// v1.16.16 — AI-provider read surface. iOS gates Coach visibility off
// `aiAvailable` + `managedBy` so a server-managed (operator-key) provider
// is no longer invisible to the client. The response reports key PRESENCE
// + a 4-char masked preview only; no plaintext key or admin endpoint is
// ever surfaced. `managedBy` reports the resolved provider origin: `user`
// (BYOK), `local` (self-hosted Ollama/LM Studio), `server` (operator's
// shared key), or null when no provider can serve the caller.
const aiProviderResponse = z
  .object({
    provider: z
      .enum([
        "OPENAI",
        "ANTHROPIC",
        "LOCAL",
        "OPENAI_COMPATIBLE",
        "CHATGPT_OAUTH",
      ])
      .nullable()
      .describe("The user's selected provider, or null when none is set."),
    model: z.string().nullable(),
    baseUrl: z
      .string()
      .nullable()
      .describe("Custom base URL (LOCAL provider only); null otherwise."),
    aiAvailable: z
      .boolean()
      .describe(
        "True when ANY provider can serve this user — including the operator's server-managed key when the user set none. iOS keys Coach visibility off this.",
      ),
    managedBy: z
      .enum(["user", "local", "server"])
      .nullable()
      .describe(
        "Resolved provider origin: `user` (BYOK), `local` (self-hosted), `server` (operator key), or null when no provider is available.",
      ),
    hasAnthropicKey: z.boolean(),
    anthropicKeyPreview: z
      .string()
      .nullable()
      .describe("`...` + last 4 chars of the stored Anthropic key, or null."),
    hasLocalKey: z.boolean(),
    hasOpenaiKey: z.boolean(),
    openaiKeyPreview: z
      .string()
      .nullable()
      .describe("`...` + last 4 chars of the stored OpenAI key, or null."),
    compatBaseUrl: z
      .string()
      .nullable()
      .describe(
        "v1.33.1 (#470) — base URL of the OpenAI-compatible gateway (LiteLLM / OpenRouter / vLLM). Its own column: the OpenAI provider stays pinned to api.openai.com and never reads it.",
      ),
    compatModel: z
      .string()
      .nullable()
      .describe(
        "Model the gateway should route. Null falls back to `model`; with neither set the gateway entry does not resolve.",
      ),
    hasCompatKey: z
      .boolean()
      .describe(
        "Whether a bearer is stored for the gateway. The bearer is optional — a gateway without auth needs none.",
      ),
    responseTimeoutSeconds: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.22 (#89) — per-user response timeout for AI generation, in seconds (10–600). Null = the built-in comprehensive-briefing default (~120 s). Mainly for slow local/self-hosted backends.",
      ),
    // v1.38.19 (wave D) — the setup flow's last screen used to promise
    // that insights "work for you right away" as soon as `managedBy` read
    // `server`. That is a presence read; it never knew whether the key
    // worked, and it said nothing about the consent receipt the egress
    // actually needs. These three fields make the promise checkable.
    serverProviderHealth: z
      .enum(["healthy", "unhealthy", "unknown"])
      .describe(
        "Instance-wide health of the operator's shared providers (`admin-openai` / `admin-codex`), folded across all accounts and reduced to a tri-state: `healthy` when one of them demonstrably served somebody within the last 24 h and no credential sits in its auth-failure cooldown, `unhealthy` when the last outcome somebody observed was a failure, `unknown` when nothing has been tried lately on this instance (including a brand-new instance whose ledger is still empty) or the read failed. Deliberately carries no count, no timestamp and no account identity — 'the provider of this instance last worked' is a statement about the instance, not about other people. Fails closed for the offer: neither `unhealthy` nor `unknown` may be offered. They are not interchangeable for copy, though — `unhealthy` is a verdict a client may state, `unknown` is the absence of one and must not be reported as an outage. Reading this never probes a provider.",
      ),
    serverProviderOffer: z
      .boolean()
      .describe(
        "Whether the shared provider may honestly be offered to this caller in one tap. True only when all of: the operator's provider is the one that would serve them (`managedBy: \"server\"`), `serverProviderHealth` is `healthy`, the operator's assistant master + coach flags are on, the acting record holds its own credentials (a managed profile never does), the caller holds no receipt yet, and the instance is not running in demo mode (where the grant the tap makes is refused at the edge). Anything unknown makes it false.",
      ),
    serverProviderConsent: z
      .boolean()
      .describe(
        "Whether this caller already holds an active `ai_full` / `ai_coach` receipt — the grant `POST /api/consent/ai/web` mints. When true there is nothing left to offer, and `serverProviderOffer` is false for that reason rather than for a bad one.",
      ),
  })
  .meta({
    id: "AiProviderResponse",
    description:
      "The calling user's AI-provider configuration plus the effective availability (`aiAvailable` + `managedBy`). Reports key presence + a masked preview only — never a plaintext key.",
  });

// ── Per-user preference scalars + threshold overrides ────────────────
// Four surfaces the iOS client has called since they shipped and that the
// registry never carried. The request bodies come from the validation modules
// the handlers themselves parse with, so the published wire cannot drift from
// the runtime one; the responses are shapes the handlers assemble by hand and
// are therefore described here.

const unitPreferencePatchRequest = unitPreferencePatchSchema.meta({
  id: "UnitPreferencePatchRequest",
  description:
    "Which display-unit branch to render. Presentation only — the stored measurement rows stay SI either way.",
});

const unitPreferenceResponse = z
  .object({ unitPreference: z.enum(["metric", "imperial"]) })
  .meta({ id: "UnitPreferenceResponse" });

const glucoseUnitPatchRequest = glucoseUnitPatchSchema.meta({
  id: "GlucoseUnitPatchRequest",
  description:
    "Which unit blood-glucose readings are rendered in. Presentation only — every stored reading is mg/dL either way.",
});

const glucoseUnitResponse = z
  .object({ glucoseUnit: z.enum(["mg/dL", "mmol/L"]) })
  .meta({ id: "GlucoseUnitResponse" });

const documentsAutoAiReadPatchRequest = documentsAutoAiReadPatchSchema.meta({
  id: "DocumentsAutoAiReadPatchRequest",
  description:
    "Turn automatic AI reading of newly uploaded documents on or off. Turning it on also mints an `ai_full` consent receipt and schedules a catch-up over the existing vault.",
});

const documentsAutoAiReadResponse = z
  .object({ documentsAutoAiRead: z.boolean() })
  .meta({ id: "DocumentsAutoAiReadResponse" });

const injectionSitePrefsPatchRequest = injectionSitePrefsPatchSchema.meta({
  id: "InjectionSitePrefsPatchRequest",
  description:
    "Replace the user-level injection-site deny-list. An empty array clears it.",
});

const injectionSitePrefsResponse = z
  .object({
    globalExcludedInjectionSites: z
      .array(injectionSiteEnum)
      .describe(
        "The stored deny-list, deduplicated and in canonical enum order.",
      ),
  })
  .meta({ id: "InjectionSitePrefsResponse" });

/**
 * The `?metric=` query enum, derived from the canonical metric list rather than
 * restated — `ALL_METRICS` is what the handler checks the parameter against, so
 * a metric added there cannot go missing from the published parameter.
 */
const thresholdMetricEnum = z
  .enum(ALL_METRICS as [ThresholdMetric, ...ThresholdMetric[]])
  .meta({ id: "ThresholdMetric" });

const trafficRange = z
  .object({
    greenMin: z.number(),
    greenMax: z.number(),
    orangeMin: z.number(),
    orangeMax: z.number(),
  })
  .meta({
    id: "TrafficRange",
    description:
      "A traffic-light band: green is the target window, the orange wings stretch either side of it and are clamped to the metric's physiological bounds.",
  });

const effectiveRange = z
  .object({
    range: trafficRange
      .nullable()
      .describe(
        "The band in force — the override when one is set, otherwise the computed default. Null when the default needs profile data the account has not supplied.",
      ),
    isOverride: z
      .boolean()
      .describe("Whether `range` came from a stored override."),
    default: trafficRange
      .nullable()
      .describe(
        "The unmodified computed default, so a client can render current-versus-default without recomputing it.",
      ),
    bounds: z
      .object({
        min: z.number(),
        max: z.number(),
        unit: z.string().describe("Canonical unit, e.g. `mmHg`, `kg`, `%`."),
      })
      .describe(
        "Outer physiological guardrails for this metric — the range an override must sit inside. Not a default.",
      ),
  })
  .meta({ id: "EffectiveRange" });

const thresholdOverrideMap = z
  .record(z.string(), z.object({ min: z.number(), max: z.number() }))
  .meta({
    id: "ThresholdOverrides",
    description:
      "Stored overrides, keyed by `ThresholdMetric`. Partial by construction — a metric absent from the map is on its computed default. `{}` means no override anywhere.",
  });

const thresholdsGetResponse = z
  .object({
    effective: z
      .record(z.string(), effectiveRange)
      .describe(
        "Every `ThresholdMetric`, resolved. Exhaustive: a metric with no override and no derivable default is present with a null `range`, not missing.",
      ),
    overrides: thresholdOverrideMap,
  })
  .meta({ id: "ThresholdsResponse" });

const thresholdsOverridesResponse = z
  .object({ overrides: thresholdOverrideMap })
  .meta({ id: "ThresholdsOverridesResponse" });

/**
 * The typed confirmation the parameterless DELETE demands.
 *
 * Published because it is the difference between "reset one band" and "erase
 * every band the account has tuned", and a client that learned the endpoint
 * from the contract alone would otherwise discover the requirement as a 422.
 */
const thresholdsResetAllRequest = z
  .object({
    confirm: z
      .literal("RESET_THRESHOLDS")
      .describe(
        "Required when `metric` is omitted. Compared exactly; any other value is refused.",
      ),
  })
  .meta({
    id: "ThresholdsResetAllRequest",
    description:
      "Confirmation body for the reset-everything form. Send no body at all when resetting a single metric with `?metric=`.",
  });

const thresholdsUpdateRequest = thresholdsUpdateSchema.meta({
  id: "ThresholdsUpdateRequest",
  description:
    "A partial map of `ThresholdMetric` to `{ min, max }`. Only the metrics named are written; the rest keep their existing override. Strict — an unknown key is a 422, not a silent drop. Each range must sit inside that metric's physiological bounds with `min` strictly below `max`.",
});

// ── Devices, the remaining scalar prefs, locale and timezone ─────────

const deviceInfo = z
  .object({
    id: z.string(),
    label: z
      .string()
      .describe(
        "Best available name: the reported model, falling back to the bundle id, falling back to the bare platform string. Never blank.",
      ),
    platform: z.string(),
    appVersion: z.string().nullable(),
    locale: z.string().nullable(),
    channels: z
      .array(z.enum(["web_push", "apns"]))
      .describe(
        "Which push transports this device row can currently be reached on. Derived from which token columns are populated, not from a stored list.",
      ),
    lastSeenAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    isCurrent: z
      .boolean()
      .describe(
        "True only when the caller sent `X-Device-Id` AND that device still holds an unrevoked refresh token for this account. A browser session has no such anchor, so a cookie caller sees false on every row — that is correct, not a bug to work around.",
      ),
  })
  .meta({
    id: "DeviceInfo",
    description:
      "A registered device, as the security surface renders it. Identifying metadata only — no push tokens, no APNs identifiers, no IP addresses.",
  });

const deviceListResponse = z
  .object({ devices: z.array(deviceInfo) })
  .meta({ id: "DeviceListResponse" });

const devicePatchRequest = z
  .object({ medicationDelivery: deviceDeliverySchema })
  .meta({
    id: "DevicePatchRequest",
    description:
      "Per-device medication-reminder delivery override. `server` forces server-side dispatch to this device, `client` leaves it to the app's own local reminders, and `null` CLEARS the override so the device inherits the account default.",
  });

const labsLocalOcrPatchRequest = labsLocalOcrPatchSchema.meta({
  id: "LabsLocalOcrPatchRequest",
  description:
    "Turn browser-side OCR on or off for lab-report scanning. When on, a text-only provider can still read a paper report because the image is transcribed on the device and only the TEXT is sent.",
});

const labsLocalOcrResponse = z
  .object({ labsLocalOcrEnabled: z.boolean() })
  .meta({ id: "LabsLocalOcrResponse" });

const useCentralCodexPatchRequest = useCentralCodexPatchSchema.meta({
  id: "UseCentralCodexPatchRequest",
  description:
    "Opt in or out of the operator's shared ChatGPT subscription as a trailing entry in this account's provider chain.",
});

const useCentralCodexResponse = z
  .object({ useCentralCodex: z.boolean() })
  .meta({ id: "UseCentralCodexResponse" });

const localePutRequest = z
  .object({
    locale: z
      .enum(locales)
      .describe("One of the interface locales this build ships."),
  })
  .meta({
    id: "LocalePutRequest",
    description:
      "The interface language. Validated against the supported set at the surface so the column can never hold a value the resolver would later have to defend against. The handler checks membership directly rather than through a Zod schema; the effect is the same.",
  });

const timezonePutRequest = z
  .object({
    timezone: z
      .string()
      .describe(
        "An IANA zone name. Accepted when the running engine's `Intl.DateTimeFormat` accepts it, which is the whole IANA set the deployment knows — not a fixed list this contract could enumerate.",
      ),
  })
  .meta({
    id: "TimezonePutRequest",
    description:
      "The account's timezone. The handler reads and trims the field directly rather than through a Zod schema.",
  });

// The PATCH body is the runtime validator, imported rather than restated.
// It used to be described here instead, because the route hand-rolled its
// parse field by field and there was nothing to import; the route runs
// `safeParse` now, so the published shape and the parse are one object.
const aiProviderPatchRequest = aiProviderPatchSchema.meta({
  id: "AiProviderPatchRequest",
  description:
    "Partial update of the calling user's AI-provider configuration. An omitted key is left untouched; `null` (or an empty string, on the string fields) clears the column. At least one recognised key must be present, or the write is refused. Key material is write-only: it is encrypted on the way in and never returned. Unknown keys are ignored rather than refused — the object is deliberately not strict, so a client sending a field this server does not know yet is not broken by it.",
});

const aiTestRequest = aiTestOverrideSchema.meta({
  id: "AiTestRequest",
  description:
    "An UNSAVED provider selection to probe. Every field is optional and falls back to the stored configuration, so a user with a saved key can change only the model and test it without re-typing the credential. Nothing here is persisted. Strict: an unknown key is a 422.",
});

const aiTestResponse = z
  .union([
    z.object({
      ok: z.literal(true),
      providerType: z.string(),
      model: z.string().nullable(),
      tokensUsed: z.number().int().nullable(),
      sample: z
        .string()
        .describe(
          "First 200 characters of the provider's reply to the probe prompt. Model output, not a credential.",
        ),
    }),
    z.object({
      ok: z.literal(false),
      providerType: z.string(),
      reasonCode: z.enum([
        "credentials",
        "rate_limited",
        "server_error",
        "bad_request",
        "unreachable",
      ]),
      reason: z
        .string()
        .describe(
          "English fallback prose for the code. Secret-free by construction — the provider's own error body is logged server-side and never returned.",
        ),
      httpStatus: z
        .number()
        .int()
        .nullable()
        .describe(
          "The upstream status, when there was one. Null for a transport failure.",
        ),
    }),
  ])
  .meta({
    id: "AiTestResponse",
    description:
      "The probe outcome. Read `ok`, not the status code: a provider that answered and rejected the call is a 200 with `ok: false`.",
  });

// The shared-record profile summary. Deliberately bounded: allergies, family
// history and the current lifestyle facts, and nothing else. No settings, no
// AI configuration, no encrypted free text — which is what lets it be read
// under a `profile` grant.
const profileSummaryResponse = z
  .object({
    allergies: z
      .array(z.object({ substance: z.string(), category: z.string() }))
      .describe("Up to 25 live allergy records, newest first."),
    familyHistory: z
      .array(z.object({ condition: z.string(), relationship: z.string() }))
      .describe("Up to 25 live family-history entries, newest first."),
    facts: z
      .array(
        z.object({
          label: healthProfileFactKindSchema.describe(
            "The fact KIND, not a display label — the client localises it.",
          ),
          value: z
            .string()
            .describe(
              "The current value of that fact, e.g. `NEVER` / `FORMER` / `CURRENT` for smoking status.",
            ),
        }),
      )
      .describe(
        `Current lifestyle facts, at most one per kind (${HEALTH_PROFILE_FACT_KINDS.join(" / ")}). A kind with no current revision is OMITTED rather than reported as null, and so is one whose stored value could not be decrypted — the list is what is known, and absence is not distinguishable from unreadable here.`,
      ),
  })
  .meta({
    id: "ProfileSummary",
    description:
      "The bounded profile view a record viewer gets: allergies, family history and current lifestyle facts. Structurally incapable of becoming a Settings or AI surface.",
  });

export const profilePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/profile/summary": {
    get: {
      tags: ["Records"],
      summary: "Read the bounded shared-record profile summary",
      description:
        "The short profile a record viewer needs, and only that: allergies, family history, and the current lifestyle facts. It carries no settings, no AI configuration and no encrypted free text, which is why it can be served on a `profile` grant while the full profile cannot.\n\nRead-only, and delegable: under a switched session or an account selector the payload is the RECORD's, not the caller's.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The record's profile summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                profileSummaryResponse,
                "ProfileSummaryEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/ai/test": {
    post: {
      tags: ["Auth"],
      summary: "Probe the AI provider connection",
      description:
        "Sends a tiny fixed prompt to the resolved provider and reports whether it answered. The body is OPTIONAL: with no body the saved configuration is tested; with one, the unsaved selection is tested without touching the user row, so the settings surface can verify a credential before persisting it. Plaintext keys sent this way are never stored.\n\n**This route never returns 5xx, and that is deliberate.** A 5xx from the origin is rewritten to an HTML error page by a reverse proxy or CDN, and the client's `res.json()` then dies on `<!DOCTYPE`. So a provider failure comes back as **200 with `ok: false`** plus a categorised, secret-free `reasonCode`. Branch on `ok`, not on the status. The provider's own error text and body excerpt are logged for the operator and never put on the wire.\n\nThe probe is metered on the same daily AI budget every other AI surface writes to, because with an empty body it can resolve the OPERATOR's shared key — unmetered, that would be invisible spend on a surface that exists to answer 'are my settings right?'. A probe that fails is refunded.\n\nTwo ceilings: 5 per minute and 50 per day, per user.",
      requestBody: {
        required: false,
        content: { "application/json": { schema: aiTestRequest } },
      },
      responses: {
        "200": {
          description:
            "The probe ran. `ok: true` with the model's reply excerpt, or `ok: false` with the failure category — both are 200.",
          content: {
            "application/json": {
              schema: dataEnvelope(aiTestResponse, "AiTestEnvelope"),
            },
          },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "A body was sent with a `Content-Type` other than `application/json`. Sending no body at all is fine.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Nothing could be probed. Either the override body failed validation, or the resolved configuration is not usable — no provider selected, a required key or base URL missing, a model name missing for the gateway, ChatGPT OAuth not connected, or a base URL pointing at an internal host. The message names which.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "One of three ceilings: 5 probes per minute, 50 per day, or the account's daily AI token budget is exhausted. The message distinguishes them.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/user/ai-provider": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's AI-provider configuration",
      description:
        "Returns the user's selected provider/model/baseUrl (plus the OpenAI-compatible gateway's own base URL and model) and the effective availability: `aiAvailable` is true when any provider can serve the user (BYOK, self-hosted, or the operator's server-managed key), and `managedBy` reports which. iOS gates Coach visibility off these two fields. Key material is reported as presence + a 4-char masked preview only.",
      responses: {
        "200": {
          description: "Resolved AI-provider configuration.",
          content: {
            "application/json": {
              schema: dataEnvelope(aiProviderResponse, "GetAiProviderResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update the calling user's AI-provider configuration",
      description:
        "Partial update — an omitted key is left untouched, an explicit `null` (or an empty string, on the string fields) clears the column. Key material is write-only: it is encrypted at rest on the way in and the read never gives it back, only presence plus a four-character preview.\n\nOne implicit write is worth knowing about: switching `provider` to anything other than LOCAL, without naming `baseUrl` in the same request, CLEARS the stored base URL. The column is shared across providers, so leaving it would send a cloud key to a host that was configured for a self-hosted backend.\n\nA base URL — for LOCAL or for the OpenAI-compatible gateway — runs the SSRF floor: a private or internal host is refused unless the operator allowlisted that exact hostname on this instance.\n\nThe response is a bare `{ updated: true }` acknowledgement. It does not echo the resolved configuration, so a client that needs the new state re-reads the GET.\n\nA wrongly-typed value is refused, not skipped. Until this release the route inspected the body field by field with `typeof` guards, so a numeric `model` or a boolean `baseUrl` was dropped in silence and the write went ahead without it; a body of nothing but such keys came back as 'No valid fields' naming none of them. It runs the standard Zod parse now and answers the multi-issue 422 with the offending path.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: aiProviderPatchRequest } },
      },
      responses: {
        "200": {
          description:
            "Saved. The body is the fixed acknowledgement, not the resolved configuration.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ updated: z.literal(true) }),
                "PatchAiProviderResponse",
              ),
            },
          },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Nothing was written. A body that failed validation carries the multi-issue list under `details.issues` with `meta.errorCode` = `ai_provider.invalid` — a wrongly-typed field, a `provider` outside the five, or a `responseTimeoutSeconds` that is not an integer in 10–600 all land there and name their path. Two single-message cases stay outside that list because they are not shape failures: no recognised field was present at all (`meta.errorCode` = `ai_provider.no_fields`), and a base URL pointing at an internal or private host the operator has not allowlisted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/auth/me/coach-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach prompt-tuning preferences",
      description:
        "Returns the persisted preferences with defaults filled in. Null persisted state resolves to the legacy v1.4.22 defaults.",
      responses: {
        "200": {
          description: "Resolved preferences plus the `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsResponse, "GetCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user Coach prompt-tuning preferences",
      description:
        "Persists the supplied prefs. Body is validated against `CoachPrefs`; missing keys fall back to the documented defaults. Supports optimistic concurrency: echo the `updatedAt` from the last read as `baseUpdatedAt` and the write is refused with 409 if the row changed since; omit it for the legacy unconditional write.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: coachPrefsPutRequest } },
      },
      responses: {
        "200": {
          description: "Saved preferences echoed back with the fresh token.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsResponse, "PutCoachPrefsResponse"),
            },
          },
        },
        ...conflictResponse409("Coach preferences", "coach_prefs_conflict"),
        ...stdResponses,
        ...malformedJsonResponse,
        ...invalidBaseTokenResponse,
      },
    },
  },
  "/api/auth/me/disable-coach": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach opt-out flag",
      description:
        'Returns the user\'s per-account Coach opt-out flag. Default `false` (Coach visible). Powers the Settings → Insights "Hide Coach" Switch and the layout FAB short-circuit.',
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(disableCoachFlag, "GetDisableCoachResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user Coach opt-out flag",
      description:
        "Flips the per-account Coach opt-out flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disableCoachFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disableCoachFlag,
                "PatchDisableCoachResponse",
              ),
            },
          },
        },
        ...stdResponses,
        ...malformedJsonResponse,
      },
    },
  },
  "/api/auth/me/diabetes": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user diabetes opt-in flag",
      description:
        'Returns the user\'s per-account diabetes opt-in flag. Default `false`. When `true`, the glucose target resolver applies the tighter ADA glycemic GOAL bands (fasting 80–130, postprandial < 180) instead of the general non-diabetic bands. Powers the Settings "I have diabetes / clinician glucose targets" toggle. Never inferred from a reading; asserts no diagnosis.',
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(diabetesFlag, "GetDiabetesResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user diabetes opt-in flag",
      description:
        "Sets the per-account diabetes opt-in flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Always returns the resolved next-state. `userId` is never accepted from the body. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: diabetesFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(diabetesFlag, "PatchDiabetesResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/health-score-config": {
    get: {
      tags: ["Auth"],
      summary: "Read which pillars count toward the Health Score",
      description:
        "v1.35.0 — the resolved composition: which pillars count, which the person took out, whether they have chosen at all, and the recipe version. An account that never chose reads every pillar with `hasSelection: false` and `version: 0`, which is exactly what its number was already built from — there is no backfill because there is nothing to back-fill.",
      responses: {
        "200": {
          description:
            "The resolved composition. `updatedAt` is absent until a selection has been stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthScoreConfigResponse,
                "HealthScoreConfigEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Choose which pillars count toward the Health Score",
      description:
        "Replaces the recipe with the given positive selection and bumps the per-user recipe version by one. Since v1.38 the empty selection is the only one refused: three distinct areas of health are what the score RECOMMENDS, not what it requires, so a one-area or two-area recipe saves and produces a score that labels its own breadth (`scoreBasis`). Blood pressure, glucose and cholesterol are still three pillars in one area — that now decides what the score says about itself rather than whether it exists. Accepting the write also evicts the account's score caches, so the next read reflects the new composition rather than the previous hour's number. Optimistic concurrency: send `baseUpdatedAt` from a prior read and the write 409s if the recipe moved since; omit it for the unconditional write. Rate-limited to 60 writes per minute per user.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthScoreConfigPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The stored composition, echoed back with the incremented `version` and the advanced `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthScoreConfigResponse,
                "PatchHealthScoreConfigEnvelope",
              ),
            },
          },
        },
        ...conflictResponse409(
          "Score selection",
          "health_score_config_conflict",
        ),
        ...stdResponses,
        // Four distinct 422s on one route, so this one is written out
        // rather than reusing the shared base-token response: a client
        // branching on `meta.errorCode` needs to see all of them, and a
        // description that named only the token would be a contract that
        // quietly omits the refusal a person actually hits.
        "422": {
          description:
            "The write was refused and nothing was stored. `meta.errorCode` distinguishes the cases: `health_score_config.too_narrow` — the selection cannot produce a score (`meta.reason` is `no_pillars_selected`, and the `error` string is the sentence to show the person). Since v1.38 the empty selection is the ONLY one refused: two areas of health, or one, now save and produce a score that labels its own breadth, so a client must not pre-empt the write with a three-area rule of its own. `health_score_config.invalid` — the body failed validation, with the per-issue list under `details.issues`; `invalid_base_updated_at` — `baseUpdatedAt` was present but unparseable, `null` included, which is rejected rather than falling back to the unconditional write. A body that is not JSON at all returns the bare message `health-score-config.body.invalid_json` with no errorCode.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/auth/me/modules": {
    get: {
      tags: ["Auth"],
      summary: "Read the resolved per-user module enable/disable map",
      description:
        "Returns the fully-resolved `{ <moduleKey>: boolean }` map for every toggleable module. `cycle` reflects the cycle gate, `coach` reflects the resolved per-user opt-out + operator master flag, and the rest read the per-user disabled-allowlist (`modulePreferencesJson`). Default-on: a fresh account reads every module enabled. iOS/web read this to hide a whole module surface end-to-end.",
      responses: {
        "200": {
          description: "Resolved module map.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moduleMapEnvelopeInner,
                "GetModulesResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update per-user module enable/disable preferences",
      description:
        "Merges the supplied keys into the persisted disabled-allowlist (`modulePreferencesJson`) field-by-field — a PATCH touching only one module leaves the siblings intact. Refuses to disable a core module (`weight`, `bloodPressure`, `pulse`, `medications`) or any unknown key with a 422. `userId` is never accepted from the body. Always returns the fully-resolved next-state map so clients can hard-set their optimistic update. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: modulePrefsPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state module map echoed back with the fresh `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moduleMapEnvelopeInner,
                "PatchModulesResponse",
              ),
            },
          },
        },
        ...conflictResponse409("Module preferences", "modules_conflict"),
        ...stdResponses,
        ...malformedJsonResponse,
        ...invalidBaseTokenResponse,
      },
    },
  },
  "/api/auth/me/source-priority": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user source priority",
      description:
        "Returns the per-metric-class source priority used by the analytics aggregator. Missing keys fall back to `DEFAULT_SOURCE_PRIORITY`. Null persisted state resolves to the documented defaults.",
      responses: {
        "200": {
          description: "Resolved priority.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "GetSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user source priority",
      description:
        "Persists the supplied priority. Body is validated against `SourcePriority`; missing keys read as `DEFAULT_SOURCE_PRIORITY` at the call site.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: sourcePrioritySchema } },
      },
      responses: {
        "200": {
          description: "Saved priority (defaulted) echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "PutSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
        ...malformedJsonResponse,
      },
    },
  },
  "/api/user/avatar": {
    post: {
      tags: ["Auth"],
      summary: "Upload the calling user's avatar",
      description:
        "Multipart upload (field `file`). Accepts image/jpeg, image/png, image/webp; rejects anything else at the magic-byte sniff (the multipart Content-Type header is informational only). Hard caps: 2 MiB body, 2048×2048 dimensions. Replaces the v1.4.22 Gravatar leak by storing the bytes on the User row + serving them from same-origin.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "Binary image payload (JPEG / PNG / WebP). Hard-capped at 2 MiB and 2048×2048.",
                ),
            }),
          },
        },
      },
      responses: {
        "201": {
          description:
            "Avatar saved. `avatarUrl` is the same value the /me payload returns; the `?v=` suffix busts client caches on re-upload.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  avatarUrl: z.string(),
                  contentType: z.enum([
                    "image/jpeg",
                    "image/png",
                    "image/webp",
                  ]),
                  updatedAt: z.iso.datetime({ offset: true }),
                }),
                "UploadAvatarResponse",
              ),
            },
          },
        },
        "413": {
          description:
            "Upload exceeds the 2 MiB byte limit or the 2048×2048 dimension limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "Image format is not one of JPEG / PNG / WebP (magic-byte sniff).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Clear the calling user's avatar",
      description:
        "Resets the avatar columns to null. Idempotent — a delete on an already-empty row returns 204 with no audit-log row.",
      responses: {
        "204": {
          description: "Avatar cleared (or already empty).",
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar/{id}": {
    get: {
      tags: ["Auth"],
      summary: "Serve a user's avatar bytes",
      description:
        "Owner-scoped. The `{id}` path segment must match the calling user's id — cross-user reads return 403. Response body is the raw image bytes with the persisted `Content-Type`; the /me payload appends `?v={updatedAtMs}` so clients can cache aggressively.",
      requestParams: {
        path: z.object({
          id: z.string().describe("User id (must match the calling user)."),
        }),
      },
      responses: {
        "200": {
          description: "Avatar bytes.",
          content: {
            "image/jpeg": { schema: z.string().describe("Raw JPEG bytes.") },
            "image/png": { schema: z.string().describe("Raw PNG bytes.") },
            "image/webp": { schema: z.string().describe("Raw WebP bytes.") },
          },
        },
        "403": {
          description: "Caller is not the avatar's owner.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "The user has no uploaded avatar.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/profile": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's profile",
      description:
        "Flattened profile fields for the native client. Aliased over the same data exposed by /api/auth/me. The KVNR is decrypted server-side; the IKNR (v1.8.6) is returned plaintext.",
      responses: {
        "200": {
          description: "The calling user's profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(profileResponse, "GetProfileResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update the calling user's profile",
      description:
        "Partial profile update — every field is optional. An explicit null (or empty string) clears a field. A non-empty `insurerIkNumber` must be exactly 9 digits (422 otherwise); a non-empty `insuranceNumber` (KVNR) must pass the mod-10 check. `userId` is never accepted from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: profileUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Saved profile echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                profileUpdateResponse,
                "PatchProfileResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/notification-prefs": {
    get: {
      tags: ["Notifications"],
      summary: "Read per-user notification preferences",
      description:
        "Returns the fully-resolved preferences with the documented defaults filled in. A null persisted row resolves to the defaults (server-managed reminders, low-stock threshold 7 days, mood reminder 22:00, Coach nudges on).",
      responses: {
        "200": {
          description: "Resolved preferences plus the `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                notificationPrefsResponse,
                "GetNotificationPrefsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Notifications"],
      summary: "Update per-user notification preferences",
      description:
        'Deep-merges the supplied partial shape over the persisted row — a PATCH touching only one category leaves the siblings intact. Always returns the fully-resolved next state so clients can hard-set their optimistic update. `medication.clientManaged: true` (or `deliveryDefault: "client"`) suppresses server-side MEDICATION_REMINDER APNs; `medication.lowStockRunwayDays` (1–60, nullable, default 7) tunes the low-stock alert — null switches it off. Rate-limit 60/min per user.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: notificationPrefsPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state preferences echoed back with the fresh `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                notificationPrefsResponse,
                "PatchNotificationPrefsResponse",
              ),
            },
          },
        },
        ...conflictResponse409(
          "Notification preferences",
          "notification_prefs_conflict",
        ),
        ...stdResponses,
        ...malformedJsonResponse,
        ...invalidBaseTokenResponse,
      },
    },
  },
  "/api/auth/me/report-selection": {
    get: {
      tags: ["Auth"],
      summary: "Read the owner's saved doctor-report selection",
      description:
        "Returns the saved report-scope profile, or `profile: null` when the account has never saved one (or the stored blob no longer parses against the current leaf catalogue). Replaces the retired `GET /api/auth/me/doctor-report-prefs`. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The saved profile, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportSelectionGetResponse,
                "GetReportSelectionResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace the owner's saved doctor-report selection",
      description:
        "Replace, not merge — the body states the whole scope or it is not a scope; a leaf omitted from the body is a leaf removed from the saved profile. An unknown leaf id is refused with a 422 carrying `meta.errorCode` `report-selection.leaves.unknown` and `meta.unknownLeaves`, the ids this build does not know. The saved selection is also what the FHIR REST face and the MCP doctor-visit surfaces replay for a caller that cannot ask a human, so every write is audit-logged. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: savedReportProfile } },
      },
      responses: {
        "200": {
          description: "The saved profile, echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportSelectionPutResponse,
                "PutReportSelectionResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...malformedJsonResponse,
      },
    },
  },
  // ── Appended: preference surfaces the iOS client calls that the registry
  // never carried. All four take a cookie session or a wildcard Bearer token
  // (`requireAuth()` with no declared scope), none are delegable — a request
  // that attaches an account selector is refused before the handler runs — and
  // every PATCH/PUT is a hard-set that answers with the resolved next state, so
  // a client replaces its optimistic value rather than re-reading.
  "/api/auth/me/unit-preference": {
    get: {
      tags: ["Auth"],
      summary: "Read the metric/imperial display preference",
      description:
        "Which branch of the display-time transform registry the client should render (km/h vs mph, km vs mi). Canonical storage stays SI on every measurement row — this changes presentation only, and never what was written. Any stored value other than `imperial` resolves to `metric`, including a null on an account that predates the column.",
      responses: {
        "200": {
          description: "The resolved preference.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                unitPreferenceResponse,
                "GetUnitPreferenceEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the metric/imperial display preference",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "The body is capped at 1 KB and must carry `Content-Type: application/json`. Anything larger is 413, a wrong content type is 415, and a body that is not JSON at all is 400 — the same three the other scalars in this group answer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: unitPreferencePatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The resolved next preference.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                unitPreferenceResponse,
                "PatchUnitPreferenceEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/glucose-unit": {
    get: {
      tags: ["Auth"],
      summary: "Read the blood-glucose display unit",
      description:
        "Which unit blood-glucose readings are rendered in — `mg/dL` or `mmol/L`. A separate choice from the metric/imperial preference, because metric countries are split on which one they read glucose in. Canonical storage is mg/dL on every reading and every ingest path; this changes presentation only. Any stored value other than `mmol/L` resolves to `mg/dL`, including a null on an account that never set it.",
      responses: {
        "200": {
          description: "The resolved unit.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                glucoseUnitResponse,
                "GetGlucoseUnitEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the blood-glucose display unit",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "Nothing already stored is converted or reinterpreted: readings stay mg/dL, and a value typed into the entry form in mmol/L is inverted to mg/dL before it is written.\n\n" +
        "The body is capped at 1 KB and must carry `Content-Type: application/json`. Anything larger is 413, a wrong content type is 415, and a body that is not JSON at all is 400 — the same three the other scalars in this group answer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: glucoseUnitPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The resolved next unit.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                glucoseUnitResponse,
                "PatchGlucoseUnitEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/documents-auto-ai-read": {
    get: {
      tags: ["Auth"],
      summary: "Read the automatic document-reading opt-in",
      description:
        "Whether the auto-index-on-upload job may read a freshly uploaded document through the account's configured external provider with no per-document tap. OFF by default and off for any account that has never set it: the vault is local-first and every egress otherwise needs an explicit action plus an active consent receipt.",
      responses: {
        "200": {
          description: "The current flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                documentsAutoAiReadResponse,
                "GetDocumentsAutoAiReadEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the automatic document-reading opt-in",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "Turning it ON does two further things a caller should expect. It is itself the standing consent act, so the write appends an `ai_full` `ConsentReceipt` — the same receipt POST /api/consent/ai/web mints, and one DELETE /api/consent/ai/latest revokes without touching this flag. And a genuine OFF→ON flip schedules a bounded catch-up over the documents already in the vault, because the summary job is enqueued at upload time and would otherwise only ever apply to future uploads. The catch-up is fire-and-forget and re-runs every consent and budget gate per document.\n\n" +
        "The body cap here is 1 KB, far tighter than the 64 KB its siblings allow — a payload above it is refused with 413 rather than parsed.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: documentsAutoAiReadPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The resolved next flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                documentsAutoAiReadResponse,
                "PatchDocumentsAutoAiReadEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/injection-site-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read the user-level injection-site deny-list",
      description:
        "Sites the account never wants offered. The list is a DENY, and deny wins everywhere: a site here is dropped from every medication's injection-site picker and refused at intake with 422, even when that medication names it among its preferred sites.",
      responses: {
        "200": {
          description: "The current deny-list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                injectionSitePrefsResponse,
                "GetInjectionSitePrefsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Replace the user-level injection-site deny-list",
      description:
        "Replace, not merge — the body states the whole list, and an empty array clears the exclusion. Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user.\n\n" +
        "The stored list is deduplicated and re-ordered into the canonical enum order before it is written, so the response can differ from the body that produced it while describing the same set. Take the response as the state.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: injectionSitePrefsPatchRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The resolved next deny-list, deduplicated and in canonical order.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                injectionSitePrefsResponse,
                "PatchInjectionSitePrefsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/thresholds": {
    get: {
      tags: ["Analytics"],
      summary: "Read the effective metric ranges and the caller's overrides",
      description:
        "Every threshold metric with its resolved traffic-light band, whether that band came from an override, the unmodified computed default beside it, and the metric's physiological bounds — so a settings surface can show current-versus-default and validate an edit without a second call.\n\n" +
        "`range` and `default` are nullable: a metric whose default is derived from profile data the account has not supplied (height for weight, date of birth and gender for body fat) has no band to resolve until that data exists.",
      responses: {
        "200": {
          description: "Effective ranges plus the stored overrides.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                thresholdsGetResponse,
                "GetThresholdsEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "The authenticated user row could not be loaded. In practice unreachable — the session that resolved the caller was validated against that row.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Analytics"],
      summary: "Set threshold overrides for one or more metrics",
      description:
        "MERGE, not replace, and it is the one write on this surface that behaves that way: the body is a partial map and only the metrics it names are touched. A metric omitted keeps whatever override it already had. To remove one, use DELETE with `?metric=` — sending it back as an absent key does nothing.\n\n" +
        "Each range must sit inside that metric's physiological bounds with `min` strictly below `max`, and an unknown metric key is refused rather than ignored (the schema is strict). Rate-limited 30 / 5 min per user; audit-logged with the before and after maps. The response carries the merged override map, not the recomputed effective ranges — re-read the GET for those.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: thresholdsUpdateRequest } },
      },
      responses: {
        "200": {
          description: "The merged override map.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                thresholdsOverridesResponse,
                "PutThresholdsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Analytics"],
      summary: "Reset one threshold override, or all of them",
      description:
        'With `?metric=` it drops that metric\'s override; WITHOUT the parameter it drops EVERY override on the account. The wide form is not reachable by omitting the parameter alone — it requires `{ "confirm": "RESET_THRESHOLDS" }` in the body, the same typed-confirmation shape account deletion and the data reset use. The `?metric=` form takes no body and is unchanged.\n\n' +
        "Audit-logged with the before and after maps. Rate-limited 30 / 5 min per user, matching the PUT.",
      requestParams: {
        query: z.object({
          metric: thresholdMetricEnum
            .optional()
            .describe(
              "The single metric to reset. Omit to reset every override on the account — which then requires the confirmation body.",
            ),
        }),
      },
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: thresholdsResetAllRequest },
        },
      },
      responses: {
        "200": {
          description: "The remaining override map.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                thresholdsOverridesResponse,
                "DeleteThresholdsEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "`metric` was present but is not a known threshold metric. Nothing was reset.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        // After `stdResponses` on purpose: the generic 422 there would
        // otherwise overwrite this one and the confirmation contract would
        // vanish from the published operation.
        "422": {
          description:
            '`metric` was omitted and the body did not carry `{ "confirm": "RESET_THRESHOLDS" }`. Nothing was reset.',
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },

  // ── Appended: registered devices, the last two scalar prefs, and the
  // locale / timezone setters.
  "/api/auth/me/devices": {
    get: {
      tags: ["Auth"],
      summary: "List the account's registered devices",
      description:
        "The devices this account has registered for push, newest activity first. Identifying metadata only: no push tokens, no APNs identifiers, no IP addresses — nothing here can be replayed to send a notification.\n\n" +
        "`isCurrent` is not taken on trust. A caller may send `X-Device-Id`, but the badge is only set when that device also holds an unrevoked refresh token for this account, so a forged header cannot move it. A cookie caller has no such anchor and correctly sees `false` on every row.",
      responses: {
        "200": {
          description: "Registered devices, most recently seen first.",
          content: {
            "application/json": {
              schema: dataEnvelope(deviceListResponse, "DeviceListEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/devices/{id}": {
    patch: {
      tags: ["Auth"],
      summary: "Set a device's medication-reminder delivery override",
      description:
        "Chooses where this one device's medication reminders come from: `server` for server-side dispatch, `client` to leave it to the app's own local reminders, or `null` to clear the override and inherit the account default. Scoped to the caller — a foreign id is 404, never another account's row.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: devicePatchRequest } },
      },
      responses: {
        "200": {
          description: "The device's resolved override.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  medicationDelivery: deviceDeliverySchema,
                }),
                "DevicePatchEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "No such device for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Revoke a device and every credential bound to it",
      description:
        "Deletes the device row and, in the same transaction, revokes every unrevoked refresh token bound to it plus the access tokens those refresh rows pair with. The counts come back so a client can say what was actually killed. One transaction on purpose: a partial cascade would leave a live device row whose tokens are all dead.\n\n" +
        "This does NOT touch browser sessions. A session lives on its own row, not on a device, so signing a browser out is /api/auth/logout or the session list — the two surfaces cover different blast radii. Re-pairing later creates a fresh device row rather than reviving this one.\n\n" +
        "Scoped to the caller: a foreign id answers 404 rather than confirming the id exists.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Device removed and its credentials revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deviceRevokeResponse,
                "AccountDeviceRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "No such device for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/labs-local-ocr": {
    get: {
      tags: ["Auth"],
      summary: "Read the browser-side OCR opt-in",
      description:
        "Whether a lab-report scan should be transcribed on the device before anything is sent. It exists for the provider chains that cannot read an image at all — a text-only model, or the ChatGPT-OAuth path — so a person on one of those can still scan a paper report. The raw image never leaves the device in this mode; only the extracted text does. Less accurate than native vision, which is why the review screen stays mandatory either way.",
      responses: {
        "200": {
          description: "The current flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                labsLocalOcrResponse,
                "GetLabsLocalOcrEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the browser-side OCR opt-in",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user; body capped at 1 KB.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: labsLocalOcrPatchRequest } },
      },
      responses: {
        "200": {
          description: "The resolved next flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                labsLocalOcrResponse,
                "PatchLabsLocalOcrEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/use-central-codex": {
    get: {
      tags: ["Auth"],
      summary: "Read the shared-Codex opt-in",
      description:
        "Whether this account's provider chain gains a trailing entry for the operator's own ChatGPT subscription. OFF by default.",
      responses: {
        "200": {
          description: "The current flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                useCentralCodexResponse,
                "GetUseCentralCodexEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Set the shared-Codex opt-in",
      description:
        "Hard-set, idempotent, audit-logged. Rate-limited 60 / min per user; body capped at 1 KB.\n\n" +
        "Worth being plain about what turning it on does and does not do. The shared account is external, shared with every other user who opts in, bound by the operator's rate limits, and trains on its input by default. But the entry is server-managed, so the AI consent gate still applies: flipping this ON egresses nothing by itself, and without an active consent receipt nothing will leave for it.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: useCentralCodexPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The resolved next flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                useCentralCodexResponse,
                "PatchUseCentralCodexEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 1024 bytes. Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/locale": {
    put: {
      tags: ["Auth"],
      summary: "Set the interface language",
      description:
        "Writes the account's UI language and mirrors it into the locale cookie via `Set-Cookie`. Both halves matter: the column is what server-side work reads when there is no request to take a cookie from — a scheduled nudge, a Telegram message — and without it those went out in English however the person reads the app. The server-set cookie outlives the client-written one, which some browsers cap at seven days.\n\n" +
        "An ACTOR surface, and the clearest case for that mode existing: the interface language belongs to the person reading the screen, never to the record on it. Under a record scope this would write a delegate's choice onto the owner's row and then mail the owner in a language they may not read. A request that attaches the per-request account selector (the `AccountSelector` header parameter) is refused with 403 `sharing.not_permitted`. It keeps answering while a switch is on rather than merely refusing safely, because the language switcher fires a mount-time backfill on every page load.\n\n" +
        "Idempotent: when the column already matches, the write is skipped and only the cookie is refreshed. Body capped at 4 KB.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: localePutRequest } },
      },
      responses: {
        "200": {
          description: "The accepted locale.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ locale: z.enum(locales) }),
                "LocalePutEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "A selector header was attached to an actor surface (`meta.errorCode` = `sharing.not_permitted`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/timezone": {
    put: {
      tags: ["Auth"],
      summary: "Set the account timezone",
      description:
        "Lifted out of the profile patch so the picker can send one field without round-tripping the rest. Accepts any zone the running engine's `Intl` knows; anything else is 422 rather than stored, so the resolver never has to defend against a poisoned column. Audit-logged with the old and new zone.\n\n" +
        "A change is not only a display preference. The medication-compliance rollup keys its rows by the LOCAL day a dose fell on, minted under whatever zone was in force at write time, so moving the zone re-buckets that history and the stored keys go stale — and the coverage probe compares counts rather than keys, so it cannot notice. The route therefore enqueues a re-fold of the trailing window whenever the zone actually changes. Best-effort and de-duplicated, so rapid re-picks collapse into one.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: timezonePutRequest } },
      },
      responses: {
        "200": {
          description: "The accepted timezone.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ timezone: z.string() }),
                "TimezonePutEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/passkey-nudge/dismiss": {
    post: {
      tags: ["Auth"],
      summary: "Dismiss the add-a-passkey nudge",
      description:
        "Permanently hides the prompt that suggests adding a passkey. Cookie-only, takes no body, idempotent — dismissing twice is a success. The flag is also readable as `passkeyNudgeDismissed` on GET /api/auth/me/mfa.",
      responses: {
        "200": {
          description: "Nudge dismissed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ dismissed: z.literal(true) }),
                "PasskeyNudgeDismissEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
