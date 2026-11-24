import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { readOperatorRow } from "@/lib/settings/operator-row";

export interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
}

export async function getGlobalServiceAvailability(): Promise<GlobalServiceAvailability> {
  try {
    // The instance switches ride the one operator-row read of the request
    // (`settings/operator-row.ts`), read afresh in a background job.
    const settings = await readOperatorRow();

    return {
      telegramGlobal: settings?.telegramGlobal ?? true,
      ntfyGlobal: settings?.ntfyGlobal ?? true,
      webPushGlobal: settings?.webPushGlobal ?? true,
      apiGlobal: settings?.apiGlobal ?? true,
    };
  } catch {
    getEvent()?.addWarning("Failed to load app settings, using defaults");
    return {
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      apiGlobal: true,
    };
  }
}

export async function isApiGloballyEnabled(): Promise<boolean> {
  const settings = await getGlobalServiceAvailability();
  return settings.apiGlobal;
}

/**
 * The notification channels an operator can switch off instance-wide, mapped
 * to the `AppSettings` column that carries the switch. A channel absent from
 * this map (APNs, generic webhook, email) has no instance-wide switch and is
 * never gated by it — the operator turns those off at their source (the APNs
 * credentials, the SMTP env) instead.
 */
const GLOBAL_CHANNEL_SWITCHES = {
  TELEGRAM: "telegramGlobal",
  NTFY: "ntfyGlobal",
  WEB_PUSH: "webPushGlobal",
} as const;

export type GloballySwitchableChannel = keyof typeof GLOBAL_CHANNEL_SWITCHES;

export function hasGlobalChannelSwitch(
  channelType: string,
): channelType is GloballySwitchableChannel {
  return Object.hasOwn(GLOBAL_CHANNEL_SWITCHES, channelType);
}

/**
 * Resolve one channel's instance-wide switch out of an availability snapshot
 * the caller already holds. Split from the async form so a dispatch that
 * walks several channels reads the settings row once.
 */
export function resolveChannelGloballyEnabled(
  availability: GlobalServiceAvailability,
  channelType: string,
): boolean {
  if (!hasGlobalChannelSwitch(channelType)) return true;
  return availability[GLOBAL_CHANNEL_SWITCHES[channelType]];
}

/**
 * Whether a notification channel may deliver on this instance. Same shape and
 * same posture as `isApiGloballyEnabled()`: the switch is the operator's and
 * sits above every per-user channel setting, and an unreadable settings row
 * resolves to "enabled" so a storage blip never silently mutes an instance.
 */
export async function isChannelGloballyEnabled(
  channelType: string,
): Promise<boolean> {
  if (!hasGlobalChannelSwitch(channelType)) return true;
  return resolveChannelGloballyEnabled(
    await getGlobalServiceAvailability(),
    channelType,
  );
}

export interface ReminderThresholds {
  lateMinutes: number;
  missedMinutes: number;
}

export async function getReminderThresholds(): Promise<ReminderThresholds> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        reminderLateMinutes: true,
        reminderMissedMinutes: true,
      },
    });

    return {
      lateMinutes: settings?.reminderLateMinutes ?? 120,
      missedMinutes: settings?.reminderMissedMinutes ?? 240,
    };
  } catch {
    getEvent()?.addWarning(
      "Failed to load reminder thresholds, using defaults",
    );
    return { lateMinutes: 120, missedMinutes: 240 };
  }
}

/**
 * The operator's configured default locale (`AppSettings.defaultLocale`), or
 * `null` when the settings row is absent or unreadable. Validation against
 * the shipped locale list is the caller's job (`resolveJobLocale`); this only
 * reads the column.
 */
export async function getOperatorDefaultLocale(): Promise<string | null> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { defaultLocale: true },
    });
    return settings?.defaultLocale ?? null;
  } catch {
    getEvent()?.addWarning("Failed to load the operator default locale");
    return null;
  }
}
