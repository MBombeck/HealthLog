import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function fromEnv(): VapidConfig | null {
  const publicKey =
    process.env.VAPID_PUBLIC_KEY ??
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY ??
    process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey =
    process.env.VAPID_PRIVATE_KEY ??
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY ??
    process.env.WEB_PUSH_PRIVATE_KEY;
  const subject =
    process.env.VAPID_SUBJECT ??
    process.env.WEB_PUSH_VAPID_SUBJECT ??
    process.env.WEB_PUSH_SUBJECT;

  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export async function getVapidConfig(): Promise<VapidConfig | null> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        webPushVapidPublicKey: true,
        webPushVapidPrivateKeyEncrypted: true,
        webPushVapidSubject: true,
      },
    });

    if (
      settings?.webPushVapidPublicKey &&
      settings?.webPushVapidPrivateKeyEncrypted &&
      settings?.webPushVapidSubject
    ) {
      return {
        publicKey: settings.webPushVapidPublicKey,
        privateKey: decrypt(settings.webPushVapidPrivateKeyEncrypted),
        subject: settings.webPushVapidSubject,
      };
    }
  } catch (error) {
    console.error("Failed to load Web Push config from database:", error);
  }

  return fromEnv();
}
