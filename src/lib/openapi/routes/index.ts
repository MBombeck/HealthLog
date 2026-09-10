/**
 * OpenAPI route table — thin aggregation index.
 *
 * The route table is split into domain modules under this directory;
 * this index assembles them into the single `openApiPaths` object the
 * registry consumes. The spread order below is load-bearing: the YAML
 * emitter runs with `sortMapEntries: false` (see
 * `scripts/generate-openapi.ts`), so the key order of this object is
 * the path order of the committed `docs/api/openapi.yaml`. Keep the
 * spread sequence stable when adding a module — append inside the
 * domain module, not by reordering here.
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
import type { ZodOpenApiObject } from "zod-openapi";

import {
  accountSelectorParameter,
  accountSharingPaths,
  recordEpochParameter,
  recordScopeParameter,
} from "./account-sharing";
import { adminDiagnosticPaths, adminInvitePaths } from "./admin";
import { adminBackupPaths } from "./admin-backups";
import { allergyPaths } from "./allergies";
import { analyticsPaths } from "./analytics";
import { authPaths } from "./auth";
import { awardsPaths } from "./awards";
import { environmentPaths } from "./environment";
import { healthPaths } from "./health";
import { ingestPaths } from "./ingest";
import {
  coachFeedbackPaths,
  coachPaths,
  coachReminderSuggestionPaths,
  coachReminderPaths,
  coachSuggestedActionPaths,
} from "./coach";
import { consentPaths } from "./consent";
import { customMetricPaths } from "./custom-metrics";
import { dailyPaths } from "./daily";
import { cyclePaths } from "./cycle";
import { dashboardWidgetPaths } from "./dashboard";
import { biomarkerPaths } from "./biomarkers";
import { inboundDocumentPaths } from "./documents";
import { devicePaths } from "./devices";
import { exportPaths } from "./export";
import { familyHistoryPaths } from "./family-history";
import { healthRecordPaths } from "./health-record";
import { encounterPaths } from "./encounters";
import { vaccinationPaths } from "./vaccinations";
import { illnessPaths } from "./illness";
import { importPaths } from "./import";
import { insightsPaths, wellnessScoreValue } from "./insights";
import { integrationPaths } from "./integrations";
import { insightsSignalPaths } from "./insights-signals";
import { labsPaths } from "./labs";
import { ocrPaths } from "./ocr";
import { measurementPaths } from "./measurements";
import { measurementReminderPaths } from "./measurement-reminders";
import { mentalHealthPaths } from "./mental-health";
import {
  medicationPaths,
  medicationResource,
  medicationDoseHistoryImportFatalReasonEnum,
} from "./medications";
import { mcpPaths } from "./mcp";
import { metaPaths } from "./meta";
import { moodPaths, moodTagLayout } from "./mood";
import { notificationTransportPaths } from "./notifications-transport";
import { notificationChannelPaths } from "./notifications";
import { nutrientPaths } from "./nutrients";
import { onboardingPaths } from "./onboarding";
import { profilePaths } from "./profile";
import { recordSettingsPaths } from "./record-settings";
import { retiredPaths } from "./retired";
import { settingsPaths } from "./settings";
import { syncPaths } from "./sync";
import { workoutPaths } from "./workouts";
import { coachPrefsSchema } from "./shared";

export const openApiPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  ...cyclePaths,
  ...metaPaths,
  ...healthRecordPaths,
  ...exportPaths,
  ...authPaths,
  ...syncPaths,
  ...measurementPaths,
  ...workoutPaths,
  ...devicePaths,
  ...medicationPaths,
  ...profilePaths,
  ...coachPaths,
  ...coachReminderSuggestionPaths,
  ...coachReminderPaths,
  ...coachSuggestedActionPaths,
  ...adminInvitePaths,
  ...coachFeedbackPaths,
  ...adminDiagnosticPaths,
  ...insightsPaths,
  ...insightsSignalPaths,
  ...moodPaths,
  ...settingsPaths,
  ...consentPaths,
  ...importPaths,
  ...measurementReminderPaths,
  ...labsPaths,
  ...ocrPaths,
  ...biomarkerPaths,
  ...encounterPaths,
  ...vaccinationPaths,
  ...illnessPaths,
  ...mentalHealthPaths,
  ...allergyPaths,
  ...familyHistoryPaths,
  ...inboundDocumentPaths,
  ...customMetricPaths,
  ...onboardingPaths,
  // v1.28 — nutrient-intake sync (appended; spread order is load-bearing).
  ...nutrientPaths,
  // v1.28 — HealthKit integration config (appended; spread order is
  // load-bearing).
  ...integrationPaths,
  // v1.28 — the unified daily digest (P3 spine; appended, spread order is
  // load-bearing).
  ...dailyPaths,
  // v1.32.21 (R5a) — dashboard widget layout: previously absent from the
  // registry entirely, now documented as the reference optimistic-concurrency
  // contract (appended, spread order is load-bearing).
  ...dashboardWidgetPaths,
  // v1.36.0 — account sharing: the grant lifecycle and the switch endpoint
  // (appended, spread order is load-bearing).
  ...accountSharingPaths,
  // Notification transport — the VAPID key, the Web Push subscription
  // lifecycle and the per-channel self-tests (appended, spread order is
  // load-bearing).
  ...notificationTransportPaths,
  // Notification channels + MCP connector credentials: both families answered
  // the native client for several releases while being absent from the
  // registry, because `openapi:check` compares the registry against the YAML
  // and never the routes against the registry (appended, spread order is
  // load-bearing).
  ...notificationChannelPaths,
  ...mcpPaths,
  // The managed record's own configuration tree. Kept out of the sharing module
  // because it is the one surface fenced by `requireGuardianAuth`, and its 403
  // therefore has to be the shared refusal sentence rather than the neighbouring
  // module's local wording (appended, spread order is load-bearing).
  ...recordSettingsPaths,
  // Routes that existed for releases without ever reaching the registry, so
  // `openapi:check` saw no drift and reported nothing: it compares the
  // registry against the committed YAML and has never compared the routes on
  // disk against the registry. Appended, spread order is load-bearing.
  ...healthPaths,
  ...analyticsPaths,
  ...awardsPaths,
  ...environmentPaths,
  ...ingestPaths,
  // The two backups-console routes that open a stored copy. The rest of the
  // family stays unpublished — it is a cookie-only console — but these two
  // carry a refusal an operator has to be able to look up rather than
  // discover: a copy this instance can no longer decrypt (appended, spread
  // order is load-bearing).
  ...adminBackupPaths,
  // The environmental-context overview. Its own module because nothing else
  // owns the surface (appended, spread order is load-bearing).
  //
  // Last, and last on purpose: these are the tombstones, the only published
  // paths with no route module behind them. A reader scrolling the emitted
  // YAML meets the live surface before the removed one (appended, spread
  // order is load-bearing).
  ...retiredPaths,
};

export const openApiComponents: NonNullable<ZodOpenApiObject["components"]> = {
  // Schemas listed here are forced into `components.schemas` even when no
  // route references them directly. `Medication` lives in this slot
  // because its only consumers are the `MedicationListEntry` /
  // `MedicationDetail` variants which extend it — `.extend()` inlines
  // the base shape into the derived schema, so without an explicit
  // registration the standalone `Medication` component would never
  // emit. The iOS codegen reads from `Medication` directly for the
  // shared Swift struct backing both variants.
  //
  // `MedicationDoseHistoryImportFatalReason` lives here for the same reason:
  // the dose-history-import 422 description names it as the closed set
  // behind `errorCode`, but `ErrorEnvelope.meta.errorCode` is a bare string
  // shared by every route, so nothing ever `$ref`s the enum itself. Without
  // this forced registration the schema the description points to would be
  // silently absent from the published spec.
  //
  // `MoodTagLayout` joins them for exactly the same reason: its annotation is
  // in the assigning form and correct, but both consumers `.extend()` it, so
  // the base name is never referenced and the description the mood surface
  // relies on would go unpublished.
  //
  // `CoachPrefs` is the same shape: the PUT `/api/auth/me/coach-prefs`
  // description tells the reader "Body is validated against `CoachPrefs`",
  // but every actual consumer is a `.extend()` of it (`PutCoachPrefsRequest`,
  // `CoachPrefsResponse`) — `.extend()` builds a new object, so the base
  // never carries forward to a $ref on its own.
  //
  // `WellnessScoreValue` is here for a different reason. `GET
  // /api/insights/derived` serves eighteen metrics through one envelope, so
  // its `value` has to stay an open record — no single `$ref` can describe
  // it. That left every metric's payload undocumented, and a client team read
  // the DTO and reported two fields as missing that were already on the wire.
  // Publishing the shape a `$ref` cannot reach is exactly what this slot is
  // for; the `value` description names it as the shape the three score ids
  // return.
  schemas: {
    Medication: medicationResource,
    MedicationDoseHistoryImportFatalReason:
      medicationDoseHistoryImportFatalReasonEnum,
    CoachPrefs: coachPrefsSchema,
    MoodTagLayout: moodTagLayout,
    WellnessScoreValue: wellnessScoreValue,
  },
  // v1.36.0 — the per-request account selector, defined in the sharing route
  // module so that `src/__tests__/acting-account-boundary-guard.test.ts` keeps
  // holding the header's name to two files: the resolver that reads it, and
  // the one place that publishes it.
  // v1.37.0 — the record-session fence's two request headers, defined in the
  // same module for the same reason: the fence guard holds their names to four
  // files, and this index references rather than restates them.
  parameters: {
    AccountSelector: accountSelectorParameter,
    RecordEpoch: recordEpochParameter,
    RecordScope: recordScopeParameter,
  },
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
