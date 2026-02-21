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
