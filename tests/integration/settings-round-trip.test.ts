/**
 * Every setting a person can choose survives the whole trip: set through the
 * API, read back through the API and `/api/auth/me`, carried out in a backup,
 * restored into a fresh account, and read back there.
 *
 * The table below has one entry per write, and every `User` column the backup
 * classifies as a `SETTING` (a codec in `ACCOUNT_SETTING_CODECS`,
 * `src/lib/export/account-settings-backup.ts`) appears in exactly one entry. A new setting
 * column fails the inventory case until it is given an entry, which is the
 * point: the class of bug this file exists for is a setting that is stored but
 * not read back, read back but not published, or published but dropped by the
 * backup, and each of those used to be found by somebody restoring an account.
 *
 * Every request runs through the real API kit against the real database with
 * the kit's contract check, so each write and read is also checked against
 * the OpenAPI registry the native client is generated from.
 *
 * The backup leg goes through the routes too: the portable full backup a
 * person downloads, the operator's upload, and the operator's restore into an
 * account recreated under the same id, the way an account is brought back on
 * a new host. Only the restore's queue hop is replaced (see
 * `restore-job-driver.ts`).
 */
import { isDeepStrictEqual } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import type { User } from "@/generated/prisma/client";
import {
  USER_COLUMN_BACKUP_CLASS,
  type AccountSettingColumn,
} from "@/lib/export/account-settings-backup";

import { GET as getMe } from "@/app/api/auth/me/route";
import * as profile from "@/app/api/user/profile/route";
import * as diabetes from "@/app/api/auth/me/diabetes/route";
import * as autoAiRead from "@/app/api/auth/me/documents-auto-ai-read/route";
import * as labsOcr from "@/app/api/auth/me/labs-local-ocr/route";
import * as workoutRoutes from "@/app/api/auth/me/workout-routes/route";
import * as centralCodex from "@/app/api/auth/me/use-central-codex/route";
import * as disableCoach from "@/app/api/auth/me/disable-coach/route";
import * as unitPreference from "@/app/api/auth/me/unit-preference/route";
import * as glucoseUnit from "@/app/api/auth/me/glucose-unit/route";
import * as injectionSites from "@/app/api/auth/me/injection-site-prefs/route";
import * as modules from "@/app/api/auth/me/modules/route";
import * as healthScore from "@/app/api/auth/me/health-score-config/route";
import * as sourcePriority from "@/app/api/auth/me/source-priority/route";
import * as notificationPrefs from "@/app/api/auth/me/notification-prefs/route";
import * as reportSelection from "@/app/api/auth/me/report-selection/route";
import * as coachPrefs from "@/app/api/auth/me/coach-prefs/route";
import { PUT as putAiUsage } from "@/app/api/auth/me/ai-usage/route";
import { POST as dismissPasskeyNudge } from "@/app/api/auth/me/passkey-nudge/dismiss/route";
import { GET as getMfa } from "@/app/api/auth/me/mfa/route";
import { POST as uploadAvatar } from "@/app/api/user/avatar/route";
import { GET as getAvatar } from "@/app/api/user/avatar/[id]/route";
import * as aiProvider from "@/app/api/user/ai-provider/route";
import * as providerChain from "@/app/api/insights/provider-chain/route";
import * as insightsSettings from "@/app/api/insights/settings/route";
import { POST as completeOnboarding } from "@/app/api/onboarding/complete/route";
import { POST as onboardingTour } from "@/app/api/onboarding/tour/route";
import { POST as onboardingDisclaimer } from "@/app/api/onboarding/disclaimer/route";
import { GET as getEnvironment } from "@/app/api/environment/route";
import { PUT as putHome } from "@/app/api/environment/home/route";
import { PATCH as patchEnvironmentPrefs } from "@/app/api/environment/preferences/route";
import * as thresholds from "@/app/api/user/thresholds/route";
import * as dashboardWidgets from "@/app/api/dashboard/widgets/route";
import * as insightsLayout from "@/app/api/insights/layout/route";
import * as medicationLayout from "@/app/api/medications/layout/route";
import * as moodTagLayout from "@/app/api/mood/tags/layout/route";
import * as documentsLayout from "@/app/api/documents/inbound/layout/route";
import * as moduleListLayout from "@/app/api/settings/module-list-layout/route";
import * as activityGoals from "@/app/api/activity/goals/route";
import * as healthKit from "@/app/api/integrations/healthkit/route";
import { POST as exportHealthRecord } from "@/app/api/export/health-record/route";
import { GET as exportFullBackup } from "@/app/api/export/full-backup/route";
import { POST as uploadBackup } from "@/app/api/admin/backups/upload/route";

import {
  callRoute,
  type CallRouteOptions,
  type HttpMethod,
  type RouteResult,
} from "../kit/call-route";
import {
  makeAdmin,
  makeSession,
  makeUser,
  type SessionFixture,
} from "../kit/factories";
import { POST as restoreBackup } from "./restore-job-driver";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

type Handler = Parameters<typeof callRoute>[0];

interface Call {
  handler: Handler;
  method: HttpMethod;
  route: string;
  params?: Record<string, string>;
  body?: unknown;
  contract?: CallRouteOptions["contract"];
}

interface Read {
  call: Call;
  /** What a client reads off the answer. */
  pick: (res: RouteResult) => unknown;
}

interface Entry {
  /** The `User` columns this write sets. */
  columns: readonly AccountSettingColumn[];
  write: Call;
  /**
   * How the value is read back. Every entry has one, so a setting that can
   * be written but not read is a missing route, not a missing check.
   */
  read: Read;
  /** The value `read.pick` must return after the write. */
  expected?: unknown;
  /** Where `/api/auth/me` publishes it, when it does. */
  me?: { pick: (me: unknown) => unknown; expected?: unknown };
}

/** `data.a.b[0].c` of a response, by a dotted path. */
function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

const data =
  (path: string) =>
  (res: RouteResult): unknown =>
    at(res.data, path);

const get = (handler: Handler, route: string, path: string): Read => ({
  call: { handler, method: "GET", route },
  pick: data(path),
});

/** A 1×1 PNG: the smallest image the avatar route's sniffing accepts. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function avatarForm(): FormData {
  const form = new FormData();
  form.append("file", new File([PNG], "avatar.png", { type: "image/png" }));
  return form;
}

/**
 * In the order they run. Onboarding first, because a fresh account starts
 * without it; the doctor report before the report selection, because the
 * export also stores the selection it was given.
 */
function entries(user: Pick<User, "id">): Entry[] {
  return [
    {
      columns: ["onboardingCompletedAt"],
      write: {
        handler: completeOnboarding,
        method: "POST",
        route: "/api/onboarding/complete",
        body: {},
      },
      read: {
        call: { handler: getMe, method: "GET", route: "/api/auth/me" },
        pick: data("onboardingCompletedAt"),
      },
      me: { pick: (me) => typeof at(me, "onboardingCompletedAt") },
    },
    {
      columns: ["onboardingTourCompleted", "onboardingTourProgressJson"],
      write: {
        handler: onboardingTour,
        method: "POST",
        route: "/api/onboarding/tour",
        body: {
          completed: true,
          outcome: "completed",
          progress: {
            lastStopId: "mood",
            completedStopIds: ["dashboard"],
            status: "in_progress",
            updatedAt: "2026-10-22T10:00:00.000Z",
          },
        },
      },
      read: get(getMe, "/api/auth/me", "onboardingTourProgress.lastStopId"),
      expected: "mood",
      me: { pick: (me) => at(me, "onboardingTourCompleted"), expected: true },
    },
    {
      columns: ["disclaimerAcknowledgedAt", "disclaimerAcknowledgedVersion"],
      write: {
        handler: onboardingDisclaimer,
        method: "POST",
        route: "/api/onboarding/disclaimer",
        body: { version: "2026-06-18" },
      },
      read: get(getMe, "/api/auth/me", "disclaimerAcknowledgedVersion"),
      expected: "2026-06-18",
      me: {
        pick: (me) => typeof at(me, "disclaimerAcknowledgedAt"),
        expected: "string",
      },
    },
    {
      columns: [
        "heightCm",
        "dateOfBirth",
        "gender",
        "displayName",
        "fullName",
        "insurerName",
        "insuranceNumberEncrypted",
        "insurerIkNumber",
        "locale",
        "timezone",
        "timeFormat",
        "dateFormat",
        "moodReminderEnabled",
      ],
      write: {
        handler: profile.PATCH,
        method: "PATCH",
        route: "/api/user/profile",
        body: {
          heightCm: 182,
          dateOfBirth: "1985-04-12",
          gender: "FEMALE",
          displayName: "Kit Person",
          fullName: "Kit Example Person",
          insurerName: "Example Insurer",
          insuranceNumber: "A123456780",
          insurerIkNumber: "123456789",
          locale: "en",
          timezone: "America/New_York",
          timeFormat: "H12",
          dateFormat: "YMD",
          moodReminderEnabled: true,
        },
      },
      read: {
        call: {
          handler: profile.GET,
          method: "GET",
          route: "/api/user/profile",
        },
        pick: (res) => {
          const d = res.data as Record<string, unknown>;
          return {
            heightCm: d.heightCm,
            dateOfBirth: String(d.dateOfBirth).slice(0, 10),
            gender: d.gender,
            displayName: d.displayName,
            fullName: d.fullName,
            insurerName: d.insurerName,
            insuranceNumber: d.insuranceNumber,
            insurerIkNumber: d.insurerIkNumber,
            locale: d.locale,
            timezone: d.timezone,
            timeFormat: d.timeFormat,
            dateFormat: d.dateFormat,
            moodReminderEnabled: d.moodReminderEnabled,
          };
        },
      },
      expected: {
        heightCm: 182,
        dateOfBirth: "1985-04-12",
        gender: "FEMALE",
        displayName: "Kit Person",
        fullName: "Kit Example Person",
        insurerName: "Example Insurer",
        insuranceNumber: "A123456780",
        insurerIkNumber: "123456789",
        locale: "en",
        timezone: "America/New_York",
        timeFormat: "H12",
        dateFormat: "YMD",
        moodReminderEnabled: true,
      },
      me: {
        pick: (me) => ({
          heightCm: at(me, "heightCm"),
          gender: at(me, "gender"),
          displayName: at(me, "displayName"),
          insuranceNumber: at(me, "insuranceNumber"),
          timezone: at(me, "timezone"),
          timeFormat: at(me, "timeFormat"),
          dateFormat: at(me, "dateFormat"),
        }),
        expected: {
          heightCm: 182,
          gender: "FEMALE",
          displayName: "Kit Person",
          insuranceNumber: "A123456780",
          timezone: "America/New_York",
          timeFormat: "H12",
          dateFormat: "YMD",
        },
      },
    },
    {
      columns: ["hasDiabetes"],
      write: {
        handler: diabetes.PATCH,
        method: "PATCH",
        route: "/api/auth/me/diabetes",
        body: { hasDiabetes: true },
      },
      read: get(diabetes.GET, "/api/auth/me/diabetes", "hasDiabetes"),
      expected: true,
    },
    {
      columns: ["documentsAutoAiRead"],
      write: {
        handler: autoAiRead.PATCH,
        method: "PATCH",
        route: "/api/auth/me/documents-auto-ai-read",
        body: { documentsAutoAiRead: true },
      },
      read: get(
        autoAiRead.GET,
        "/api/auth/me/documents-auto-ai-read",
        "documentsAutoAiRead",
      ),
      expected: true,
    },
    {
      columns: ["labsLocalOcrEnabled"],
      write: {
        handler: labsOcr.PATCH,
        method: "PATCH",
        route: "/api/auth/me/labs-local-ocr",
        body: { labsLocalOcrEnabled: true },
      },
      read: get(
        labsOcr.GET,
        "/api/auth/me/labs-local-ocr",
        "labsLocalOcrEnabled",
      ),
      expected: true,
    },
    {
      columns: ["storeWorkoutRoutes"],
      write: {
        handler: workoutRoutes.PATCH,
        method: "PATCH",
        route: "/api/auth/me/workout-routes",
        body: { storeWorkoutRoutes: true },
      },
      read: get(
        workoutRoutes.GET,
        "/api/auth/me/workout-routes",
        "storeWorkoutRoutes",
      ),
      expected: true,
    },
    {
      columns: ["useCentralCodex"],
      write: {
        handler: centralCodex.PATCH,
        method: "PATCH",
        route: "/api/auth/me/use-central-codex",
        body: { useCentralCodex: true },
      },
      read: get(
        centralCodex.GET,
        "/api/auth/me/use-central-codex",
        "useCentralCodex",
      ),
      expected: true,
    },
    {
      columns: ["disableCoach"],
      write: {
        handler: disableCoach.PATCH,
        method: "PATCH",
        route: "/api/auth/me/disable-coach",
        body: { disableCoach: true },
      },
      read: get(disableCoach.GET, "/api/auth/me/disable-coach", "disableCoach"),
      expected: true,
      me: { pick: (me) => at(me, "disableCoach"), expected: true },
    },
    {
      columns: ["unitPreference"],
      write: {
        handler: unitPreference.PATCH,
        method: "PATCH",
        route: "/api/auth/me/unit-preference",
        body: { unitPreference: "imperial" },
      },
      read: get(
        unitPreference.GET,
        "/api/auth/me/unit-preference",
        "unitPreference",
      ),
      expected: "imperial",
      me: { pick: (me) => at(me, "unitPreference"), expected: "imperial" },
    },
    {
      columns: ["glucoseUnit"],
      write: {
        handler: glucoseUnit.PATCH,
        method: "PATCH",
        route: "/api/auth/me/glucose-unit",
        body: { glucoseUnit: "mmol/L" },
      },
      read: get(glucoseUnit.GET, "/api/auth/me/glucose-unit", "glucoseUnit"),
      expected: "mmol/L",
      me: { pick: (me) => at(me, "glucoseUnit"), expected: "mmol/L" },
    },
    {
      columns: ["globalExcludedInjectionSites"],
      write: {
        handler: injectionSites.PATCH,
        method: "PATCH",
        route: "/api/auth/me/injection-site-prefs",
        body: {
          globalExcludedInjectionSites: ["THIGH_LEFT", "UPPER_ARM_RIGHT"],
        },
      },
      read: get(
        injectionSites.GET,
        "/api/auth/me/injection-site-prefs",
        "globalExcludedInjectionSites",
      ),
    },
    {
      columns: ["modulePreferencesJson"],
      write: {
        handler: modules.PATCH,
        method: "PATCH",
        route: "/api/auth/me/modules",
        body: { mood: false },
      },
      read: get(modules.GET, "/api/auth/me/modules", "modules.mood"),
      expected: false,
      me: { pick: (me) => at(me, "modules.mood"), expected: false },
    },
    {
      columns: ["healthScoreConfigJson"],
      write: {
        handler: healthScore.PATCH,
        method: "PATCH",
        route: "/api/auth/me/health-score-config",
        body: {
          pillars: [
            "BLOOD_PRESSURE",
            "GLYCAEMIA",
            "ACTIVITY",
            "SLEEP",
            "ADIPOSITY",
            "WELLBEING",
          ],
        },
      },
      read: get(
        healthScore.GET,
        "/api/auth/me/health-score-config",
        "excludedPillars",
      ),
      expected: ["LIPIDS"],
    },
    {
      columns: ["sourcePriorityJson"],
      write: {
        handler: sourcePriority.PUT,
        method: "PUT",
        route: "/api/auth/me/source-priority",
        body: { metricPriority: { steps: ["MANUAL"] } },
      },
      read: get(
        sourcePriority.GET,
        "/api/auth/me/source-priority",
        "metricPriority.steps.0",
      ),
      expected: "MANUAL",
    },
    {
      columns: ["notificationPrefs"],
      write: {
        handler: notificationPrefs.PATCH,
        method: "PATCH",
        route: "/api/auth/me/notification-prefs",
        body: { mood: { reminderHour: 7 } },
      },
      read: get(
        notificationPrefs.GET,
        "/api/auth/me/notification-prefs",
        "mood.reminderHour",
      ),
      expected: 7,
      me: {
        pick: (me) => at(me, "notificationPrefs.mood.reminderHour"),
        expected: 7,
      },
    },
    {
      columns: ["lastReportPracticeName"],
      write: {
        handler: exportHealthRecord,
        method: "POST",
        route: "/api/export/health-record",
        body: {
          format: "fhir",
          selection: { v: 2, leaves: ["PATIENT_IDENTITY"] },
          practiceName: "Example Practice",
        },
      },
      read: get(getMe, "/api/auth/me", "lastReportPracticeName"),
      expected: "Example Practice",
    },
    {
      columns: ["reportSelectionJson"],
      write: {
        handler: reportSelection.PUT,
        method: "PUT",
        route: "/api/auth/me/report-selection",
        body: {
          v: 2,
          leaves: ["PATIENT_IDENTITY", "MEDICATION_LIST"],
          format: "fhir",
          rangeDays: 30,
          includeCharts: false,
        },
      },
      read: get(
        reportSelection.GET,
        "/api/auth/me/report-selection",
        "profile.leaves",
      ),
      expected: ["PATIENT_IDENTITY", "MEDICATION_LIST"],
      me: { pick: (me) => at(me, "reportSelection.leaves") },
    },
    {
      columns: ["coachPrefsJson", "insightsExcludeMetrics"],
      write: {
        handler: coachPrefs.PUT,
        method: "PUT",
        route: "/api/auth/me/coach-prefs",
        body: {
          tone: "concise",
          verbosity: "brief",
          excludeMetrics: ["weight"],
          reasoning: "low",
        },
      },
      read: {
        call: {
          handler: coachPrefs.GET,
          method: "GET",
          route: "/api/auth/me/coach-prefs",
        },
        pick: (res) => ({
          tone: at(res.data, "tone"),
          verbosity: at(res.data, "verbosity"),
          excludeMetrics: at(res.data, "excludeMetrics"),
        }),
      },
      expected: {
        tone: "concise",
        verbosity: "brief",
        excludeMetrics: ["weight"],
      },
      me: {
        pick: (me) => at(me, "coachReasoning.preference"),
        expected: "low",
      },
    },
    {
      columns: ["aiUsageLevel"],
      write: {
        handler: putAiUsage,
        method: "PUT",
        route: "/api/auth/me/ai-usage",
        body: { level: "frugal" },
      },
      // The route has no GET; the account payload is where a client reads it.
      read: get(getMe, "/api/auth/me", "ai.usage.preference"),
      expected: "frugal",
    },
    {
      columns: ["passkeyUpgradeNudgeDismissed"],
      write: {
        handler: dismissPasskeyNudge,
        method: "POST",
        route: "/api/auth/me/passkey-nudge/dismiss",
      },
      read: get(getMfa, "/api/auth/me/mfa", "passkeyNudgeDismissed"),
      expected: true,
    },
    {
      columns: ["avatarBytes", "avatarContentType", "avatarUpdatedAt"],
      write: {
        handler: uploadAvatar,
        method: "POST",
        route: "/api/user/avatar",
        body: avatarForm(),
      },
      read: {
        call: {
          handler: getAvatar,
          method: "GET",
          route: "/api/user/avatar/{id}",
          params: { id: user.id },
        },
        pick: (res) => ({
          contentType: res.headers.get("content-type"),
          bytes: typeof res.body === "string" ? res.body.length : null,
        }),
      },
      me: { pick: (me) => at(me, "avatarUrl") },
    },
    {
      columns: [
        "aiProvider",
        "aiModel",
        "aiBaseUrl",
        "aiCompatBaseUrl",
        "aiCompatModel",
        "aiResponseTimeoutSeconds",
      ],
      write: {
        handler: aiProvider.PATCH,
        method: "PATCH",
        route: "/api/user/ai-provider",
        body: {
          provider: "LOCAL",
          model: "llama3.1:8b",
          baseUrl: "https://ollama.example.com",
          compatBaseUrl: "https://gateway.example.com/v1",
          compatModel: "gpt-4o-mini",
          responseTimeoutSeconds: 120,
        },
      },
      read: {
        call: {
          handler: aiProvider.GET,
          method: "GET",
          route: "/api/user/ai-provider",
        },
        pick: (res) => ({
          provider: at(res.data, "provider"),
          model: at(res.data, "model"),
          baseUrl: at(res.data, "baseUrl"),
          compatBaseUrl: at(res.data, "compatBaseUrl"),
          compatModel: at(res.data, "compatModel"),
          responseTimeoutSeconds: at(res.data, "responseTimeoutSeconds"),
        }),
      },
      expected: {
        provider: "LOCAL",
        model: "llama3.1:8b",
        baseUrl: "https://ollama.example.com",
        compatBaseUrl: "https://gateway.example.com/v1",
        compatModel: "gpt-4o-mini",
        responseTimeoutSeconds: 120,
      },
      me: {
        pick: (me) => at(me, "ai.provider.responseTimeoutMs"),
        expected: 120_000,
      },
    },
    {
      columns: ["aiProviderChain"],
      write: {
        handler: providerChain.PUT,
        method: "PUT",
        route: "/api/insights/provider-chain",
        body: {
          chain: [
            { providerType: "anthropic", enabled: true },
            { providerType: "openai", enabled: false },
          ],
        },
      },
      read: {
        call: {
          handler: providerChain.GET,
          method: "GET",
          route: "/api/insights/provider-chain",
        },
        pick: (res) =>
          (
            at(res.data, "configuredChain") as
              Array<Record<string, unknown>> | undefined
          )?.map((entry) => [entry.providerType, entry.enabled]),
      },
      expected: [
        ["anthropic", true],
        ["openai", false],
      ],
    },
    {
      columns: ["insightsPrivacyMode"],
      write: {
        handler: insightsSettings.PUT,
        method: "PUT",
        route: "/api/insights/settings",
        body: { privacyMode: "raw" },
      },
      read: get(insightsSettings.GET, "/api/insights/settings", "privacyMode"),
      expected: "raw",
    },
    {
      columns: ["homeLocationEncrypted", "homeTimezone", "homeSince"],
      write: {
        handler: putHome,
        method: "PUT",
        route: "/api/environment/home",
        body: {
          lat: 48.1,
          lon: 11.6,
          label: "Home",
          timezone: "Europe/Berlin",
        },
      },
      read: {
        call: {
          handler: getEnvironment,
          method: "GET",
          route: "/api/environment",
        },
        pick: (res) => ({
          lat: at(res.data, "home.lat"),
          lon: at(res.data, "home.lon"),
          label: at(res.data, "home.label"),
          timezone: at(res.data, "home.timezone"),
          since: typeof at(res.data, "home.since"),
        }),
      },
      expected: {
        lat: 48.1,
        lon: 11.6,
        label: "Home",
        timezone: "Europe/Berlin",
        since: "string",
      },
    },
    {
      columns: ["environmentAirQualityEnabled"],
      write: {
        handler: patchEnvironmentPrefs,
        method: "PATCH",
        route: "/api/environment/preferences",
        body: { airQualityEnabled: false },
      },
      read: get(getEnvironment, "/api/environment", "airQuality.enabled"),
      expected: false,
    },
    {
      columns: ["thresholdsJson"],
      write: {
        handler: thresholds.PUT,
        method: "PUT",
        route: "/api/user/thresholds",
        body: { PULSE: { min: 55, max: 95 } },
      },
      read: get(thresholds.GET, "/api/user/thresholds", "overrides.PULSE"),
      expected: { min: 55, max: 95 },
    },
    {
      columns: ["dashboardWidgetsJson"],
      write: {
        handler: dashboardWidgets.PUT,
        method: "PUT",
        route: "/api/dashboard/widgets",
        body: { version: 1, todayCardVisible: false },
      },
      read: get(
        dashboardWidgets.GET,
        "/api/dashboard/widgets",
        "todayCardVisible",
      ),
      expected: false,
    },
    {
      columns: ["insightsLayoutJson"],
      write: {
        handler: insightsLayout.PUT,
        method: "PUT",
        route: "/api/insights/layout",
        body: {
          version: 2,
          sections: [{ id: "vitals", visible: false, order: 0 }],
        },
      },
      read: {
        call: {
          handler: insightsLayout.GET,
          method: "GET",
          route: "/api/insights/layout",
        },
        pick: (res) =>
          (
            at(res.data, "sections") as
              Array<Record<string, unknown>> | undefined
          )?.find((s) => s.id === "vitals")?.visible,
      },
      expected: false,
    },
    {
      columns: ["medicationListLayoutJson"],
      write: {
        handler: medicationLayout.PUT,
        method: "PUT",
        route: "/api/medications/layout",
        body: { version: 1, view: "table" },
      },
      read: get(medicationLayout.GET, "/api/medications/layout", "view"),
      expected: "table",
    },
    {
      columns: ["moodTagLayoutJson"],
      write: {
        handler: moodTagLayout.PUT,
        method: "PUT",
        route: "/api/mood/tags/layout",
        body: { placements: { emotions: ["happy", "calm"] } },
      },
      read: get(
        moodTagLayout.GET,
        "/api/mood/tags/layout",
        "placements.emotions",
      ),
      expected: ["happy", "calm"],
    },
    {
      columns: ["documentsLayoutJson"],
      write: {
        handler: documentsLayout.PUT,
        method: "PUT",
        route: "/api/documents/inbound/layout",
        body: { version: 1, view: "list", arrangement: "stacked" },
      },
      read: {
        call: {
          handler: documentsLayout.GET,
          method: "GET",
          route: "/api/documents/inbound/layout",
        },
        pick: (res) => [at(res.data, "view"), at(res.data, "arrangement")],
      },
      expected: ["list", "stacked"],
    },
    {
      columns: ["moduleListLayoutJson"],
      write: {
        handler: moduleListLayout.PUT,
        method: "PUT",
        route: "/api/settings/module-list-layout",
        body: {
          version: 1,
          list: "illness",
          view: "list",
          sortDir: "alphaAsc",
        },
      },
      read: {
        call: {
          handler: moduleListLayout.GET,
          method: "GET",
          route: "/api/settings/module-list-layout",
        },
        pick: (res) => [
          at(res.data, "lists.illness.view"),
          at(res.data, "lists.illness.sortDir"),
        ],
      },
      expected: ["list", "alphaAsc"],
    },
    {
      columns: ["activityGoalsJson"],
      write: {
        handler: activityGoals.PATCH,
        method: "PATCH",
        route: "/api/activity/goals",
        body: { workoutsPerWeek: 4, stepsPerWeek: 70_000 },
      },
      read: {
        call: {
          handler: activityGoals.GET,
          method: "GET",
          route: "/api/activity/goals",
        },
        pick: (res) => [
          at(res.data, "workoutsPerWeek"),
          at(res.data, "stepsPerWeek"),
        ],
      },
      expected: [4, 70_000],
    },
    {
      columns: ["healthKitConfigJson"],
      write: {
        handler: healthKit.PATCH,
        method: "PATCH",
        route: "/api/integrations/healthkit",
        body: { entries: [{ id: "heartRate", direction: "disabled" }] },
      },
      read: {
        call: {
          handler: healthKit.GET,
          method: "GET",
          route: "/api/integrations/healthkit",
        },
        pick: (res) =>
          (
            at(res.data, "entries") as
              Array<Record<string, unknown>> | undefined
          )?.find((e) => e.id === "heartRate")?.direction,
      },
      expected: "disabled",
    },
  ];
}

const SETTING_COLUMNS = Object.entries(USER_COLUMN_BACKUP_CLASS)
  .filter(([, verdict]) => verdict === "SETTING")
  .map(([column]) => column)
  .sort();

/** The setting columns whose stored form is ciphertext, compared through the API. */
const SEALED = new Set<string>([
  "insuranceNumberEncrypted",
  "homeLocationEncrypted",
]);

function columnsOf(user: User): Map<string, unknown> {
  return new Map(Object.entries(user));
}

/**
 * A stored value in a form two rows can be compared in. In a JSON column a
 * key holding `null` and a key left out mean the same unset field (the
 * restore writes the second where the settings route wrote the first), and
 * key order carries nothing, so both are normalised away.
 */
function comparable(value: unknown): string {
  if (value instanceof Uint8Array)
    return `bytes:${Buffer.from(value).toString("base64")}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  return JSON.stringify(normalise(value ?? null));
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

async function call(
  entryCall: Call,
  auth: SessionFixture,
): Promise<RouteResult> {
  return callRoute(entryCall.handler, {
    method: entryCall.method,
    route: entryCall.route,
    params: entryCall.params,
    body: entryCall.body,
    contract: entryCall.contract,
    auth,
  });
}

describe("every setting a person can choose", () => {
  it("has exactly one entry in the round-trip table", () => {
    const listed = entries({ id: "inventory" }).flatMap((e) => e.columns);
    expect(SETTING_COLUMNS.length).toBeGreaterThanOrEqual(60);
    expect([...listed].sort()).toEqual(SETTING_COLUMNS);
    expect(new Set(listed).size).toBe(listed.length);
  });

  describe("set, read back, backed up, restored, read back again", () => {
    let owner: User;
    let session: SessionFixture;
    const before = new Map<number, unknown>();
    const meBefore = new Map<number, unknown>();
    let stored: Map<string, unknown>;
    let defaults: Map<string, unknown>;

    beforeAll(async () => {
      await truncateAllTables(prisma);
      owner = await makeUser({ onboardingCompletedAt: null });
      session = await makeSession(owner);
      defaults = columnsOf(await makeUser({ onboardingCompletedAt: null }));
    });

    it("stores each setting through its write route and answers it on its read route", async () => {
      const failures: string[] = [];
      for (const [index, entry] of entries(owner).entries()) {
        const label = entry.columns.join(", ");
        let written: RouteResult;
        let read: RouteResult;
        try {
          written = await call(entry.write, session);
          if (written.status >= 300) {
            failures.push(
              `${label}: write answered ${written.status} ${JSON.stringify(written.body).slice(0, 300)}`,
            );
            continue;
          }
          read = await call(entry.read.call, session);
        } catch (error) {
          failures.push(`${label}: ${String(error).slice(0, 400)}`);
          continue;
        }
        if (read.status !== 200) {
          failures.push(`${label}: read answered ${read.status}`);
          continue;
        }
        const value = entry.read.pick(read);
        before.set(index, value);
        if ("expected" in entry && !isDeepStrictEqual(value, entry.expected)) {
          failures.push(
            `${label}: read back ${JSON.stringify(value)}, wrote ${JSON.stringify(entry.expected)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    it("publishes the settings the account payload carries", async () => {
      const me = await callRoute(getMe, {
        method: "GET",
        route: "/api/auth/me",
        auth: session,
      });
      expect(me.status).toBe(200);
      const failures: string[] = [];
      for (const [index, entry] of entries(owner).entries()) {
        if (!entry.me) continue;
        const value = entry.me.pick(me.data);
        meBefore.set(index, value);
        if (
          "expected" in entry.me &&
          !isDeepStrictEqual(value, entry.me.expected)
        ) {
          failures.push(
            `${entry.columns.join(", ")}: /api/auth/me has ${JSON.stringify(value)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    it("moves every setting column off its default", async () => {
      stored = columnsOf(
        await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }),
      );
      const untouched = SETTING_COLUMNS.filter(
        (column) =>
          comparable(stored.get(column)) === comparable(defaults.get(column)),
      );
      expect(
        untouched,
        "these columns still hold what a fresh account holds",
      ).toEqual([]);
    });

    it("comes back from a backup restored into a recreated account", async () => {
      const exported = await callRoute(exportFullBackup, {
        method: "GET",
        route: "/api/export/full-backup",
        auth: session,
      });
      expect(exported.status).toBe(200);

      // The account is recreated under the same id, the way an operator
      // brings an account back on a new host, and nothing else of it remains.
      await prisma.user.delete({ where: { id: owner.id } });
      const fresh = await makeUser({
        id: owner.id,
        username: owner.username,
        email: owner.email,
        onboardingCompletedAt: null,
      });
      const admin = await makeAdmin();
      const operator = await makeSession(admin);

      const uploaded = await callRoute<{ id: string }>(uploadBackup, {
        method: "POST",
        route: "/api/admin/backups/upload",
        body: exported.body,
        auth: operator,
      });
      expect(
        uploaded.status,
        JSON.stringify(uploaded.body).slice(0, 400),
      ).toBeLessThan(300);
      const backupId = uploaded.data.id;

      const restored = await callRoute(restoreBackup, {
        method: "POST",
        route: "/api/admin/backups/{id}/restore",
        params: { id: backupId },
        body: { confirm: "RESTORE" },
        auth: operator,
        contract: {
          skip: "the restore driver answers 200 with the job's report in place of the route's queued 202",
        },
      });
      expect(restored.status, JSON.stringify(restored.body).slice(0, 400)).toBe(
        200,
      );

      const after = columnsOf(
        await prisma.user.findUniqueOrThrow({ where: { id: fresh.id } }),
      );
      const lostInStorage = SETTING_COLUMNS.filter(
        (column) =>
          !SEALED.has(column) &&
          comparable(after.get(column)) !== comparable(stored.get(column)),
      );
      expect(
        lostInStorage.map(
          (column) =>
            `${column}: ${comparable(stored.get(column))} -> ${comparable(after.get(column))}`,
        ),
        "these columns came back with a different stored value",
      ).toEqual([]);

      const restoredSession = await makeSession(fresh);
      const failures: string[] = [];
      for (const [index, entry] of entries(fresh).entries()) {
        const read = await call(entry.read.call, restoredSession);
        const value =
          read.status === 200 ? entry.read.pick(read) : `status ${read.status}`;
        if (!isDeepStrictEqual(value, before.get(index))) {
          failures.push(
            `${entry.columns.join(", ")}: read ${JSON.stringify(before.get(index))} before, ${JSON.stringify(value)} after`,
          );
        }
      }
      const me = await callRoute(getMe, {
        method: "GET",
        route: "/api/auth/me",
        auth: restoredSession,
      });
      for (const [index, entry] of entries(fresh).entries()) {
        if (!entry.me) continue;
        const value = entry.me.pick(me.data);
        if (!isDeepStrictEqual(value, meBefore.get(index))) {
          failures.push(
            `${entry.columns.join(", ")}: /api/auth/me had ${JSON.stringify(meBefore.get(index))}, now ${JSON.stringify(value)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  });
});
