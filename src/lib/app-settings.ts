import { prisma } from "@/lib/db";

export interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
}

export async function getGlobalServiceAvailability(): Promise<GlobalServiceAvailability> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        telegramGlobal: true,
        ntfyGlobal: true,
        webPushGlobal: true,
        apiGlobal: true,
      },
    });

    return {
      telegramGlobal: settings?.telegramGlobal ?? true,
      ntfyGlobal: settings?.ntfyGlobal ?? true,
      webPushGlobal: settings?.webPushGlobal ?? true,
      apiGlobal: settings?.apiGlobal ?? true,
    };
  } catch (error) {
    console.error("Failed to load app settings, using defaults:", error);
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
  } catch (error) {
    console.error("Failed to load reminder thresholds, using defaults:", error);
    return { lateMinutes: 120, missedMinutes: 240 };
  }
}
