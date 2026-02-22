import { z } from "zod/v4";

/**
 * Schema for admin settings update (PUT /api/admin/settings).
 * All fields are optional — partial updates are supported.
 */
export const adminSettingsSchema = z
  .object({
    registrationEnabled: z.boolean().optional(),
    defaultLocale: z.enum(["de", "en"]).optional(),
    telegramGlobal: z.boolean().optional(),
    ntfyGlobal: z.boolean().optional(),
    webPushGlobal: z.boolean().optional(),
    webPushVapidPublicKey: z.string().optional(),
    webPushVapidSubject: z
      .string()
      .refine((v) => !v.trim() || /^mailto:.+@.+$/.test(v.trim()), {
        message:
          "Web Push Subject muss im Format mailto:adresse@example.com sein",
      })
      .optional(),
    webPushVapidPrivateKey: z.string().optional(),
    clearWebPushVapidPrivateKey: z.boolean().optional(),
    apiGlobal: z.boolean().optional(),
    umamiEnabled: z.boolean().optional(),
    umamiScriptUrl: z
      .string()
      .refine(
        (v) => {
          const trimmed = v.trim();
          if (!trimmed) return true;
          try {
            const parsed = new URL(trimmed);
            return ["https:", "http:"].includes(parsed.protocol);
          } catch {
            return false;
          }
        },
        { message: "Umami Script-URL ist ungültig" },
      )
      .optional(),
    umamiWebsiteId: z.string().optional(),
    glitchtipEnabled: z.boolean().optional(),
    glitchtipDsn: z
      .string()
      .refine(
        (v) => {
          const trimmed = v.trim();
          if (!trimmed) return true;
          try {
            const parsed = new URL(trimmed);
            return ["https:", "http:"].includes(parsed.protocol);
          } catch {
            return false;
          }
        },
        { message: "Glitchtip DSN ist ungültig" },
      )
      .optional(),
    glitchtipEnvironment: z.string().optional(),
    bugReportRepo: z
      .string()
      .refine(
        (v) => {
          const trimmed = v.trim();
          if (!trimmed) return true;
          return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed);
        },
        { message: "GitHub-Repository muss im Format owner/repo sein" },
      )
      .optional(),
    bugReportToken: z.string().optional(),
    clearBugReportToken: z.boolean().optional(),
    reminderLateMinutes: z.number().int().min(15).max(480).optional(),
    reminderMissedMinutes: z.number().int().min(30).max(720).optional(),
    moodLogGlobal: z.boolean().optional(),
  })
  .strict();
