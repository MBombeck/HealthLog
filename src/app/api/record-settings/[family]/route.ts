import type { NextRequest } from "next/server";

import { afterIdentityFieldsChanged } from "@/lib/auth/identity-change";
import {
  apiHandler,
  requireGuardianAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import {
  invalidateUserInsightsLayout,
  invalidateUserMedications,
  invalidateUserProfile,
} from "@/lib/cache/invalidate";
import { prisma, toJson } from "@/lib/db";
import { withUserRowLock } from "@/lib/user-row-lock";
import {
  getAllEffectiveRanges,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { writeRecordModulePreferences } from "@/lib/record-settings/modules";
import {
  isManagedRecordSettingsFamily,
  managedModulePreferencesFrom,
  parseManagedRecordSettingsPatch,
  resolveGuardianRecordSettingsAccess,
} from "@/lib/record-settings";
import { isCycleEnabled } from "@/lib/cycle/enabled";
import {
  resolveInsightsLayout,
  serializeInsightsLayout,
} from "@/lib/insights-layout";
import { annotate } from "@/lib/logging/context";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import {
  parseNotificationPrefs,
  resolveNotificationPrefs,
} from "@/lib/validations/notification-prefs";
import { dayKeyAsUtcMidnight, dateOnlyKey } from "@/lib/tz/date-only";
import { refreshTextsAfterUnitChange } from "@/lib/insights/unit-change-refresh";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { ensureExtractionReceipt } from "@/lib/documents/document-settings";
import { enqueueSummaryCatchUp } from "@/lib/jobs/document-summary-catchup";
import {
  ManagedAiSourceChainError,
  patchManagedAiSourceSettings,
  readManagedAiSourceSettings,
} from "@/lib/record-settings/ai-source";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ family: string }> };

async function resolveManagedRecordSettings(params: RouteParams["params"]) {
  const { family: rawFamily } = await params;
  if (!isManagedRecordSettingsFamily(rawFamily)) return null;

  const context = await requireGuardianAuth();
  const access = resolveGuardianRecordSettingsAccess(context);
  if (!access) throw new SharingAccessDeniedError();

  return { access, family: rawFamily };
}

/**
 * #1403 — the profile's own automatic-reading switch: the column the upload
 * pipeline and the summary job read for the record. Turning it on is the
 * standing consent act for the profile's document reads, made by the guardian
 * who decides for it; the receipt is the profile's and the route's audit row
 * names the guardian.
 */
async function patchDocumentsSettings(
  recordId: string,
  body: unknown,
): Promise<{ settings: unknown; changed: readonly string[] }> {
  const patch = parseManagedRecordSettingsPatch("documents", body);
  const previous = await prisma.user.findUnique({
    where: { id: recordId },
    select: { documentsAutoAiRead: true },
  });
  await prisma.user.update({
    where: { id: recordId },
    data: { documentsAutoAiRead: patch.autoAiRead },
  });
  const consentMinted = patch.autoAiRead
    ? await ensureExtractionReceipt(recordId, "guardian")
    : false;
  if (patch.autoAiRead && !(previous?.documentsAutoAiRead ?? false)) {
    // Read after the mint, under the profile's capability, so a receipt this
    // request wrote counts; the catch-up only enqueues, and every gate runs
    // again per document inside the job.
    const documentAi = await getAiCapability("documentAi", { recordId });
    if (documentAi.available) {
      void enqueueSummaryCatchUp(recordId);
    } else {
      annotate({
        action: { name: "record-settings.documents.catchUpSkipped" },
        meta: { reason: documentAi.reason },
      });
    }
  }
  return {
    settings: { autoAiRead: patch.autoAiRead },
    changed: consentMinted ? ["autoAiRead", "consent"] : ["autoAiRead"],
  };
}

/** The notifications family: the mood reminder and the medication lead days. */
async function patchNotificationsSettings(
  recordId: string,
  body: unknown,
): Promise<{ settings: unknown; changed: readonly string[] }> {
  const patch = parseManagedRecordSettingsPatch("notifications", body);
  // Merged under the record's row lock, like every partial write to a
  // settings document here: a guardian's write and one from the profile's own
  // session that overlap would otherwise both merge into the same stored
  // document, and the later one would drop the earlier one's change.
  const record = await withUserRowLock(recordId, async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: recordId },
      select: { notificationPrefs: true },
    });
    const notificationPreferences = patch.notificationPreferences
      ? resolveNotificationPrefs(
          current?.notificationPrefs,
          patch.notificationPreferences,
        )
      : undefined;
    return tx.user.update({
      where: { id: recordId },
      data: {
        ...(patch.moodReminderEnabled !== undefined
          ? { moodReminderEnabled: patch.moodReminderEnabled }
          : {}),
        ...(notificationPreferences !== undefined
          ? { notificationPrefs: toJson(notificationPreferences) }
          : {}),
      },
      select: { moodReminderEnabled: true, notificationPrefs: true },
    });
  });
  // The medication answers carry the resolved low-stock trigger.
  if (patch.notificationPreferences) {
    invalidateUserMedications(recordId, { evict: true });
  }
  const preferences = parseNotificationPrefs(record.notificationPrefs);
  const settings = {
    moodReminderEnabled: record.moodReminderEnabled,
    notificationPreferences: {
      medication: {
        lowStockRunwayDays: preferences.medication.lowStockRunwayDays,
        reorderLeadDays: preferences.medication.reorderLeadDays,
      },
      mood: { reminderHour: preferences.mood.reminderHour },
    },
  };
  return { settings, changed: Object.keys(patch) };
}

/** The thresholds family: per-metric target ranges, merged by metric. */
async function patchThresholdsSettings(
  recordId: string,
  body: unknown,
): Promise<{ settings: unknown; changed: readonly string[] }> {
  const patch = parseManagedRecordSettingsPatch("thresholds", body);
  const { overrides, record } = await withUserRowLock(recordId, async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: recordId },
      select: { thresholdsJson: true },
    });
    const overrides = {
      ...((current?.thresholdsJson ?? {}) as ThresholdOverridesJson),
      ...patch.overrides,
    };
    const record = await tx.user.update({
      where: { id: recordId },
      data: { thresholdsJson: toJson(overrides) },
      select: { heightCm: true, dateOfBirth: true, gender: true },
    });
    return { overrides, record };
  });
  invalidateUserProfile(recordId);
  return {
    settings: {
      overrides,
      effective: getAllEffectiveRanges(record, overrides),
    },
    changed: Object.keys(patch.overrides),
  };
}

/** The coach family: the Coach switch and the preferences merged into it. */
async function patchCoachSettings(
  recordId: string,
  body: unknown,
): Promise<{ settings: unknown; changed: readonly string[] }> {
  const patch = parseManagedRecordSettingsPatch("coach", body);
  const record = await withUserRowLock(recordId, async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: recordId },
      select: { coachPrefsJson: true },
    });
    const nextPreferences = patch.preferences
      ? { ...parseCoachPrefs(current?.coachPrefsJson), ...patch.preferences }
      : undefined;
    return tx.user.update({
      where: { id: recordId },
      data: {
        ...(patch.disableCoach !== undefined
          ? { disableCoach: patch.disableCoach }
          : {}),
        ...(nextPreferences !== undefined
          ? {
              coachPrefsJson: toJson(nextPreferences),
              insightsExcludeMetrics: nextPreferences.excludeMetrics,
            }
          : {}),
      },
      select: { disableCoach: true, coachPrefsJson: true },
    });
  });
  const preferences = parseCoachPrefs(record.coachPrefsJson);
  return {
    settings: {
      disableCoach: record.disableCoach,
      preferences: {
        tone: preferences.tone,
        verbosity: preferences.verbosity,
        excludeMetrics: preferences.excludeMetrics,
        defaultWindow: preferences.defaultWindow,
        ...(preferences.dataClusters !== undefined
          ? { dataClusters: preferences.dataClusters }
          : {}),
      },
    },
    changed: Object.keys(patch),
  };
}

/** Each response names the target record and only one field-specific DTO. */
export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const resolved = await resolveManagedRecordSettings(params);
    if (!resolved) return apiError("Settings family not found", 404);
    const { access, family } = resolved;

    const record = await prisma.user.findUnique({
      where: { id: access.recordId },
      select: {
        displayName: true,
        heightCm: true,
        dateOfBirth: true,
        gender: true,
        locale: true,
        timezone: true,
        unitPreference: true,
        timeFormat: true,
        dateFormat: true,
        modulePreferencesJson: true,
        moodReminderEnabled: true,
        notificationPrefs: true,
        thresholdsJson: true,
        disableCoach: true,
        coachPrefsJson: true,
        insightsLayoutJson: true,
        documentsAutoAiRead: true,
      },
    });
    if (!record) return apiError("Record not found", 404);

    let settings: unknown;
    switch (family) {
      case "profile":
        settings = {
          displayName: record.displayName,
          heightCm: record.heightCm,
          dateOfBirth: record.dateOfBirth
            ? dateOnlyKey(record.dateOfBirth)
            : null,
          gender: record.gender,
          locale: record.locale,
          timezone: record.timezone,
          unitPreference: record.unitPreference,
          timeFormat: record.timeFormat,
          dateFormat: record.dateFormat,
        };
        break;
      case "modules": {
        // The delegated key needs its real source, which is not the module
        // blob. `isCycleEnabled` resolves the record's own opt-in against its
        // sex exactly as `/api/auth/me` does for the account itself, so the
        // switch a guardian sees is the state the gate will answer with.
        const cycleProfile = await prisma.cycleProfile.findUnique({
          where: { userId: access.recordId },
          select: { cycleTrackingEnabled: true },
        });
        settings = {
          modulePreferences: managedModulePreferencesFrom(
            record.modulePreferencesJson,
          ),
          cycleTrackingEnabled: isCycleEnabled(record.gender, cycleProfile),
        };
        break;
      }
      case "notifications": {
        const preferences = parseNotificationPrefs(record.notificationPrefs);
        settings = {
          moodReminderEnabled: record.moodReminderEnabled,
          notificationPreferences: {
            medication: {
              lowStockRunwayDays: preferences.medication.lowStockRunwayDays,
              reorderLeadDays: preferences.medication.reorderLeadDays,
            },
            mood: { reminderHour: preferences.mood.reminderHour },
          },
        };
        break;
      }
      case "thresholds": {
        const overrides = (record.thresholdsJson ??
          {}) as ThresholdOverridesJson;
        settings = {
          overrides,
          effective: getAllEffectiveRanges(record, overrides),
        };
        break;
      }
      case "coach": {
        const preferences = parseCoachPrefs(record.coachPrefsJson);
        settings = {
          disableCoach: record.disableCoach,
          preferences: {
            tone: preferences.tone,
            verbosity: preferences.verbosity,
            excludeMetrics: preferences.excludeMetrics,
            defaultWindow: preferences.defaultWindow,
            ...(preferences.dataClusters !== undefined
              ? { dataClusters: preferences.dataClusters }
              : {}),
          },
        };
        break;
      }
      case "insights":
        settings = { layout: resolveInsightsLayout(record.insightsLayoutJson) };
        break;
      case "documents":
        settings = { autoAiRead: record.documentsAutoAiRead };
        break;
      case "aiSource":
        settings = await readManagedAiSourceSettings(
          access.recordId,
          access.actorId,
        );
        break;
    }

    annotate({ action: { name: `record-settings.${family}.get` } });
    return apiSuccess({ recordId: access.recordId, family, settings });
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const resolved = await resolveManagedRecordSettings(params);
    if (!resolved) return apiError("Settings family not found", 404);
    const { access, family } = resolved;
    const { data: body, error } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });
    if (error) return error;

    try {
      let settings: unknown;
      let changed: readonly string[];
      let auditExtra: Record<string, string> = {};

      switch (family) {
        case "profile": {
          const patch = parseManagedRecordSettingsPatch("profile", body);
          const data = {
            ...(patch.displayName !== undefined
              ? { displayName: patch.displayName }
              : {}),
            ...(patch.heightCm !== undefined
              ? { heightCm: patch.heightCm }
              : {}),
            ...(patch.dateOfBirth !== undefined
              ? {
                  dateOfBirth: patch.dateOfBirth
                    ? dayKeyAsUtcMidnight(patch.dateOfBirth)
                    : null,
                }
              : {}),
            ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
            ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
            ...(patch.timezone !== undefined
              ? { timezone: patch.timezone }
              : {}),
            ...(patch.unitPreference !== undefined
              ? { unitPreference: patch.unitPreference }
              : {}),
            ...(patch.timeFormat !== undefined
              ? { timeFormat: patch.timeFormat }
              : {}),
            ...(patch.dateFormat !== undefined
              ? { dateFormat: patch.dateFormat }
              : {}),
          };
          const record = await prisma.user.update({
            where: { id: access.recordId },
            data,
            select: {
              displayName: true,
              heightCm: true,
              dateOfBirth: true,
              gender: true,
              locale: true,
              timezone: true,
              unitPreference: true,
              timeFormat: true,
              dateFormat: true,
            },
          });
          await afterIdentityFieldsChanged(access.recordId, {
            anthropometrics: true,
            // A zone in the patch counts as changed; the refresh is idempotent.
            timezone: patch.timezone !== undefined,
          });
          if (patch.unitPreference !== undefined) {
            void refreshTextsAfterUnitChange(access.recordId);
          }
          settings = {
            ...record,
            dateOfBirth: record.dateOfBirth
              ? dateOnlyKey(record.dateOfBirth)
              : null,
          };
          changed = Object.keys(patch);
          break;
        }
        case "modules": {
          const patch = parseManagedRecordSettingsPatch("modules", body);
          const current = await prisma.user.findUnique({
            where: { id: access.recordId },
            select: { modulePreferencesJson: true, gender: true },
          });
          // One write path, shared with the setup flow's derivation. The
          // delegated key writes its own column there: an explicit boolean is
          // what the cycle gate honours over the sex-derived default, so a
          // guardian turning Cycle off for a record whose sex says otherwise
          // is recorded as the deliberate answer it is.
          const written = await writeRecordModulePreferences({
            recordId: access.recordId,
            // Merged into what is stored at write time, under the row lock.
            ...(patch.modulePreferences !== undefined
              ? {
                  modulePreferences: (stored: unknown) => ({
                    ...managedModulePreferencesFrom(stored),
                    ...patch.modulePreferences,
                  }),
                }
              : {}),
            ...(patch.cycleTrackingEnabled !== undefined
              ? { cycleTrackingEnabled: patch.cycleTrackingEnabled }
              : {}),
          });
          settings = {
            modulePreferences:
              written.modulePreferences ??
              managedModulePreferencesFrom(current?.modulePreferencesJson),
            cycleTrackingEnabled: isCycleEnabled(current?.gender ?? null, {
              cycleTrackingEnabled: written.cycleTrackingEnabled,
            }),
          };
          // The module keys themselves, not the wrapper field: the record's
          // trail should say which module moved. `cycleTrackingEnabled` is
          // named as itself because that is the column it writes.
          changed = [
            ...Object.keys(patch.modulePreferences ?? {}),
            ...(patch.cycleTrackingEnabled !== undefined
              ? ["cycleTrackingEnabled"]
              : []),
          ];
          break;
        }
        case "notifications": {
          ({ settings, changed } = await patchNotificationsSettings(
            access.recordId,
            body,
          ));
          break;
        }
        case "thresholds": {
          ({ settings, changed } = await patchThresholdsSettings(
            access.recordId,
            body,
          ));
          break;
        }
        case "coach": {
          ({ settings, changed } = await patchCoachSettings(
            access.recordId,
            body,
          ));
          break;
        }
        case "insights": {
          const patch = parseManagedRecordSettingsPatch("insights", body);
          const layout = await withUserRowLock(access.recordId, async (tx) => {
            const current = await tx.user.findUnique({
              where: { id: access.recordId },
              select: { insightsLayoutJson: true },
            });
            const layout = serializeInsightsLayout(
              patch.layout,
              resolveInsightsLayout(current?.insightsLayoutJson),
            );
            await tx.user.update({
              where: { id: access.recordId },
              data: { insightsLayoutJson: toJson(layout) },
            });
            return layout;
          });
          invalidateUserInsightsLayout(access.recordId);
          settings = { layout };
          changed = ["layout"];
          break;
        }
        case "documents": {
          ({ settings, changed } = await patchDocumentsSettings(
            access.recordId,
            body,
          ));
          break;
        }
        case "aiSource": {
          ({
            settings,
            changed,
            audit: auditExtra,
          } = await patchManagedAiSourceSettings(
            access.recordId,
            access.actorId,
            body,
          ));
          break;
        }
      }

      await auditLog(`record-settings.${family}.update`, {
        userId: access.recordId,
        actorUserId: access.actorId,
        ipAddress: getClientIp(request),
        details: { changed, ...auditExtra },
      });
      annotate({
        action: { name: `record-settings.${family}.update` },
        meta: { recordId: access.recordId, changed },
      });
      return apiSuccess({ recordId: access.recordId, family, settings });
    } catch (error) {
      if (error instanceof ManagedAiSourceChainError) {
        return apiError(error.message, 422, {
          errorCode: "record_settings.ai_source.chain_missing",
        });
      }
      if (error instanceof Error && "issues" in error) {
        return returnAllZodIssues(error as never, 422);
      }
      throw error;
    }
  },
);
