/**
 * OpenAPI route table — populated incrementally.
 *
 * v1.4.23 baseline covers the routes the v1.5 iOS app touches end-to-end:
 *   - POST /api/auth/login
 *   - POST /api/auth/passkey/login-verify
 *   - POST /api/auth/refresh
 *   - GET  /api/measurements
 *   - POST /api/measurements
 *   - POST /api/measurements/batch    (W2 — Apple Health ingest)
 *   - POST /api/devices               (W3 — APNs registration)
 *   - GET  /api/insights/comprehensive
 *
 * Schemas come from `src/lib/validations/*` so the wire contract stays
 * single-source-of-truth. The `.meta()` annotations on each schema land
 * the title + description in `components.schemas.*` automatically.
 *
 * Routes are intentionally registered as inline operation objects
 * rather than via a wrapping helper — `zod-openapi`'s `createDocument`
 * type-checks the route table directly, which catches schema-shape
 * regressions at typecheck time.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createMeasurementSchema,
  listMeasurementsSchema,
  measurementTypeEnum,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";

/**
 * Common envelopes — every HealthLog API response wraps payload in
 * `{ data, error, meta? }`. The OpenAPI surface mirrors that contract
 * so iOS / external-ingest clients can decode uniformly.
 */
const errorEnvelope = z
  .object({
    data: z.null(),
    error: z.string(),
    meta: z
      .object({
        requestId: z.string().optional(),
        errorCode: z.string().optional(),
      })
      .optional(),
  })
  .meta({
    id: "ErrorEnvelope",
    description: "Standard error response: data is null, error is human prose.",
  });

function dataEnvelope<T extends z.ZodType>(payload: T, id: string) {
  return z
    .object({
      data: payload,
      error: z.null(),
      meta: z.object({ requestId: z.string().optional() }).optional(),
    })
    .meta({ id });
}

// ── Schemas — annotated for spec emission ────────────────────────────

measurementTypeEnum.meta({
  id: "MeasurementType",
  description:
    "DB-stored measurement category. v1.4.23 added 7 Apple Health values (HRV, resting HR, active energy, flights, walking/running distance, VO2 max, body temperature).",
});

measurementSourceEnum.meta({
  id: "MeasurementSource",
  description:
    "Origin of the measurement. v1.4.23 added APPLE_HEALTH for the iOS HealthKit batch ingest path.",
});

loginPasswordSchema.meta({
  id: "LoginPasswordRequest",
  description:
    "Email-or-username login. The native-client flow returns a paired access + refresh token when X-Client-Type: native or the iOS UA prefix is present.",
});

createMeasurementSchema.meta({
  id: "CreateMeasurementRequest",
  description:
    "Single-measurement ingest body. Plausibility-range guard runs server-side; out-of-range values fail 422.",
});

listMeasurementsSchema.meta({
  id: "ListMeasurementsQuery",
  description:
    "Query params for the measurements list endpoint. `limit` capped at 500.",
});

coachPrefsSchema.meta({
  id: "CoachPrefs",
  description:
    "Per-user Coach prompt-tuning preferences (v1.4.23 H4). All fields default to the legacy v1.4.22 behaviour when omitted.",
});

const coachMessageFeedbackBody = z
  .object({
    rating: z.enum(["helpful", "unhelpful"]),
    reason: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "CoachMessageFeedbackRequest",
    description:
      "Per-message helpful/unhelpful feedback (v1.4.23 H7). Optional `reason` is free-form prose, capped at 200 chars.",
  });

// ── Sub-schemas owned here (route-specific shapes) ───────────────────

const passkeyLoginVerifyRequest = z
  .object({
    challengeId: z
      .string()
      .min(1)
      .describe("Server-issued WebAuthn challenge id."),
    credential: z
      .object({
        id: z.string(),
        rawId: z.string(),
        type: z.literal("public-key"),
        response: z.record(z.string(), z.unknown()),
        authenticatorAttachment: z
          .enum(["platform", "cross-platform"])
          .optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      })
      .describe("SimpleWebAuthn-style assertion response payload."),
  })
  .meta({
    id: "PasskeyLoginVerifyRequest",
    description:
      "Passkey assertion verification. Same native-client token issuance as the password path.",
  });

const refreshRequest = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .describe("Caller-presented refresh token (`hlr_<64hex>`)."),
    revoke: z
      .boolean()
      .optional()
      .describe("When true, revoke the supplied token instead of rotating."),
  })
  .meta({
    id: "RefreshTokenRequest",
    description:
      "Exchange a one-time-use refresh token for a fresh access + refresh pair.",
  });

const accessRefreshBundle = z
  .object({
    user: z.object({ id: z.string(), username: z.string() }).optional(),
    token: z.string().describe("Access token (`hlk_<64hex>`)."),
    tokenExpiresAt: z.iso.datetime({ offset: true }),
    refreshToken: z
      .string()
      .optional()
      .describe(
        "Refresh token (`hlr_<64hex>`); only present for native-policy callers.",
      ),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({
    id: "AccessRefreshBundle",
    description:
      "Native-client token bundle returned by login + refresh. Web cookie-only callers see only `user`.",
  });

const deviceRegisterRequest = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[A-Za-z0-9+/=._:-]+$/)
      .describe("Generic device identifier (legacy; APNs token below)."),
    bundleId: z.string().min(1).max(128),
    locale: z.string().min(2).max(16).optional(),
    appVersion: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(64).optional(),
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/)
      .optional()
      .describe(
        "Hex-encoded APNs device token. Must be paired with `apnsEnvironment`.",
      ),
    apnsEnvironment: z
      .enum(["sandbox", "production"])
      .optional()
      .describe(
        "Gateway the iOS client received `apnsToken` from. Server never auto-detects.",
      ),
  })
  .meta({
    id: "DeviceRegisterRequest",
    description:
      "Native device registration. Re-registering an APNs token belonging to another user returns 409 (cross-user-hijack guard).",
  });

const batchEntrySchema = z
  .object({
    hkIdentifier: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "HealthKit identifier (e.g. `HKQuantityTypeIdentifierBodyMass`).",
      ),
    value: z.number().finite(),
    unit: z.string().min(1).max(60),
    startDate: z.iso.datetime({ offset: true }),
    endDate: z.iso.datetime({ offset: true }),
    sleepStage: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(
        "HKCategoryValueSleepAnalysis codepoint; only for sleep samples.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .describe("HKSample.uuid string — the dedup key."),
    externalSourceVersion: z.string().min(1).max(120).optional(),
  })
  .meta({ id: "AppleHealthBatchEntry" });

const batchPayloadSchema = z
  .object({
    entries: z.array(batchEntrySchema).min(1).max(500),
  })
  .meta({
    id: "AppleHealthBatchRequest",
    description:
      "Apple Health batch ingest. ≤500 entries per call; idempotent via `Idempotency-Key`.",
  });

const batchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(["inserted", "duplicate", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({ id: "AppleHealthBatchEntryResult" });

const batchResponse = z
  .object({
    inserted: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    entries: z.array(batchEntryResult),
  })
  .meta({ id: "AppleHealthBatchResponse" });

const deleteByExternalIdsRequest = z
  .object({
    externalIds: z.array(z.string().min(1).max(120)).min(0).max(500),
  })
  .meta({
    id: "MeasurementsDeleteByExternalIdsRequest",
    description:
      "iOS deletion-sync. Up to 500 externalIds per call; matching rows owned by other users are silently skipped (cross-user 404 guard).",
  });

const deleteByExternalIdsResponse = z
  .object({
    deletedCount: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsDeleteByExternalIdsResult" });

const measurementResource = z
  .object({
    id: z.string(),
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    measuredAt: z.iso.datetime({ offset: true }),
    source: measurementSourceEnum,
    notes: z.string().nullable().optional(),
  })
  .meta({
    id: "MeasurementResource",
    description: "Server-shaped measurement row returned by GET endpoints.",
  });

const insightsComprehensiveResponse = z
  .object({
    summary: z.string(),
    recommendations: z.array(z.record(z.string(), z.unknown())),
    citations: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.record(z.string(), z.unknown())),
    dailyBriefing: z.record(z.string(), z.unknown()).nullable().optional(),
    trendAnnotations: z.record(z.string(), z.unknown()).nullable().optional(),
    weeklyReport: z.record(z.string(), z.unknown()).nullable().optional(),
    storyboardAnnotations: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
    metricSource: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({
    id: "InsightsComprehensiveResponse",
    description:
      "AI-generated insights bundle. Strict-schema validated server-side; Coach-routed when the insight surface needs day-level grounding.",
  });

// ── Standard 401 / 422 / 429 responses ───────────────────────────────

const stdResponses = {
  "401": {
    description: "Authentication required or invalid credentials.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "422": {
    description: "Request validation failed.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "429": {
    description: "Rate limit exceeded.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

// ── Path table ───────────────────────────────────────────────────────

export const openApiPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Email-or-username login (password)",
      description:
        "Browser callers receive a session cookie. Native callers (X-Client-Type: native or HealthLog-iOS UA prefix) additionally receive a paired access + refresh token.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: loginPasswordSchema } },
      },
      responses: {
        "200": {
          description: "Login succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "LoginResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/passkey/login-verify": {
    post: {
      tags: ["Auth"],
      summary: "Passkey assertion verification",
      requestBody: {
        required: true,
        content: { "application/json": { schema: passkeyLoginVerifyRequest } },
      },
      responses: {
        "200": {
          description: "Assertion verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "PasskeyLoginVerifyResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Rotate refresh token (one-time use)",
      description:
        "Reuse of a consumed refresh token revokes every refresh token still active for the originating device (per-device blast radius from v1.4.23). Legacy tokens issued before v1.4.23 with a null deviceId fall back to revoke-all-for-user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: refreshRequest } },
      },
      responses: {
        "200": {
          description: "Rotation succeeded — new pair issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "RefreshResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements": {
    get: {
      tags: ["Measurements"],
      summary: "List measurements",
      description:
        "Filter by type + date range. Response is paged via offset/limit; default limit 100, hard cap 500.",
      requestParams: {
        query: listMeasurementsSchema,
      },
      responses: {
        "200": {
          description: "Measurement page.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  measurements: z.array(measurementResource),
                  total: z.number().int().nonnegative(),
                }),
                "ListMeasurementsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Measurements"],
      summary: "Create one measurement",
      description:
        "Single ingest. Use `/api/measurements/batch` for Apple Health upload streams.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMeasurementSchema } },
      },
      responses: {
        "201": {
          description: "Created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementResource,
                "CreateMeasurementResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/batch": {
    post: {
      tags: ["Measurements"],
      summary: "Apple Health batch ingest",
      description:
        "Up to 500 HealthKit entries per call. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status lets the iOS client advance its sync cursor accurately.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: batchPayloadSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(batchResponse, "BatchMeasurementsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/by-external-ids": {
    delete: {
      tags: ["Measurements"],
      summary: "Delete measurements by external ID (iOS deletion-sync)",
      description:
        "Removes the user's measurement rows whose externalId is in the request list. Rows owned by another user are silently skipped (cross-user 404 guard). Up to 500 externalIds per call.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: deleteByExternalIdsRequest },
        },
      },
      responses: {
        "200": {
          description: "Delete batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deleteByExternalIdsResponse,
                "MeasurementsDeleteByExternalIdsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/devices": {
    post: {
      tags: ["Devices"],
      summary: "Register native device + APNs token",
      description:
        "Idempotent upsert by `token`. APNs token + environment are paired — supplying one without the other returns 422. Cross-user re-registration of either identifier returns 409.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: deviceRegisterRequest } },
      },
      responses: {
        "201": {
          description: "Device registered or refreshed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string() }),
                "DeviceRegisterResponse",
              ),
            },
          },
        },
        "409": {
          description:
            "Device or APNs token already registered to another user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
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
          description: "Resolved preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "GetCoachPrefsResponse"),
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
        "Persists the supplied prefs. Body is validated against `CoachPrefs`; missing keys fall back to the documented defaults.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: coachPrefsSchema } },
      },
      responses: {
        "200": {
          description: "Saved preferences echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "PutCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/messages/{id}/feedback": {
    post: {
      tags: ["Insights"],
      summary: "Rate a Coach assistant message",
      description:
        "Persists a helpful/unhelpful rating for a single Coach reply. Reuses the v1.4.16 RecommendationFeedback table via the polymorphic `targetType` column. The aggregator buckets ratings by (promptVersion, tone, verbosity).",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachMessageFeedbackBody },
        },
      },
      responses: {
        "201": {
          description: "Feedback saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                }),
                "CoachMessageFeedbackResponse",
              ),
            },
          },
        },
        "404": {
          description: "Message not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Caller has already rated this message text.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/comprehensive": {
    get: {
      tags: ["Insights"],
      summary: "Comprehensive AI insights bundle",
      description:
        "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations. Strict-schema validated server-side.",
      responses: {
        "200": {
          description: "Insights bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsComprehensiveResponse,
                "InsightsComprehensiveResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

export const openApiComponents: NonNullable<ZodOpenApiObject["components"]> = {
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "hlk_<64hex>",
      description:
        "Native-client API token. Use the `token` field returned by /api/auth/login on a native client.",
    },
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "healthlog_session",
      description: "Browser session cookie — set by /api/auth/login.",
    },
  },
};
