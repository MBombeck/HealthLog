/**
 * OpenAPI route table — third-party integrations.
 *
 * Three families live here:
 *
 *   * the HealthKit config the iOS client drives,
 *   * the per-provider surfaces under `/api/<provider>/*` — credentials,
 *     status, disconnect, sync and the token probe, for Fitbit, Google Health,
 *     Nightscout, Oura, Polar, Strava, WHOOP and Withings,
 *   * the cross-provider surfaces under `/api/integrations/*` — the
 *     consolidated status envelope, the park-resume endpoints and the
 *     connection probes for the four providers that have one there.
 *
 * The same verb name does NOT mean the same contract across providers, and the
 * descriptions say so per path rather than smoothing it over. Three divergences
 * are worth knowing before reading further:
 *
 *   * `POST /api/<provider>/disconnect` is 404-on-repeat for all seven
 *     providers that have one; `DELETE /api/<provider>/credentials` is an
 *     idempotent 200 for all six. The same user-facing gesture, opposite
 *     contracts, and the split follows the URL rather than the provider.
 *   * `/api/<provider>/test` answers `{ ok, latencyMs }`; the same-named
 *     `/api/integrations/<provider>/test` answers `{ ok, lastSyncedAt,
 *     latencyMs }`, and the Google Health one additionally accepts a body that
 *     changes the response shape entirely.
 *   * `GET /api/withings/status` refreshes and re-persists the OAuth token as a
 *     side effect. No other status read writes anything.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Response DTOs are declared here mirroring the route handlers; request schemas
 * come from `src/lib/validations/*` so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { fitbitCredentialsSchema } from "@/lib/validations/fitbit";
import { googleHealthCredentialsSchema } from "@/lib/validations/google-health";
import { ouraCredentialsSchema } from "@/lib/validations/oura";
import { polarCredentialsSchema } from "@/lib/validations/polar";
import { stravaCredentialsSchema } from "@/lib/validations/strava";
import { whoopCredentialsSchema } from "@/lib/validations/whoop";
import { nightscoutConnectSchema } from "@/lib/validations/nightscout";
import { withingsCredentialsSchema } from "@/lib/validations/withings";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// Mirror the route's `directionEnum` — per-metric sync direction.
const healthKitDirectionEnum = z
  .enum(["bidirectional", "readOnly", "writeOnly", "disabled"])
  .describe("Per-metric sync direction.");

// Mirror the batch route's `syncTriggerEnum` — what woke the client for a sync.
const healthKitSyncTriggerEnum = z
  .enum(["foreground", "background", "push"])
  .describe("What triggered a HealthKit batch.");

// Resolved entry (defaults merged): `kind` + `enabled` are always present.
const healthKitEntry = z
  .object({
    id: z.string().describe("Stable metric key (e.g. `bodyMass`)."),
    kind: z.string().describe("HealthKit sample kind (e.g. `bloodPressure`)."),
    direction: healthKitDirectionEnum,
    enabled: z.boolean(),
  })
  .meta({
    id: "HealthKitEntry",
    description:
      "One resolved HealthKit metric mapping (defaults merged with the user's stored overrides).",
  });

// Mirrors `src/lib/integrations/sync-verdict.ts` — the server-resolved liveness
// verdict. Apple Health is push-based, so only the data-age arms apply.
const syncHealth = z
  .object({
    verdict: z
      .enum([
        "fresh",
        "stale",
        "stalled",
        "failing",
        "reauth_required",
        "parked",
        "pending_first_sync",
        "disconnected",
      ])
      .describe(
        "Liveness verdict. For Apple Health: `fresh` when data arrived within the last 7 days, `stale` when it did not, `pending_first_sync` when none ever arrived.",
      ),
    since: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("The instant that triggered the verdict; null when none did."),
  })
  .meta({
    id: "SyncHealth",
    description:
      "Server-resolved sync-health verdict. The single source of liveness truth — `lastSyncedAt` alone cannot express 'this pipe stopped delivering'.",
  });

const metricFreshnessEntry = z
  .object({
    type: z
      .string()
      .describe(
        "The measurement type (e.g. `RESPIRATORY_RATE`), or `WORKOUTS` for the workout leg.",
      ),
    lastSeenAt: z.iso
      .datetime({ offset: true })
      .describe("Newest recorded reading for this type from this source."),
    stale: z
      .boolean()
      .describe(
        "This type has gone quiet while the source around it reads healthy — the dead-pipe signature (e.g. a single revoked HealthKit permission). Only ever true when the verdict is `fresh`.",
      ),
  })
  .meta({
    id: "MetricFreshnessEntry",
    description:
      "Per-metric-type last-seen timestamp with the server-computed staleness flag. Only types that have actually delivered appear — absence is absence, never an invented row.",
  });

// Issue #778 — the two backfill-progress figures the server genuinely holds.
// The iOS app drives the backfill; its queue, throttle state, and any ETA
// live on the device and are deliberately absent here.
const appleHealthSyncProgress = z
  .object({
    recordsAccepted: z
      .number()
      .int()
      .describe(
        "Measurement + workout rows carrying the `APPLE_HEALTH` source (live batch ingest and the one-shot export import both write it). Soft-deleted measurement rows are excluded.",
      ),
    oldestMeasuredAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Earliest instant reached across those rows (`measuredAt` for measurements, `startedAt` for workouts); null when nothing has arrived. During a first-run backfill this walks backwards as history lands.",
      ),
  })
  .meta({
    id: "AppleHealthSyncProgress",
    description:
      "Server-side Apple Health backfill progress: how many rows have been accepted and how far back in time they reach. Only what the server actually knows — no ETA, no device-side queue state.",
  });

const healthKitConfigResponse = z
  .object({
    entries: z.array(healthKitEntry),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "When HealthKit last synced for this user; null when never (and always null on the PATCH echo).",
      ),
    lastSyncTrigger: healthKitSyncTriggerEnum
      .nullable()
      .optional()
      .describe(
        "What the client declared triggered the most recent accepted batch. Null when the client sent no trigger — an older build, or a batch that predates the field. Present on the GET read; omitted from the PATCH echo.",
      ),
    lastBackgroundSyncAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "When a batch last arrived without the app being opened (a `background` or `push` trigger). Null when that has never happened. `lastSyncedAt` alone cannot separate a phone that delivers on its own from one that only delivers while the app is open; this field is what does. Present on the GET read; omitted from the PATCH echo.",
      ),
    syncHealth: syncHealth
      .optional()
      .describe("Present on the GET read; omitted from the PATCH echo."),
    metricFreshness: z
      .array(metricFreshnessEntry)
      .optional()
      .describe(
        "Per-metric-type freshness for the `APPLE_HEALTH` source. Present on the GET read; omitted from the PATCH echo.",
      ),
    syncProgress: appleHealthSyncProgress
      .nullable()
      .optional()
      .describe(
        "Backfill/sync progress summary. Present on the GET read (null when the progress read failed); omitted from the PATCH echo.",
      ),
  })
  .meta({
    id: "HealthKitConfigResponse",
    description:
      "The resolved HealthKit integration config: the default metric set merged with the user's stored per-metric overrides, plus the sync-health verdict and per-metric freshness.",
  });

// Mirror the route's `patchSchema` — merge-by-id; unknown ids are ignored.
const healthKitPatchEntry = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(64).optional(),
  direction: healthKitDirectionEnum,
  enabled: z.boolean().optional(),
});

const healthKitPatchRequest = z
  .object({
    entries: z.array(healthKitPatchEntry).max(50),
  })
  .meta({
    id: "HealthKitConfigPatchRequest",
    description:
      "Merge-by-`id` update of the HealthKit metric config. Unknown ids are silently ignored; omitted fields fall back to the stored (or default) value for that entry. Up to 50 entries per call.",
  });

// v1.32.28 — on-demand provider sync trigger. Identical response shape
// across Oura / Polar / Strava / Nightscout (`resolveSyncOutcome`), so a
// client renders one outcome card for all four. `outcome` is the
// server-resolved tone, never derived from the HTTP status alone: 200 is the
// transport succeeding, not the write — a run where every row was refused
// still answers 200 with `outcome: "failed"`.
const providerSyncOutcome = z
  .object({
    imported: z
      .number()
      .int()
      .describe("Rows that reached the database this run."),
    failed: z
      .boolean()
      .describe(
        "True when any part of the run did not land — a row, a collection, a leg.",
      ),
    outcome: z
      .enum(["empty", "failed", "partial", "success"])
      .describe(
        "`empty` — nothing new, nothing refused. `failed` — nothing written, something refused. `partial` — some written, some refused. `success` — everything written.",
      ),
  })
  .meta({
    id: "ProviderSyncOutcome",
    description:
      "The result of an on-demand provider sync trigger. No request body; the sync window is derived server-side from the newest row already held, never a client-supplied lookback.",
  });

// v1.32.x — Google Health background sync progress. Mirrors
// `GoogleHealthResourceOutcome` / the route's `resource()` sanitiser
// (`src/app/api/google-health/sync/status/route.ts`): every field is
// re-clamped/re-checked against a closed enum on read, so this documents
// the SANITISED wire shape, not the raw stored blob.
const googleHealthResourceOutcome = z
  .object({
    resource: z
      .string()
      .describe(
        "Resource collection name, lower-cased and slug-sanitised (`[^a-z0-9-]` stripped), capped at 48 chars. `unknown` when the stored value was not a string.",
      ),
    pages: z.number().int().min(0),
    fetched: z.number().int().min(0),
    mapped: z.number().int().min(0),
    written: z.number().int().min(0),
    status: z
      .enum(["pending", "complete", "partial", "empty", "truncated", "failed"])
      .describe(
        "Falls back to `failed` when the stored value is not one of this closed set.",
      ),
    durationMs: z.number().int().min(0),
    truncated: z.boolean(),
    reasonCode: z
      .enum([
        "collection_failed",
        "token_failed",
        "upsert_failed",
        "rollup_failed",
        "existing_page_limit",
      ])
      .nullable()
      .describe(
        "Null when the stored value is not one of this closed set, or when the resource did not fail.",
      ),
  })
  .meta({ id: "GoogleHealthResourceOutcome" });

const googleHealthSyncStatusResponse = z
  .object({
    runId: z.string().describe("Truncated to 128 chars."),
    state: z
      .enum([
        "in_progress",
        "complete",
        "partial",
        "zero",
        "truncated",
        "failed",
        "interrupted",
      ])
      .describe(
        "Falls back to `failed` when the stored value is not one of this closed set.",
      ),
    startedAt: z.string().describe("ISO instant, or empty string when unset."),
    updatedAt: z.string().describe("ISO instant, or empty string when unset."),
    terminalAt: z
      .string()
      .optional()
      .describe(
        "ISO instant the run reached a terminal state. Present only once the run has finished; absent while `state` is `in_progress`.",
      ),
    imported: z.number().int().min(0),
    failed: z.boolean(),
    resources: z
      .array(googleHealthResourceOutcome)
      .max(16)
      .describe("Per-collection outcome for this run, capped at 16 entries."),
  })
  .nullable()
  .meta({
    id: "GoogleHealthSyncStatusResponse",
    description:
      "The caller's current/most-recent Google Health sync run, or null when none has ever run. `data` carries this shape directly (not nested under a named key).",
  });

// ── Per-provider connection surfaces ─────────────────────────────────
// Nightscout / WHOOP / Withings each expose a status read plus a teardown.
// They answered iOS since v1.11 and were absent from the registry entirely,
// so nothing below is new behaviour — it is the shape the handlers already
// send, written down.

// Mirrors `IntegrationState` in `src/lib/integrations/status.ts`. The ledger
// records what the last ATTEMPT did; the verdict in `syncHealth` is what says
// whether the pipe is still alive. Both are published because they answer
// different questions and a client that reads only `state` cannot tell a row
// retrying hourly from one that stopped being tried at all.
const integrationLedgerState = z
  .enum([
    "connected",
    "error_transient",
    "error_reauth",
    "disconnected",
    "parked",
  ])
  .describe(
    "Last recorded ledger state for this provider. `connected` is also the value a user who has never synced sees — the ledger row is created on the first attempt, and its absence reads as `connected`, not as an error.",
  );

const nightscoutConnectRequest = nightscoutConnectSchema.meta({
  id: "NightscoutConnectRequest",
  description:
    "Instance URL and optional API token. Both are trimmed before use — a trailing space or newline from a copy button reaches the instance verbatim and answers as an opaque DNS failure. `token` may be omitted or empty for a fully public instance (`AUTH_DEFAULT_ROLES=readable`). `allowPrivateHost` is accepted for older clients and ignored: only the server-side `NIGHTSCOUT_PRIVATE_ORIGINS` allowlist can authorise a private origin.",
});

const nightscoutStatusResponse = z
  .object({
    connected: z
      .boolean()
      .describe(
        "A connection exists. Not a liveness claim — a pipe dead for a fortnight still answers `true`; read `syncHealth.verdict` for that.",
      ),
    configured: z
      .boolean()
      .describe("An instance URL is stored. The connect marker."),
    hasToken: z
      .boolean()
      .optional()
      .describe(
        "Whether an API token is stored alongside the URL. A fully-public Nightscout instance needs none, so `false` is not a misconfiguration. The token itself is never returned.",
      ),
    allowPrivateHost: z
      .boolean()
      .optional()
      .describe(
        "The operator has approved this user's private-origin (RFC 1918 / loopback / link-local) Nightscout instance. False for every public instance.",
      ),
    state: integrationLedgerState.optional(),
    lastSuccessAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastAttemptAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastError: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Last recorded failure message, decrypted from the ledger. Null when the last attempt succeeded or none has run.",
      ),
    syncHealth: syncHealth.optional(),
  })
  .meta({
    id: "NightscoutStatusResponse",
    description:
      "Nightscout connection status. When nothing is configured the body is exactly `{ connected: false, configured: false }` — every other field is absent, not null. The stored instance URL is the user's own and is NOT echoed here; the API token never is.",
  });

const nightscoutTestResponse = z
  .object({
    ok: z.literal(true),
    latencyMs: z
      .number()
      .int()
      .describe("Round-trip time of the single-entry probe, in milliseconds."),
  })
  .meta({
    id: "NightscoutTestResponse",
    description:
      "A live probe that reached the configured instance and read one SGV entry. Only ever returned on success — a failed probe is an error status, never `ok: false`.",
  });

const whoopCredentialsStatusResponse = z
  .object({
    hasCredentials: z
      .boolean()
      .describe(
        "Both the client id and the client secret are stored. Neither value is ever returned.",
      ),
  })
  .meta({
    id: "WhoopCredentialsStatusResponse",
    description:
      "Presence check for the per-user WHOOP BYO-key credentials. Presence only: this endpoint has no read path for the stored id or secret.",
  });

const whoopCredentialsRequest = whoopCredentialsSchema.meta({
  id: "WhoopCredentialsRequest",
  description:
    "Per-user WHOOP BYO-key credentials. Each self-hoster registers their own WHOOP developer app — the per-app authorized-user cap makes one shared app unworkable for a multi-operator product. Both values are trimmed (a trailing space from the portal's copy button reaches WHOOP verbatim and answers as 'unknown client') and stored encrypted at rest. Write-only: no endpoint reads them back.",
});

const whoopStatusResponse = z
  .object({
    connected: z
      .boolean()
      .describe("A WHOOP connection row exists and carries a WHOOP user id."),
    configured: z
      .boolean()
      .describe("Per-user BYO-key client id AND secret are both stored."),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("Null when no sync has completed yet."),
    connectedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("When the connection row was created."),
    tokenExpired: z
      .boolean()
      .optional()
      .describe(
        "The stored access token's expiry is in the past. Read straight off the row — unlike the Withings status read, this endpoint does not refresh; the sync path refreshes lazily instead.",
      ),
    tokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
    backfillCompleted: z
      .boolean()
      .optional()
      .describe(
        "The self-converging history backfill has walked every collection to completion.",
      ),
    scope: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Space-separated OAuth scope string granted by WHOOP. Null on a legacy connection that predates scope tracking.",
      ),
  })
  .meta({
    id: "WhoopStatusResponse",
    description:
      "WHOOP connection status. When no connection row carries a WHOOP user id the body is exactly `{ connected: false, configured }` — every other field is absent, not null.",
  });

const withingsStatusResponse = z
  .object({
    connected: z.boolean().describe("A Withings connection row exists."),
    configured: z
      .boolean()
      .describe("Per-user client id AND secret are both stored."),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    connectedAt: z.iso.datetime({ offset: true }).optional(),
    tokenExpired: z
      .boolean()
      .optional()
      .describe(
        "True after a refresh attempt that did not produce a live token.",
      ),
    tokenRefreshFailed: z
      .boolean()
      .optional()
      .describe(
        "The read tried to refresh an expired token and could not — either the per-user credentials are gone or Withings refused. A permanently revoked grant additionally parks the ledger at `error_reauth` as a side effect of this read.",
      ),
    tokenExpiresAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Post-refresh expiry when the read refreshed, the stored expiry otherwise.",
      ),
    scope: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Comma-separated OAuth scope string from the authorisation flow. Null on a legacy connection that has never re-authed.",
      ),
    hasActivityScope: z
      .boolean()
      .optional()
      .describe(
        "Pre-computed convenience flag the reconnect banner reads. A null `scope` counts as missing activity.",
      ),
  })
  .meta({
    id: "WithingsStatusResponse",
    description:
      "Withings connection status. When no connection row exists the body is exactly `{ connected: false, configured }` — every other field is absent, not null. Note that this read is not side-effect free: a token within 60 s of expiry is refreshed and re-persisted before the response is built, so a GET here can rotate the stored token.",
  });

// ── Shapes shared across the provider surfaces ───────────────────────

/** Every credentials GET answers exactly this, and never the values. */
const credentialsPresenceResponse = z
  .object({
    hasCredentials: z
      .boolean()
      .describe(
        "Both the client id and the client secret are stored. Neither value is ever returned by any endpoint.",
      ),
  })
  .meta({
    id: "CredentialsPresenceResponse",
    description:
      "Presence check for a provider's per-user BYO-key credentials. Presence only — the stored id and secret are write-only.",
  });

// The BYO-key request bodies. Five providers trim their inputs and two do not
// (Fitbit / Google Health / Withings take the string verbatim); the difference
// is real and is stated per schema rather than averaged away.
const fitbitCredentialsRequest = fitbitCredentialsSchema.meta({
  id: "FitbitCredentialsRequest",
  description:
    "Per-user Fitbit BYO-key credentials, 1–200 characters each, stored encrypted at rest and never read back. NOT trimmed: a trailing space or newline from the developer portal's copy button is stored verbatim and reaches Fitbit as part of the id.",
});

const googleHealthCredentialsRequest = googleHealthCredentialsSchema.meta({
  id: "GoogleHealthCredentialsRequest",
  description:
    "Per-user Google Health BYO-key credentials — each self-hoster registers their own Google Cloud OAuth client, because the Restricted-scope brand verification and CASA assessment are per-client. 1–200 characters each, stored encrypted, never read back. NOT trimmed.",
});

const ouraCredentialsRequest = ouraCredentialsSchema.meta({
  id: "OuraCredentialsRequest",
  description:
    "Per-user Oura BYO-key credentials. Trimmed on the way in, because a trailing space from the portal's copy button reaches Oura verbatim and answers as 'unknown client'. Stored encrypted, never read back. Leaving these unset is valid: the integration then falls back to the operator's shared env app.",
});

const polarCredentialsRequest = polarCredentialsSchema.meta({
  id: "PolarCredentialsRequest",
  description:
    "Per-user Polar AccessLink BYO-key credentials. Trimmed on the way in. Stored encrypted, never read back. Leaving these unset falls back to the operator's shared env app.",
});

const stravaCredentialsRequest = stravaCredentialsSchema.meta({
  id: "StravaCredentialsRequest",
  description:
    "Per-user Strava BYO-key credentials. Strava caps every newly-created API app at athlete capacity 1, so one shared app cannot serve several self-hosters and each registers their own. Trimmed on the way in. Stored encrypted, never read back. Leaving these unset falls back to the operator's shared env app.",
});

const withingsCredentialsRequest = withingsCredentialsSchema.meta({
  id: "WithingsCredentialsRequest",
  description:
    "Per-user Withings BYO-key credentials, 1–200 characters each, stored encrypted at rest and never read back. NOT trimmed.",
});

const updatedAck = z.object({ updated: z.literal(true) });
const deletedAck = z.object({ deleted: z.literal(true) });
const disconnectedAck = z.object({ disconnected: z.literal(true) });

/** Body refusals shared by every `safeJson(request, { maxBytes: 64 * 1024 })`. */
const jsonBody64k = {
  "400": {
    description: "Body is not parseable JSON.",
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
};

const credentialsRejected422 = {
  "422": {
    description:
      "`clientId` and `clientSecret` are both required and each must be 1–200 characters. The envelope carries a single fixed message, not per-field issues.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

/**
 * The token probe under `/api/<provider>/test` (Nightscout / Oura / Polar /
 * Strava). Bare success — no `lastSyncedAt`, which is the difference from the
 * same-named probe under `/api/integrations/<provider>/test`.
 */
const providerProbeResponse = z
  .object({
    ok: z.literal(true),
    latencyMs: z
      .number()
      .int()
      .describe("Round-trip time of the probe request, in milliseconds."),
  })
  .meta({
    id: "ProviderProbeResponse",
    description:
      "A probe that reached the provider with the stored grant. Only ever returned on success — a failed probe is an error status, never `ok: false`.",
  });

/**
 * The probe under `/api/integrations/<provider>/test` (Fitbit / Google Health /
 * WHOOP / Withings). Same idea, one field more.
 */
const integrationProbeResponse = z
  .object({
    ok: z.literal(true),
    lastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "The connection row's last successful sync; null when it has never synced. Present here and absent from the `/api/<provider>/test` family — the one shape difference between the two probe families.",
      ),
    latencyMs: z.number().int(),
  })
  .meta({
    id: "IntegrationProbeResponse",
    description:
      "A probe that reached the provider with a freshly-resolved access token, plus the connection's last sync instant.",
  });

/**
 * The 502 both probe families answer, with the error-code set they share.
 *
 * The set is identical across Fitbit / Google Health / Oura / Polar / Strava /
 * WHOOP / Withings. Two providers add one code of their own and say so on their
 * own path: Nightscout adds `url_not_public`, Withings adds
 * `upstream_invalid_json`.
 */
const probeFailure502 = {
  "502": {
    description:
      "The probe did not complete. `meta.errorCode` names the class: `credentials_rejected` (the provider answered 401/403 — the stored grant is gone), `rate_limited` (the PROVIDER answered 429, which is not this endpoint's own limiter), `upstream_error` (5xx), `timeout` (no answer within 5 s), `connection_failed` (everything else). The message is fixed per class; the upstream body never reaches the client.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const probeNotConfigured422 = {
  "422": {
    description:
      "No usable connection for this provider — nothing stored, or the stored grant could no longer be resolved into an access token. `meta.errorCode` = `not_configured`.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const selfRateLimited429 = {
  "429": {
    description:
      "More than 5 requests in 60 s from this user. `meta.errorCode` = `rate_limited_self` — this is the local limiter, distinct from a `rate_limited` 502 which is the provider's.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

/**
 * The manual-sync body. Every sync route reads it through the same helper, and
 * the helper separates three cases the old per-route copies collapsed into one:
 * an ABSENT body is an incremental run, a body that is present and unparseable
 * is a 400, and a body that is present and fails this schema is a 422.
 */
const syncTriggerRequest = z
  .object({
    fullSync: z
      .boolean()
      .optional()
      .describe(
        "`true` walks full history; `false` or omitted runs the incremental sync. A non-boolean here is refused with 422 — it is NOT read as `false`.",
      ),
  })
  .meta({
    id: "SyncTriggerRequest",
    description:
      'Optional flag-only body for a manual sync. Omit the body entirely (or send `{}`) for an incremental run — that is the documented shape and it keeps working. A body that IS present must be valid: unparseable JSON is 400, and a body failing this schema is 422 with the multi-issue envelope. This matters because it used to be neither: `{ "fullSync": "true" }` was silently read as `false` and answered 200, so a client that asked for full history and mistyped the value was told the run it never requested had succeeded. Unknown keys are still ignored.',
  });

const syncTriggerOutcome = z
  .object({
    imported: z
      .number()
      .int()
      .describe("Rows that reached the database this run."),
    failed: z.boolean().describe("True when any part of the run did not land."),
    outcome: z
      .enum(["empty", "failed", "partial", "success"])
      .describe(
        'Server-resolved tone, never derived from the HTTP status: a run where everything was refused still answers 200 with `outcome: "failed"`.',
      ),
    fullSync: z.boolean().describe("Echo of the flag this run used."),
  })
  .meta({
    id: "SyncTriggerOutcome",
    description:
      "The result of a manual sync trigger, with the flag echoed back so a client can tell an incremental run from a full one in the response alone.",
  });

const googleHealthSyncOutcome = syncTriggerOutcome
  .extend({
    runId: z
      .string()
      .optional()
      .describe("Truncated to 128 chars. Absent when the run produced none."),
    state: z
      .enum([
        "in_progress",
        "complete",
        "partial",
        "zero",
        "truncated",
        "failed",
        "interrupted",
      ])
      .optional(),
    resources: z
      .array(googleHealthResourceOutcome)
      .max(16)
      .optional()
      .describe(
        "Per-collection outcome, capped at 16 entries and re-sanitised on the way out exactly as the status endpoint does.",
      ),
  })
  .meta({
    id: "GoogleHealthSyncOutcome",
    description:
      "The Google Health manual-sync result: the shared outcome plus the run identity and the per-collection breakdown.",
  });

const resumeResponse = z
  .object({
    resumed: z.literal(true),
    wasParked: z
      .boolean()
      .describe(
        "Whether the ledger was actually parked before this call. False means the call changed nothing — render it as a no-op rather than a 'resumed' confirmation.",
      ),
  })
  .meta({
    id: "IntegrationResumeResponse",
    description:
      "The result of clearing a park. Idempotent: a second call answers 200 with `wasParked: false` and writes no further audit row.",
  });

/**
 * The connection-row status shape Fitbit and Google Health share. WHOOP's is
 * the same minus nothing and plus nothing, but it is declared separately above
 * because it predates this batch and iOS reads it by its own component name.
 */
function connectionStatusShape() {
  return {
    connected: z.boolean().describe("A connection row exists."),
    configured: z
      .boolean()
      .describe("Per-user BYO-key client id AND secret are both stored."),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    connectedAt: z.iso.datetime({ offset: true }).optional(),
    tokenExpired: z
      .boolean()
      .optional()
      .describe(
        "Read straight off the row — this endpoint does not refresh; the sync path refreshes lazily.",
      ),
    tokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
    backfillCompleted: z
      .boolean()
      .optional()
      .describe("The history backfill has walked every collection."),
    scope: z
      .string()
      .nullable()
      .optional()
      .describe(
        "OAuth scope string granted at authorisation. Null on a legacy connection that predates scope tracking.",
      ),
  };
}

const fitbitStatusResponse = z.object(connectionStatusShape()).meta({
  id: "FitbitStatusResponse",
  description:
    "Fitbit connection status. When no connection row exists the body is exactly `{ connected: false, configured }` — every other field is absent, not null. Pure read.",
});

const googleHealthStatusResponse = z
  .object({
    ...connectionStatusShape(),
    needsReauth: z
      .boolean()
      .optional()
      .describe(
        "The stored refresh token was rejected with `invalid_grant` — Google expires it after 7 days while the OAuth client is in Testing publishing mode, and a user-revoked grant lands here too. Distinct from `parked` and from `disconnected`: the connection still exists, it just cannot mint a token until the user reconnects. Only Google Health has this field.",
      ),
  })
  .meta({
    id: "GoogleHealthStatusResponse",
    description:
      "Google Health connection status. When no connection row exists the body is exactly `{ connected: false, configured }` — every other field is absent, not null. Pure read.",
  });

/**
 * Oura / Polar / Strava share one status shape. They differ from the
 * connection-row providers in that `configured` MIRRORS `connected` rather than
 * reporting credentials: there is no "credentials saved but disconnected" state
 * on these three, and `hasOwnCredentials` is the field that reports the BYO
 * pair instead.
 */
const oauthProviderStatusResponse = z
  .object({
    connected: z.boolean().describe("An access token is stored."),
    configured: z
      .boolean()
      .describe(
        "Mirrors `connected` exactly on these three providers. It is NOT a credentials marker — read `hasOwnCredentials` for that.",
      ),
    available: z
      .boolean()
      .describe(
        "Usable OAuth client credentials resolve for this user: the per-user BYO pair first, then the operator's shared env app. False means the connect button cannot work at all.",
      ),
    hasOwnCredentials: z
      .boolean()
      .describe("The user has stored their own BYO client id and secret."),
    state: integrationLedgerState.optional(),
    lastSuccessAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastAttemptAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastError: z.string().nullable().optional(),
    syncHealth: syncHealth.optional(),
  })
  .meta({
    id: "OAuthProviderStatusResponse",
    description:
      "Connection status for an OAuth provider whose grant lives on the user row (Oura / Polar / Strava). When no token is stored the body is exactly `{ connected: false, configured: false, available, hasOwnCredentials }` — the ledger fields are absent, not null. Tokens and client secrets are never returned. Pure read.",
  });

// ── The consolidated envelope (`GET /api/integrations/status`) ───────

const consecutiveFailuresByKind = z
  .object({
    transient: z.number().int(),
    reauth_required: z.number().int(),
    persistent: z.number().int(),
  })
  .nullable()
  .describe(
    "Per-kind consecutive-failure counters, or null when the row has never written a bucket payload. Compare against the top-level `threshold` to know how close the provider is to the operator alert.",
  );

const integrationEnvelopeEntry = z
  .object({
    integration: z
      .enum([
        "withings",
        "whoop",
        "fitbit",
        "google-health",
        "polar",
        "oura",
        "strava",
        "nightscout",
      ])
      .describe("Which provider this entry describes."),
    state: integrationLedgerState,
    lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
    lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
    lastError: z.string().nullable(),
    consecutiveFailuresByKind,
    syncHealth,
    metricFreshness: z
      .array(metricFreshnessEntry)
      .describe(
        "Per-metric-type freshness for this provider's data. Empty when the provider has delivered nothing — and also empty when the freshness read failed, because the endpoint degrades to no data rather than failing the whole envelope. Read the top-level `metricFreshnessDegraded` to tell those two apart before rendering an empty list as 'nothing has gone quiet'.",
      ),
    connected: z.boolean(),
    configured: z.boolean(),
    connectedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    legacyLastSyncedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "The connection row's own last-sync instant, for legacy connections established before the ledger existed. Not present on the three user-row OAuth providers or on Nightscout.",
      ),
    tokenExpiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    tokenExpired: z
      .boolean()
      .nullable()
      .optional()
      .describe("Null — not false — when there is no connection to judge."),
    backfillCompleted: z.boolean().nullable().optional(),
    scope: z.string().nullable().optional().describe("Withings only."),
    hasActivityScope: z.boolean().optional().describe("Withings only."),
    needsReauth: z.boolean().optional().describe("Google Health only."),
    available: z.boolean().optional().describe("Oura / Polar / Strava only."),
    hasOwnCredentials: z
      .boolean()
      .optional()
      .describe("Oura / Polar / Strava only."),
    hasToken: z.boolean().optional().describe("Nightscout only."),
    allowPrivateHost: z.boolean().optional().describe("Nightscout only."),
  })
  .meta({
    id: "IntegrationStatusEntry",
    description:
      "One provider's entry in the consolidated envelope: the ledger core and the liveness verdict, which every entry carries, plus the extras that provider has. The optional fields are not optional per request — each is present exactly for the providers named in its description and absent for the rest, so branch on `integration`, not on presence.",
  });

const integrationStatusEnvelope = z
  .object({
    threshold: z
      .number()
      .int()
      .describe(
        "Consecutive persistent failures at which the operator is alerted. Operator-level, configurable via env.",
      ),
    metricFreshnessDegraded: z
      .boolean()
      .describe(
        "The per-metric freshness query failed, so EVERY entry's `metricFreshness` is an empty array regardless of what the record actually holds. One flag rather than one per entry, because it is a single query for all eight providers: it fails for all of them or for none. When true, render the freshness section as unavailable rather than as 'no metric has gone quiet' — the two used to be indistinguishable on the wire, which turned the honesty signal into the thing it was built to prevent. The rest of the envelope is unaffected and still complete.",
      ),
    integrations: z
      .array(integrationEnvelopeEntry)
      .describe(
        "All eight providers, always, in the fixed order withings, whoop, fitbit, google-health, polar, oura, strava, nightscout. A provider the user has never touched still appears, with `connected: false` and a synthesised `connected` ledger state — absence from this list never means anything, because nothing is ever absent from it.",
      ),
  })
  .meta({
    id: "IntegrationStatusEnvelope",
    description:
      "The one read behind the integrations settings surface. It carries every field the per-provider status routes carry, so a client has the choice of eight round-trips or this one; the per-provider routes remain for callers that want a single provider.",
  });

export const integrationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/integrations/healthkit": {
    get: {
      tags: ["Integrations"],
      summary: "Read the HealthKit integration config",
      description:
        "Returns the resolved per-metric HealthKit config — the default metric set merged with the user's stored overrides — plus the last HealthKit sync instant. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Resolved HealthKit config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthKitConfigResponse,
                "HealthKitConfigEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Integrations"],
      summary: "Update the HealthKit integration config",
      description:
        "Merges the supplied entries into the stored config by `id` (unknown ids are ignored) and returns the resolved config (defaults merged) so the client always sees a complete metric list. `lastSyncedAt` is null on the echo. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthKitPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "Updated + resolved HealthKit config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthKitConfigResponse,
                "HealthKitConfigPatchEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/oura/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Oura sync",
      description:
        "Runs the same sync entry point the hourly cron uses. No body: the window is derived from the newest row already held, not a client-supplied lookback. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerSyncOutcome, "OuraSyncEnvelope"),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `oura` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/polar/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Polar sync",
      description:
        "Runs both Polar legs (vitals then workouts) through the same entry point the hourly poll uses, each with its own failure recording. No body: there is no full-history arm to call. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerSyncOutcome, "PolarSyncEnvelope"),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `polar` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/strava/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Strava sync",
      description:
        "Incremental from the stored Strava cursor (`stravaLastActivityAt` minus an overlap) — a manual run picks up wherever the last one stopped. No body and no full-history arm; deep history belongs to the connect-time backfill queue. `failed` is always `false` on a 200: the underlying walk rethrows on the first row error rather than settling partially, so reaching a 200 means every fetched activity was written. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerSyncOutcome, "StravaSyncEnvelope"),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `strava` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nightscout/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger an on-demand Nightscout sync",
      description:
        "Pulls the recent SGV window from the configured Nightscout instance. No body: there is no full-history arm to call. The error body is always a fixed message, never the caught error's own — a Nightscout base URL carries its API token as a query parameter, so an upstream message could leak it. Rate-limited 5 requests / 60s per user.",
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                providerSyncOutcome,
                "NightscoutSyncEnvelope",
              ),
            },
          },
        },
        "502": {
          description:
            "The sync failed upstream. The classified failure is already recorded on the `nightscout` ledger; the response body carries no upstream detail.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The configured Nightscout origin is private (RFC 1918 / loopback / link-local) and the server operator has not approved private-origin access for this deployment.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/google-health/sync/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Google Health sync progress",
      description:
        'Returns only the authenticated user\'s own bounded current/most-recent sync run; there is no way to address another run or another connection\'s progress by query parameter (query parameters are ignored by construction). Every field is re-clamped and re-checked against its closed enum on read, so a malformed or legacy stored blob degrades to safe defaults (e.g. `state: "failed"`, `resource: "unknown"`) rather than reaching the client verbatim. Auth via cookie or Bearer.',
      responses: {
        "200": {
          description:
            "The current/most-recent run, or `data: null` when none has ever run.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                googleHealthSyncStatusResponse,
                "GoogleHealthSyncStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nightscout/connect": {
    post: {
      tags: ["Integrations"],
      summary: "Connect (or update) the caller's Nightscout instance",
      description:
        "Validates the URL and token with a live single-entry probe BEFORE storing anything, so a wrong token, an unreachable instance or an unapproved private origin surfaces here rather than on the first cron tick. On success the URL and token are encrypted at rest, the `nightscout` ledger is reset to connected, and a first sync is enqueued best-effort. Re-sending replaces the stored values; there is no partial update. Body capped at 16 KiB, rate-limited 10 requests / 60 s per user. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: nightscoutConnectRequest },
        },
      },
      responses: {
        "200": {
          description: "The instance answered the probe and was stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ connected: z.literal(true) }),
                "NightscoutConnectEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Body is not parseable JSON.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 16 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The URL failed validation, the origin is private and the operator has not approved it (`meta.errorCode` = `private_origin_not_approved` or `invalid_origin`), Nightscout rejected the token, or the instance could not be reached. Nothing was written. The message is fixed per class and never the upstream error's own: a Nightscout base URL carries its API token as a query parameter.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 10 connection attempts in 60 s from this user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/nightscout/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Nightscout connection status",
      description:
        "Returns the connect marker plus the shared `nightscout` ledger snapshot and the server-resolved liveness verdict, so the Settings card and the iOS client paint the same pill from one read. The stored API token is never returned — `hasToken` reports its presence and nothing more. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nightscoutStatusResponse,
                "NightscoutStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/nightscout/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the configured Nightscout instance",
      description:
        "Pulls a single SGV entry through the same client the sync uses, to re-validate the stored URL and token without waiting for a sync window. No body. Nothing is written: this neither ingests the entry nor touches the ledger. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached the instance.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                nightscoutTestResponse,
                "NightscoutTestEnvelope",
              ),
            },
          },
        },
        "502": {
          description:
            "The probe did not complete. `meta.errorCode` names the class: `credentials_rejected` (401/403 from Nightscout), `rate_limited` (429 from Nightscout — distinct from this endpoint's own 429), `upstream_error` (5xx), `timeout` (no answer within 5 s), `url_not_public` (the stored origin resolves to a private host and the operator has not approved it), `connection_failed` (everything else). The message is fixed per class and never the caught error's own: a Nightscout base URL carries its API token as a query parameter, so an upstream message could leak it.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "No Nightscout instance is configured for this user. `meta.errorCode` = `not_configured`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 5 probes in 60 s from this user. `meta.errorCode` = `rate_limited_self` — this is the local limiter, not Nightscout's.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/nightscout/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Nightscout instance",
      description:
        "Clears the stored URL, token and private-host approval, and parks the `nightscout` ledger at `disconnected`. Glucose rows already ingested are left in place — this stops future syncs, it does not delete history. No body. Rate-limited 20 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was cleared.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ disconnected: z.literal(true) }),
                "NightscoutDisconnectEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No Nightscout connection to clear. Note that this is NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/whoop/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether WHOOP BYO-key credentials are stored",
      description:
        "Presence only. There is no read path for the stored client id or secret — the response carries a single boolean. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                whoopCredentialsStatusResponse,
                "WhoopCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's WHOOP BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Both are encrypted at rest and never read back. Body capped at 64 KiB. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: whoopCredentialsRequest },
        },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ updated: z.literal(true) }),
                "WhoopCredentialsUpdateEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Body is not parseable JSON.",
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
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's WHOOP credentials and connection",
      description:
        "Deletes the connection row (with its encrypted OAuth tokens), clears both credential columns, audits the teardown and parks the `whoop` ledger at `disconnected`. Idempotent: a missing connection row is a benign no-op, so a repeat call still answers 200. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "WhoopCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/whoop/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's WHOOP connection status",
      description:
        "Reports the BYO-key configuration marker plus the connection row's last sync, token expiry, granted scope and backfill progress. Read-only — token refresh happens lazily on the sync path, not here. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(whoopStatusResponse, "WhoopStatusEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/whoop/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's WHOOP account",
      description:
        "Deletes the connection row, audits the teardown and parks the `whoop` ledger at `disconnected`. There is no per-user unsubscribe to make — WHOOP webhook subscriptions are registered once per developer app, unlike Withings which subscribes per category. The BYO-key credentials are deliberately LEFT IN PLACE so a reconnect does not force the user to re-paste them; use the credentials DELETE to remove those too. No body. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(disconnectedAck, "WhoopDisconnectEnvelope"),
            },
          },
        },
        "404": {
          description:
            "No WHOOP connection to remove. NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/withings/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Withings connection status",
      description:
        "Reports the per-user credential marker plus the connection row's last sync, token expiry and granted scope. Not side-effect free: a token within 60 s of expiry is refreshed and the new pair re-persisted before the response is built, so the reported `tokenExpiresAt` may be newer than the stored one was at request time, and a permanently revoked grant parks the ledger at `error_reauth` during this read. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                withingsStatusResponse,
                "WithingsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/withings/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Withings account",
      description:
        "Best-effort unsubscribes every webhook category, deletes the connection row, audits the teardown and parks the `withings` ledger at `disconnected`. A failing unsubscribe (expired token, category never subscribed) does not stop the teardown. Measurements already ingested are left in place. No body. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ disconnected: z.literal(true) }),
                "WithingsDisconnectEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No Withings connection to remove. Note that this is NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/withings/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether Withings BYO-key credentials are stored",
      description: "Presence only. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                credentialsPresenceResponse,
                "WithingsCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's Withings BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: withingsCredentialsRequest },
        },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updatedAck,
                "WithingsCredentialsUpdateEnvelope",
              ),
            },
          },
        },
        ...jsonBody64k,
        ...stdResponses,
        ...credentialsRejected422,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's Withings credentials and connection",
      description:
        "Deletes the connection row (with its encrypted OAuth tokens), clears both credential columns, audits the teardown and parks the `withings` ledger at `disconnected`. Idempotent — a missing connection row is a benign no-op, so a repeat call still answers 200. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deletedAck,
                "WithingsCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/withings/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger a Withings sync",
      description:
        "Incremental by default; `{ fullSync: true }` walks full history. Two limiters apply, matching the Fitbit / Google Health siblings: 5 requests / 60 s for any run, and additionally 1 per hour for a full one. Auth via cookie or Bearer.",
      requestBody: {
        required: false,
        content: { "application/json": { schema: syncTriggerRequest } },
      },
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                syncTriggerOutcome,
                "WithingsSyncTriggerEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "Body is not parseable JSON. An ABSENT body is not this case — omit the body entirely for an incremental run.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body was present and failed the schema — `fullSync` was not a boolean. Nothing was synced. Note that this is a behaviour change: such a body used to be read as `fullSync: false` and answered 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "Either limiter tripped: more than 5 syncs in 60 s, or a second full sync within the hour. `meta.errorCode` = `rate_limited_self` for both; the message distinguishes them.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/whoop/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger a WHOOP sync",
      description:
        "Incremental by default; `{ fullSync: true }` walks full history across the four WHOOP resources. Two limiters apply, matching the Fitbit / Google Health siblings: 5 requests / 60 s for any run, and additionally 1 per hour for a full one. Auth via cookie or Bearer.",
      requestBody: {
        required: false,
        content: { "application/json": { schema: syncTriggerRequest } },
      },
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                syncTriggerOutcome,
                "WhoopSyncTriggerEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "Body is not parseable JSON. An ABSENT body is not this case — omit the body entirely for an incremental run.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body was present and failed the schema — `fullSync` was not a boolean. Nothing was synced. Note that this is a behaviour change: such a body used to be read as `fullSync: false` and answered 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "Either limiter tripped: more than 5 syncs in 60 s, or a second full sync within the hour. `meta.errorCode` = `rate_limited_self` for both; the message distinguishes them.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/whoop/connect/ticket": {
    post: {
      tags: ["Integrations"],
      summary: "Mint a one-time WHOOP connect ticket",
      description:
        "Bearer-capable by design: a native client with no browser session mints a ticket here, then opens `GET /api/whoop/connect?ticket=<opaque>` in an in-app web session to run the WHOOP OAuth handshake. THE RESPONSE CARRIES THE RAW TICKET — only its hash is stored, so it cannot be retrieved again; it is short-lived and single-use. No body. Rate-limited 10 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description:
            "Ticket minted. The `ticket` field is the only copy of the credential.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  ticket: z
                    .string()
                    .describe(
                      "Opaque one-time connect ticket, returned exactly once. Treat as a secret: pass it only as the `ticket` query parameter of the connect URL, and never log it.",
                    ),
                }),
                "WhoopConnectTicketEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "No WHOOP client id and secret are stored for this user, so a ticket could not complete the handshake. Store the credentials first. Note that this is 400, not the 422 the probe endpoints answer for the same condition.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "429": {
          description: "More than 10 ticket mints in 60 s from this user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/fitbit/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether Fitbit BYO-key credentials are stored",
      description: "Presence only. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                credentialsPresenceResponse,
                "FitbitCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's Fitbit BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: fitbitCredentialsRequest } },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updatedAck,
                "FitbitCredentialsUpdateEnvelope",
              ),
            },
          },
        },
        ...jsonBody64k,
        ...stdResponses,
        ...credentialsRejected422,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's Fitbit credentials and connection",
      description:
        "Deletes the connection row, clears both credential columns, audits the teardown and parks the `fitbit` ledger at `disconnected`. Idempotent — a missing connection row is a benign no-op, so a repeat call still answers 200. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deletedAck,
                "FitbitCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fitbit/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Fitbit connection status",
      description:
        "Reports the BYO-key marker plus the connection row's last sync, token expiry, granted scope and backfill progress. Pure read — no refresh, no ledger write. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                fitbitStatusResponse,
                "FitbitStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fitbit/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Fitbit account",
      description:
        "Deletes the connection row, audits the teardown and parks the `fitbit` ledger at `disconnected`. There is nothing to unsubscribe upstream — the integration polls. The BYO-key credentials are deliberately LEFT IN PLACE so a reconnect does not force the user to re-paste them; use the credentials DELETE to remove those too. No body. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(disconnectedAck, "FitbitDisconnectEnvelope"),
            },
          },
        },
        "404": {
          description:
            "No Fitbit connection to remove. NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fitbit/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger a Fitbit sync",
      description:
        "Incremental by default; `{ fullSync: true }` walks full history across four paginated resources. Two limiters apply: 5 requests / 60 s for any run, and additionally 1 per hour for a full one, because the classic Web API budget is 150 requests per hour per user. Auth via cookie or Bearer.",
      requestBody: {
        required: false,
        content: { "application/json": { schema: syncTriggerRequest } },
      },
      responses: {
        "200": {
          description: "Sync run complete.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                syncTriggerOutcome,
                "FitbitSyncTriggerEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "Body is not parseable JSON. An ABSENT body is not this case — omit the body entirely for an incremental run.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body was present and failed the schema — `fullSync` was not a boolean. Nothing was synced. Note that this is a behaviour change: such a body used to be read as `fullSync: false` and answered 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "Either limiter tripped: more than 5 syncs in 60 s, or a second full sync within the hour. `meta.errorCode` = `rate_limited_self` for both; the message distinguishes them.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/google-health/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether Google Health BYO-key credentials are stored",
      description: "Presence only. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                credentialsPresenceResponse,
                "GoogleHealthCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's Google Health BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: googleHealthCredentialsRequest },
        },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updatedAck,
                "GoogleHealthCredentialsUpdateEnvelope",
              ),
            },
          },
        },
        ...jsonBody64k,
        ...stdResponses,
        ...credentialsRejected422,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's Google Health credentials and connection",
      description:
        "Deletes the connection row, clears both credential columns, audits the teardown and parks the `google-health` ledger at `disconnected`. Idempotent — a missing connection row is a benign no-op, so a repeat call still answers 200. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deletedAck,
                "GoogleHealthCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/google-health/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Google Health connection status",
      description:
        "Reports the BYO-key marker plus the connection row's last sync, token expiry, granted scope, backfill progress and the `needsReauth` soft-disconnect flag. Pure read — no refresh, no ledger write. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                googleHealthStatusResponse,
                "GoogleHealthStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/google-health/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Google Health account",
      description:
        "Deletes the connection row, audits the teardown and parks the `google-health` ledger at `disconnected`. Deleting the encrypted token pair is the effective revocation; there is no subscription to tear down. The BYO-key credentials are deliberately LEFT IN PLACE. No body. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disconnectedAck,
                "GoogleHealthDisconnectEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No Google Health connection to remove. NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/google-health/sync": {
    post: {
      tags: ["Integrations"],
      summary: "Trigger a Google Health sync",
      description:
        'Incremental by default; `{ fullSync: true }` walks full history across every data type, each capped at 1000 pages. Two limiters apply: 5 requests / 60 s for any run, and additionally 1 per hour for a full one. Unlike every sibling sync, this one can answer 502: a run that failed AND wrote nothing is an error, while a run that failed after writing some resources is a 200 with `outcome: "partial"` — the honest half of the result is not thrown away. Auth via cookie or Bearer.',
      requestBody: {
        required: false,
        content: { "application/json": { schema: syncTriggerRequest } },
      },
      responses: {
        "200": {
          description:
            "Sync run complete, wholly or partly. Carries the per-collection breakdown.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                googleHealthSyncOutcome,
                "GoogleHealthSyncTriggerEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "400": {
          description:
            "Body is not parseable JSON. An ABSENT body is not this case — omit the body entirely for an incremental run.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "502": {
          description:
            "The run failed and wrote nothing. A run that wrote something before failing answers 200 instead.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body was present and failed the schema — `fullSync` was not a boolean. Nothing was synced. Note that this is a behaviour change: such a body used to be read as `fullSync: false` and answered 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "Either limiter tripped: more than 5 syncs in 60 s, or a second full sync within the hour. `meta.errorCode` = `rate_limited_self`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/oura/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether Oura BYO-key credentials are stored",
      description:
        "Presence only. `false` is not a misconfiguration: with no BYO pair the integration falls back to the operator's shared env app. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                credentialsPresenceResponse,
                "OuraCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's Oura BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: ouraCredentialsRequest } },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(updatedAck, "OuraCredentialsUpdateEnvelope"),
            },
          },
        },
        ...jsonBody64k,
        ...stdResponses,
        ...credentialsRejected422,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's Oura credentials and connection",
      description:
        "Clears the stored access and refresh tokens as well as the BYO pair — a token minted against a deleted app is orphaned, so the grant goes with the keys. Always answers 200, and always audits the teardown and parks the `oura` ledger at `disconnected`, whether or not a token was present. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and any connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(deletedAck, "OuraCredentialsDeleteEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/oura/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Oura connection status",
      description:
        "Reports whether usable credentials resolve at all, whether the user brought their own, and the ledger snapshot plus liveness verdict when a token is stored. Tokens and the client secret are never returned. Pure read. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                oauthProviderStatusResponse,
                "OuraStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/oura/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Oura account",
      description:
        "Clears the stored access and refresh tokens, audits the teardown and parks the `oura` ledger at `disconnected`. The BYO-key credentials are left in place. Imported readings stay; a reconnect resumes sync. No body. Rate-limited 20 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was cleared.",
          content: {
            "application/json": {
              schema: dataEnvelope(disconnectedAck, "OuraDisconnectEnvelope"),
            },
          },
        },
        "404": {
          description:
            "No Oura token stored. NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/oura/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's Oura grant",
      description:
        "Fetches the personal-info record, the cheapest authenticated Oura call, to confirm the stored grant still works. No body, nothing written. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached Oura.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerProbeResponse, "OuraTestEnvelope"),
            },
          },
        },
        ...probeFailure502,
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
      },
    },
  },
  "/api/polar/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether Polar BYO-key credentials are stored",
      description:
        "Presence only. `false` is not a misconfiguration: with no BYO pair the integration falls back to the operator's shared env app. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                credentialsPresenceResponse,
                "PolarCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's Polar BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Audits the write — the only credentials PUT in this group that does. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: polarCredentialsRequest } },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updatedAck,
                "PolarCredentialsUpdateEnvelope",
              ),
            },
          },
        },
        ...jsonBody64k,
        ...stdResponses,
        ...credentialsRejected422,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's Polar credentials and connection",
      description:
        "Clears the stored access token and member id as well as the BYO pair — a token minted under a deleted AccessLink app is orphaned, so the grant goes with the keys. Always answers 200, and always audits the teardown and parks the `polar` ledger at `disconnected`, whether or not a token was present. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and any connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deletedAck,
                "PolarCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/polar/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Polar connection status",
      description:
        "Reports whether usable credentials resolve at all, whether the user brought their own, and the ledger snapshot plus liveness verdict when a token is stored. The access token, member id and client secret are never returned. Pure read. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                oauthProviderStatusResponse,
                "PolarStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/polar/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Polar account",
      description:
        "Clears the stored token and member id, audits the teardown and parks the `polar` ledger at `disconnected`. The BYO-key credentials are left in place. Imported readings stay. No body. Rate-limited 20 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was cleared.",
          content: {
            "application/json": {
              schema: dataEnvelope(disconnectedAck, "PolarDisconnectEnvelope"),
            },
          },
        },
        "404": {
          description:
            "No Polar token stored. NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/polar/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's Polar grant",
      description:
        "Fetches the registered AccessLink user record, the cheapest authenticated Polar call, to confirm the stored grant still works. No body, nothing written. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached Polar.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerProbeResponse, "PolarTestEnvelope"),
            },
          },
        },
        ...probeFailure502,
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
      },
    },
  },
  "/api/strava/credentials": {
    get: {
      tags: ["Integrations"],
      summary: "Check whether Strava BYO-key credentials are stored",
      description:
        "Presence only. `false` is not a misconfiguration: with no BYO pair the integration falls back to the operator's shared env app. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credential presence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                credentialsPresenceResponse,
                "StravaCredentialsStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Integrations"],
      summary: "Store the caller's Strava BYO-key credentials",
      description:
        "Replaces both values; there is no partial update. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: stravaCredentialsRequest } },
      },
      responses: {
        "200": {
          description: "Credentials stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updatedAck,
                "StravaCredentialsUpdateEnvelope",
              ),
            },
          },
        },
        ...jsonBody64k,
        ...stdResponses,
        ...credentialsRejected422,
      },
    },
    delete: {
      tags: ["Integrations"],
      summary: "Delete the caller's Strava credentials and connection",
      description:
        "Clears the stored access token, refresh token and athlete id as well as the BYO pair. Always answers 200, and always audits the teardown and parks the `strava` ledger at `disconnected`, whether or not a token was present. Note that this path does NOT deauthorize at Strava — only `POST /api/strava/disconnect` does, so removing the credentials here leaves the app authorised on the user's Strava account. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Credentials and any connection removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deletedAck,
                "StravaCredentialsDeleteEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/strava/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read the caller's Strava connection status",
      description:
        "Reports whether usable credentials resolve at all, whether the user brought their own, and the ledger snapshot plus liveness verdict when a token is stored. Tokens and the client secret are never returned. Pure read. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Connection status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                oauthProviderStatusResponse,
                "StravaStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/strava/disconnect": {
    post: {
      tags: ["Integrations"],
      summary: "Disconnect the caller's Strava account",
      description:
        "Best-effort deauthorizes at Strava, then clears the stored tokens and athlete id, audits the teardown and parks the `strava` ledger at `disconnected`. A Strava-side outage does not block the local teardown, so a 200 here does not prove the app was deauthorised upstream. Imported workouts stay. No body. Rate-limited 20 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The connection was cleared locally.",
          content: {
            "application/json": {
              schema: dataEnvelope(disconnectedAck, "StravaDisconnectEnvelope"),
            },
          },
        },
        "404": {
          description:
            "No Strava connection. NOT an idempotent no-op: a second disconnect answers 404 rather than 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/strava/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's Strava grant",
      description:
        "Fetches the authenticated athlete, the cheapest authenticated Strava call, to confirm the stored grant still works. No body, nothing written. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached Strava.",
          content: {
            "application/json": {
              schema: dataEnvelope(providerProbeResponse, "StravaTestEnvelope"),
            },
          },
        },
        ...probeFailure502,
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/status": {
    get: {
      tags: ["Integrations"],
      summary: "Read every integration's status in one call",
      description:
        "The consolidated envelope behind the integrations settings surface: all eight providers, always, in a fixed order, each with the ledger core, the server-resolved liveness verdict and its own extras. Prefer this over eight per-provider round-trips. Pure read. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "All eight provider entries plus the alert threshold.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                integrationStatusEnvelope,
                "IntegrationStatusEnvelopeResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/integrations/fitbit/resume": {
    post: {
      tags: ["Integrations"],
      summary: "Clear a parked Fitbit integration",
      description:
        "A provider whose persistent-failure streak has run for more than 24 h is parked, and the sync entry point short-circuits until somebody clears it. This clears it; the next cron tick attempts again. No body, no upstream call. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Park cleared, or nothing to clear.",
          content: {
            "application/json": {
              schema: dataEnvelope(resumeResponse, "FitbitResumeEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/fitbit/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's Fitbit connection",
      description:
        "Resolves a valid access token (refreshing if needed) and fetches the profile endpoint. Returns the connection's `lastSyncedAt` alongside the probe result — the shape difference from the `/api/<provider>/test` family. No body, nothing written beyond whatever the token refresh persists. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached Fitbit.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                integrationProbeResponse,
                "FitbitIntegrationTestEnvelope",
              ),
            },
          },
        },
        ...probeFailure502,
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/google-health/resume": {
    post: {
      tags: ["Integrations"],
      summary: "Clear a parked Google Health integration",
      description:
        "Identical contract to the Fitbit / WHOOP / Withings resume endpoints — same body (none), same response, same limiter. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Park cleared, or nothing to clear.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                resumeResponse,
                "GoogleHealthResumeEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/google-health/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's Google Health connection",
      description:
        'Two endpoints in one, selected by the body. With no body (or any body other than the one below) it behaves like its Fitbit / WHOOP / Withings siblings: fetch the profile endpoint and answer `{ ok, lastSyncedAt, latencyMs }`. With `{ "probe": "structure" }` it instead walks one page or window per Google Health data type and answers a per-type diagnostic map — a completely different response shape under the same status code, so a client MUST branch on what it sent. The structure map reduces every leaf to its type name and never carries a value, a timestamp or an identifier, so the output is safe to paste into a public support thread. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.',
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z
              .object({
                probe: z
                  .literal("structure")
                  .optional()
                  .describe(
                    'Send `"structure"` for the per-data-type diagnostic. Anything else, including a malformed body, runs the plain connection check — the body is not validated and a typo is silently ignored rather than refused.',
                  ),
              })
              .meta({ id: "GoogleHealthTestRequest" }),
          },
        },
      },
      responses: {
        "200": {
          description:
            "Either the plain probe result or the structure map, depending on the body sent.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.union([
                  integrationProbeResponse,
                  z
                    .object({
                      probe: z.literal("structure"),
                      probedAt: z.iso.datetime({ offset: true }),
                      types: z
                        .record(z.string(), z.unknown())
                        .describe(
                          "One entry per Google Health data type. A successful entry carries `{ ok: true, count, structure }` plus, where the client learned it, `requestShape` (which documented request form Google accepted) and `envelopeKeys` (raw first-page key names, present only when the parse yielded zero points — the one signal separating 'nothing returned' from 'returned under a key this reader does not know'). A failed entry carries `{ ok: false, httpStatus, classification, detail }`. `structure` is the first data point with every leaf replaced by its type name.",
                        ),
                    })
                    .meta({ id: "GoogleHealthStructureProbeResponse" }),
                ]),
                "GoogleHealthIntegrationTestEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...probeFailure502,
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/whoop/resume": {
    post: {
      tags: ["Integrations"],
      summary: "Clear a parked WHOOP integration",
      description:
        "Identical contract to the Fitbit / Google Health / Withings resume endpoints — same body (none), same response, same limiter. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Park cleared, or nothing to clear.",
          content: {
            "application/json": {
              schema: dataEnvelope(resumeResponse, "WhoopResumeEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/whoop/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's WHOOP connection",
      description:
        "Resolves a valid access token (refreshing if needed) and fetches the basic-profile endpoint. Returns the connection's `lastSyncedAt` alongside the probe result. No body. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached WHOOP.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                integrationProbeResponse,
                "WhoopIntegrationTestEnvelope",
              ),
            },
          },
        },
        ...probeFailure502,
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/withings/resume": {
    post: {
      tags: ["Integrations"],
      summary: "Clear a parked Withings integration",
      description:
        "Identical contract to the Fitbit / Google Health / WHOOP resume endpoints — same body (none), same response, same limiter. For Withings the park is typically reached through a run of contract-mismatch errors rather than an expired grant. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Park cleared, or nothing to clear.",
          content: {
            "application/json": {
              schema: dataEnvelope(resumeResponse, "WithingsResumeEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...selfRateLimited429,
      },
    },
  },
  "/api/integrations/withings/test": {
    post: {
      tags: ["Integrations"],
      summary: "Probe the caller's Withings connection",
      description:
        "Resolves a valid access token and asks for one recent measure. Withings signals API-level failure with HTTP 200 and a status code in the JSON body, so this probe inspects the body as well as the status — a 200 from Withings can still be a `credentials_rejected` 502 from here. No body. Rate-limited 5 requests / 60 s per user. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The probe reached Withings and the body reported OK.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                integrationProbeResponse,
                "WithingsIntegrationTestEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...probeNotConfigured422,
        ...selfRateLimited429,
        "502": {
          description:
            "The probe did not complete. The shared codes apply (`credentials_rejected`, `rate_limited`, `upstream_error`, `timeout`, `connection_failed`) and this path adds one of its own: `upstream_invalid_json`, when Withings answered 200 with a body that would not parse. Withings' in-body status codes are mapped onto the same shared set, so a body-level rejection is indistinguishable from an HTTP-level one by errorCode alone.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
