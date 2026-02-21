import { prisma } from "@/lib/db";

export interface PublicMonitoringSettings {
  umamiEnabled: boolean;
  umamiScriptUrl: string | null;
  umamiWebsiteId: string | null;
  glitchtipEnabled: boolean;
}

export interface GlitchtipSettings {
  glitchtipEnabled: boolean;
  glitchtipDsn: string | null;
  glitchtipEnvironment: string | null;
}

export async function getPublicMonitoringSettings(): Promise<PublicMonitoringSettings> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        umamiEnabled: true,
        umamiScriptUrl: true,
        umamiWebsiteId: true,
        glitchtipEnabled: true,
      },
    });

    return {
      umamiEnabled: settings?.umamiEnabled ?? false,
      umamiScriptUrl: settings?.umamiScriptUrl ?? null,
      umamiWebsiteId: settings?.umamiWebsiteId ?? null,
      glitchtipEnabled: settings?.glitchtipEnabled ?? false,
    };
  } catch {
    return {
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
    };
  }
}

export async function getGlitchtipSettings(): Promise<GlitchtipSettings> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        glitchtipEnabled: true,
        glitchtipDsn: true,
        glitchtipEnvironment: true,
      },
    });

    return {
      glitchtipEnabled: settings?.glitchtipEnabled ?? false,
      glitchtipDsn: settings?.glitchtipDsn ?? null,
      glitchtipEnvironment: settings?.glitchtipEnvironment ?? null,
    };
  } catch {
    return {
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
    };
  }
}
