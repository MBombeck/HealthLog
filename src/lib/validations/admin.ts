import { z } from "zod/v4";
import { locales } from "@/lib/i18n/config";
import { isPublicUrl } from "@/lib/validations/notifications";

/**
 * Schema for admin settings update (PUT /api/admin/settings).
 * All fields are optional — partial updates are supported.
 */
export const adminSettingsSchema = z
  .object({
    registrationEnabled: z.boolean().optional(),
    // v1.23 — instance-wide "require a second factor" policy.
    mfaRequired: z.boolean().optional(),
    // Every shipped locale. It was the pair de/en long after the app shipped
    // seven, so the admin picker could offer only two of them.
    defaultLocale: z.enum(locales).optional(),
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
          // The Umami script proxy fetches this URL server-side and
          // re-serves the body from the app origin under a strict CSP
          // — a private-IP target would be an SSRF channel. Match the
          // posture every other admin-supplied outbound URL takes.
          return isPublicUrl(trimmed);
        },
        {
          message:
            "Umami script URL must be a public HTTP(S) endpoint (no private / loopback / metadata addresses)",
        },
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
          // Glitchtip DSNs are `https://<key>@host/projectid`. The
          // userinfo is the auth material; the SSRF surface is the
          // host — same `isPublicUrl` posture as the Umami URL.
          return isPublicUrl(trimmed);
        },
        {
          message:
            "Glitchtip DSN must point to a public HTTP(S) endpoint (no private / loopback / metadata addresses)",
        },
      )
      .optional(),
    glitchtipEnvironment: z.string().optional(),
    reminderLateMinutes: z.number().int().min(15).max(480).optional(),
    reminderMissedMinutes: z.number().int().min(30).max(720).optional(),
    // Document vault — the two admin-tunable limits. The per-file cap is
    // bounded by the hard 100 MiB ceiling (single-shot GCM + bounded
    // in-memory reads are load-bearing past that; the runtime resolver
    // clamps again as defence-in-depth). The quota accepts up to 1 TiB —
    // BYTEA rides pg_dump, so anything larger is an operator error.
    documentMaxFileBytes: z
      .number()
      .int()
      .min(1_048_576)
      .max(104_857_600)
      .optional(),
    documentQuotaBytes: z
      .number()
      .int()
      .min(10_485_760)
      .max(1_099_511_627_776)
      .optional(),
    // v1.4.25 W7 — server-wide default timezone for new signups
    // that don't carry a browser-detected zone. The route validates
    // against Intl.supportedValuesOf at runtime; this schema just
    // guards the shape + length.
    defaultUserTimezone: z.string().max(64).optional(),
    // The operator's assistant switches. The master stops every AI
    // capability; the sub-switches each stop the AI work they cover. The
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
    assistantDocumentAiEnabled: z.boolean().optional(),
  })
  .strict();
