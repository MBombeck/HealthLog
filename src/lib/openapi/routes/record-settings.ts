/**
 * OpenAPI route table — the managed record's own configuration.
 *
 * A Guardian acting on a managed record reads and writes that record's
 * settings here, never through `/api/auth/me`: the actor's identity payload
 * stays the actor's while the browser is pointed at somebody else's record, and
 * conflating the two is how a Guardian's own locale ends up written onto a
 * child's profile. Every response names the record it describes for the same
 * reason.
 *
 * These paths carry `recordRefusal()` rather than the local `sharingRefusal`
 * the grant-lifecycle module uses, and the difference is load-bearing: this is
 * the one tree in the application fenced by `requireGuardianAuth`, so
 * `src/__tests__/openapi-sharing-denial.test.ts` holds every operation here to
 * the byte-identical shared refusal sentence. Copying the neighbouring
 * module's wording into this one fails that guard.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The PATCH
 * bodies come from `src/lib/record-settings/configuration.ts` — the same strict
 * objects the handler parses — so a published field the route would 422 cannot
 * drift into the contract.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { METRIC_BOUNDS } from "@/lib/analytics/effective-range";
import { MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS } from "@/lib/record-settings";
import {
  dataEnvelope,
  errorEnvelope,
  recordRefusal,
  stdResponses,
} from "./shared";

const thresholdMetricEnum = z
  .enum(Object.keys(METRIC_BOUNDS) as [string, ...string[]])
  .describe("A metric that carries a user-overridable traffic-light range.");

const settingsFamilyEnum = z
  .enum([
    "profile",
    "modules",
    "notifications",
    "thresholds",
    "coach",
    "insights",
  ])
  .describe(
    "The closed set of configuration families a Guardian may read and write on a managed record. Identity, credentials, delivery channels, Coach memories and provider connections are absent by construction — no family accepts them, so every future field fails closed until one deliberately does.",
  );

const recordSettingsResponse = z
  .object({
    record: z.object({
      id: z.string(),
      displayName: z
        .string()
        .describe("Empty string when the record has no display name set."),
      locale: z.string().nullable(),
      timezone: z.string(),
      kind: z
        .literal("managed")
        .describe(
          "Always `managed`. The endpoint exists only for managed records; there is no owner-record arm.",
        ),
    }),
  })
  .meta({
    id: "RecordSettingsResponse",
    description:
      "The active managed record's configuration identity. Deliberately a distinct DTO rather than another actor field on `/api/auth/me`.",
  });

const recordSettingsIntegrationsResponse = z
  .object({
    recordId: z.string(),
    integrations: z
      .array(
        z.object({
          integration: z.enum([
            "withings",
            "whoop",
            "fitbit",
            "nightscout",
            "polar",
            "oura",
            "google-health",
            "strava",
          ]),
          state: z.enum([
            "connected",
            "error_transient",
            "error_reauth",
            "disconnected",
            "parked",
          ]),
          lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
          lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
        }),
      )
      .describe(
        "All eight providers, always, in the fixed order withings, whoop, fitbit, nightscout, polar, oura, google-health, strava. Note the order differs from the owner's own `/api/integrations/status` envelope.",
      ),
  })
  .meta({
    id: "RecordSettingsIntegrationsResponse",
    description:
      "Whether the managed record's integrations are connected, and nothing else. Deliberately no control and no credential projection — OAuth and provider state cannot safely carry a record selector, so a Guardian can see that a pipe exists but cannot connect, disconnect, probe or resume it from here. A provider with no real credential reads `disconnected` even when its ledger row says otherwise, because a synthesised healthy ledger is not proof of a connection.",
  });

// ── The six family DTOs ──────────────────────────────────────────────

const profileSettings = z
  .object({
    displayName: z.string().nullable(),
    heightCm: z.number().nullable(),
    dateOfBirth: z.iso
      .date()
      .nullable()
      .describe("Calendar date (`YYYY-MM-DD`), not an instant."),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
    locale: z.enum(["de", "en", "es", "fr", "it", "pl", "ko"]).nullable(),
    timezone: z.string(),
    unitPreference: z.enum(["metric", "imperial"]),
    timeFormat: z.enum(["AUTO", "H12", "H24"]),
    dateFormat: z.enum(["AUTO", "DMY", "MDY", "YMD"]),
  })
  .meta({ id: "RecordProfileSettings" });

const moduleSettings = z
  .object({
    modulePreferences: z
      .record(z.string(), z.boolean())
      .describe(
        "Every directly-owned module key, always present, with the registry default filled in for keys the record has never persisted — so a Guardian administers the whole supported surface rather than only what happens to be stored.",
      ),
  })
  .meta({ id: "RecordModuleSettings" });

const notificationSettings = z
  .object({
    moodReminderEnabled: z.boolean(),
    notificationPreferences: z.object({
      medication: z.object({
        lowStockRunwayDays: z.number().int().nullable(),
        reorderLeadDays: z.number().int(),
      }),
      mood: z.object({ reminderHour: z.number().int() }),
    }),
  })
  .meta({
    id: "RecordNotificationSettings",
    description:
      "Reminder timing and low-stock thresholds only. Delivery ownership is the actor's personal choice and is not here: a Guardian cannot route a managed record's notifications to their own phone or channel.",
  });

const trafficRange = z.object({
  greenMin: z.number(),
  greenMax: z.number(),
  orangeMin: z.number(),
  orangeMax: z.number(),
});

const thresholdSettings = z
  .object({
    overrides: z
      .record(
        thresholdMetricEnum,
        z.object({ min: z.number(), max: z.number() }),
      )
      .describe(
        "Only the metrics the record has actually overridden. A metric absent here uses the computed default.",
      ),
    effective: z
      .record(
        thresholdMetricEnum,
        z.object({
          range: trafficRange
            .nullable()
            .describe("Resolved range: the override if set, else the default."),
          isOverride: z.boolean(),
          default: trafficRange
            .nullable()
            .describe(
              "The unmodified computed default, so a client can show the diff. Null when no default can be computed — a weight range needs a height, an age-banded range needs a date of birth.",
            ),
          bounds: z.object({
            min: z.number(),
            max: z.number(),
            unit: z.string(),
          }),
        }),
      )
      .describe(
        "Every threshold metric, always, whether overridden or not — this is the resolved view a client renders without recomputing anything.",
      ),
  })
  .meta({ id: "RecordThresholdSettings" });

const coachSettings = z
  .object({
    disableCoach: z.boolean(),
    preferences: z.object({
      tone: z.string(),
      verbosity: z.string(),
      excludeMetrics: z.array(z.string()),
      defaultWindow: z.string(),
      dataClusters: z
        .array(z.string())
        .optional()
        .describe("Absent when the record has never set it."),
    }),
  })
  .meta({
    id: "RecordCoachSettings",
    description:
      "The Coach kill switch and the prompt-tuning subset a Guardian may set. A write to `preferences` also mirrors `excludeMetrics` onto the record's insights exclusion list, so the two cannot drift apart.",
  });

const insightsSettings = z
  .object({
    layout: z.object({
      version: z.number().int(),
      sections: z.array(
        z.object({
          id: z.string(),
          visible: z.boolean(),
          order: z.number().int(),
        }),
      ),
      tiles: z.array(
        z.object({
          id: z.string(),
          visible: z.boolean(),
          order: z.number().int(),
        }),
      ),
    }),
  })
  .meta({
    id: "RecordInsightsSettings",
    description:
      "The resolved insights layout. Unknown and legacy tile ids are normalised or dropped on read, and a newly-shipped tile is merged in default-visible, so the response is always the full current tile set rather than whatever was last persisted.",
  });

const recordSettingsFamilyResponse = z
  .object({
    recordId: z.string(),
    family: settingsFamilyEnum,
    settings: z
      .union([
        profileSettings,
        moduleSettings,
        notificationSettings,
        thresholdSettings,
        coachSettings,
        insightsSettings,
      ])
      .describe(
        "The DTO for the family in the path. Which variant arrives is determined entirely by `{family}`, so branch on `family` rather than probing the shape — OpenAPI cannot express the dependency between a path parameter and a response variant.",
      ),
  })
  .meta({
    id: "RecordSettingsFamilyResponse",
    description:
      "One family's settings for one managed record. Both the GET and the PATCH answer this same shape; the PATCH echo is the post-write state.",
  });

const recordSettingsPatchRequest = z
  .union([
    MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS.profile.meta({
      id: "RecordProfileSettingsPatch",
      description:
        "Partial profile edit. Every key is optional and an omitted key is untouched; a `null` on a nullable field clears it. Strict — an unknown key is a 422, which is what keeps the allowlist an allowlist.",
    }),
    MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS.modules.meta({
      id: "RecordModuleSettingsPatch",
      description:
        "Partial module toggle. `modulePreferences` is merged onto the record's current preferences; omitted keys keep their value. `cycleTrackingEnabled` is separate because `cycle` is a DELEGATED module: its state lives in the record's own cycle profile and `modulePreferences.cycle` is refused, so this is the field that turns cycle tracking on or off for the record — an explicit boolean overrides the default the record's sex would derive. Both fields are optional and at least one is required; an empty body is a 422 rather than a save that changed nothing.",
    }),
    MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS.notifications.meta({
      id: "RecordNotificationSettingsPatch",
      description:
        "Reminder timing and low-stock thresholds. No delivery-channel field exists here by design.",
    }),
    MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS.thresholds.meta({
      id: "RecordThresholdSettingsPatch",
      description:
        "Per-metric range overrides, merged onto the stored set. Each range must sit inside the metric's physiological bounds with `min` strictly below `max`. There is no clear arm: sending a metric replaces its override, and omitting it keeps the stored one.",
    }),
    MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS.coach.meta({
      id: "RecordCoachSettingsPatch",
      description:
        "The Coach kill switch and the prompt-tuning subset. `preferences` is merged onto the stored preferences, not replaced wholesale.",
    }),
    MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS.insights.meta({
      id: "RecordInsightsSettingsPatch",
      description:
        "The full insights layout. Unlike the other five families this one is a replacement rather than a merge.",
    }),
  ])
  .meta({
    id: "RecordSettingsPatchRequest",
    description:
      "The body for the family named in the path. Only that family's variant is accepted — sending the profile body to `/thresholds` is a 422, because every variant is strict. OpenAPI cannot tie the variant to the path parameter, so the union is the honest publication of six separate contracts sharing one URL shape.",
  });

const familyParameter = {
  name: "family",
  in: "path" as const,
  required: true,
  schema: {
    type: "string" as const,
    enum: [
      "profile",
      "modules",
      "notifications",
      "thresholds",
      "coach",
      "insights",
    ],
  },
  description:
    "Which configuration family to read or write. An unrecognised value is a 404 — and note that the family check runs BEFORE authentication, so an unknown family answers 404 to an unauthenticated caller where a known one would answer 401.",
};

export const recordSettingsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/record-settings": {
    get: {
      tags: ["Account sharing"],
      summary: "Read the active managed record's identity",
      description:
        "The record the session is currently acting on, named explicitly. This is not `/api/auth/me` with a different scope: that endpoint keeps reporting the actor throughout, and this one reports the record, so a client rendering a managed surface has an unambiguous source for each. Cookie session or Bearer, but only while acting on a managed record the caller guards.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The active managed record.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recordSettingsResponse,
                "RecordSettingsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/record-settings/integrations": {
    get: {
      tags: ["Account sharing"],
      summary: "Read the managed record's integration connection states",
      description:
        "Disclosure only: whether each of the record's integrations is connected and when it last succeeded. There is deliberately no control arm and no credential projection anywhere under this path — a Guardian cannot connect, disconnect, probe or resume a managed record's provider, because an OAuth flow cannot safely carry a record selector. Cookie session or Bearer, while acting on a managed record the caller guards.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Connection state per provider.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recordSettingsIntegrationsResponse,
                "RecordSettingsIntegrationsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/record-settings/{family}": {
    get: {
      tags: ["Account sharing"],
      summary: "Read one configuration family of the managed record",
      description:
        "Returns the named family's resolved settings for the record the session is acting on. Cookie session or Bearer, while acting on a managed record the caller guards.",
      parameters: [familyParameter],
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The family's settings.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recordSettingsFamilyResponse,
                "GetRecordSettingsFamilyEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "Either the path named a family outside the closed set, or the record row itself is gone. The two are not distinguished, and the first is answered before the caller is authenticated at all.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Account sharing"],
      summary: "Update one configuration family of the managed record",
      description:
        "Applies the family's patch and echoes the post-write state, so a client never needs a follow-up read. Five of the six families MERGE — an omitted key keeps its stored value; `insights` replaces the layout instead. The write is audited against the record with the acting Guardian recorded as the actor, and the changed key names ride the audit row. Body capped at 64 KiB. Cookie session or Bearer, while acting on a managed record the caller guards.",
      parameters: [familyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: recordSettingsPatchRequest },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The family's settings after the write.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recordSettingsFamilyResponse,
                "PatchRecordSettingsFamilyEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Body is not parseable JSON.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "The path named a family outside the closed set. Answered before authentication.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "Content-Type is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Validation failed against the family's strict schema, with every offending issue in the envelope rather than only the first. An unknown key lands here rather than being ignored — that is what makes the field allowlist enforceable.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
