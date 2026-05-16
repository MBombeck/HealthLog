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
          "webPushVapidSubject must be in mailto:address@example.com format",
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
        { message: "Umami script URL is invalid" },
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
        { message: "Glitchtip DSN is invalid" },
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
        { message: "GitHub repository must be in owner/repo format" },
      )
      .optional(),
    bugReportToken: z.string().optional(),
    clearBugReportToken: z.boolean().optional(),
    bugReportEnabled: z.boolean().optional(),
    reminderLateMinutes: z.number().int().min(15).max(480).optional(),
    reminderMissedMinutes: z.number().int().min(30).max(720).optional(),
    moodLogGlobal: z.boolean().optional(),
    // v1.4.25 W7 — server-wide default timezone for new signups
    // that don't carry a browser-detected zone. The route validates
    // against Intl.supportedValuesOf at runtime; this schema just
    // guards the shape + length.
    defaultUserTimezone: z.string().max(64).optional(),
    // v1.4.31 — assistant-surface operator feature flags. Master
    // kills every sub-flag; sub-flags carve specific surfaces. The
    // dedicated admin endpoint at
    // /api/admin/settings/assistant-flags also accepts these via
    // its own schema; this entry exists so the generic
    // /api/admin/settings PUT path can still carry the values for
    // operators who script their settings updates over a single
    // route.
    assistantEnabled: z.boolean().optional(),
    assistantCoachEnabled: z.boolean().optional(),
    assistantBriefingEnabled: z.boolean().optional(),
    assistantInsightStatusEnabled: z.boolean().optional(),
    assistantCorrelationsEnabled: z.boolean().optional(),
    assistantHealthScoreExplainerEnabled: z.boolean().optional(),
  })
  .strict();
