/**
 * v1.4.27 F21 — translator-aware notification dispatch.
 *
 * The base `dispatchNotification` (in `./dispatcher`) is deliberately
 * locale-agnostic: it forwards `title` and `message` verbatim to every
 * sender. The contract is "the caller composes the localised body".
 *
 * Several call-sites (admin alerts, deploy-webhook, Telegram test
 * routes, reminder-check) compose bodies in English without consulting
 * `User.locale`. This helper closes that gap:
 *
 *   1. resolves the recipient's `User.locale` (falls back to the
 *      project default when missing).
 *   2. calls `getServerTranslator(locale).t(titleKey, params)` and
 *      `.t(messageKey, params)`.
 *   3. delegates to `dispatchNotification` with the resolved strings.
 *
 * The base dispatcher stays untouched so already-localised callers
 * (e.g. `jobs/reminder-phases.ts`) don't churn. Use this helper from
 * every new admin- or user-facing surface that emits notifications.
 *
 * The default `eventType` is `SYSTEM_ALERT` — the only event type that
 * predates F21 outside of the medication-reminder lane. Callers that
 * need a different event type pass it explicitly; the `channel` option
 * is reserved for a future per-channel routing pass and is currently
 * a no-op (the dispatcher fans the message across every enabled
 * channel as before).
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import type { EventType } from "@/lib/notifications/types";

interface DispatchLocalisedOptions {
  userId: string;
  titleKey: string;
  messageKey: string;
  params?: Record<string, string | number>;
  /**
   * Per-channel routing is forward-compat scaffolding. Today the
   * dispatcher fans out across every enabled channel for the user; the
   * option is accepted so call-sites can declare intent without
   * needing a second helper later.
   */
  channel?: "telegram" | "email";
  /** Event type for preference gating. Defaults to SYSTEM_ALERT. */
  eventType?: EventType;
  /** Channel-specific extras forwarded to the dispatcher metadata. */
  metadata?: Record<string, unknown>;
}

function isLocale(value: string | null | undefined): value is Locale {
  return value === "de" || value === "en" || value === "fr" ||
    value === "es" || value === "it" || value === "pl";
}

/**
 * Resolve a user's persisted locale, falling back to the project
 * default when the column is null/empty. We deliberately do NOT chain
 * through cookies or Accept-Language here — this helper runs from
 * background jobs and webhook handlers where the request context may
 * not belong to the recipient (an admin alert resolves the admin's
 * locale, not the affected user's), so the only authoritative source
 * is the persisted column.
 */
async function resolveRecipientLocale(userId: string): Promise<Locale> {
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    if (isLocale(row?.locale)) return row.locale;
  } catch (err) {
    getEvent()?.addWarning(
      `dispatchLocalisedNotification — locale lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return defaultLocale;
}

export async function dispatchLocalisedNotification(
  opts: DispatchLocalisedOptions,
): Promise<void> {
  const locale = await resolveRecipientLocale(opts.userId);
  const t = getServerTranslator(locale).t;

  const title = t(opts.titleKey, opts.params);
  const message = t(opts.messageKey, opts.params);

  // Warn when a translation key falls back to its own raw string —
  // that signals a missing entry in `messages/{locale}.json` (or a
  // typo in the call-site). The dispatcher still fires so the user
  // gets *something*, but ops should see the gap.
  if (title === opts.titleKey || message === opts.messageKey) {
    getEvent()?.addWarning(
      `dispatchLocalisedNotification — missing translation for ${opts.titleKey} / ${opts.messageKey} in locale ${locale}`,
    );
  }

  // `channel` is accepted for future per-channel routing; today it
  // is silently passed through. Suppress unused-var lint by referencing
  // it on the metadata if present.
  const metadata = opts.channel
    ? { ...(opts.metadata ?? {}), preferredChannel: opts.channel }
    : opts.metadata;

  await dispatchNotification({
    eventType: opts.eventType ?? "SYSTEM_ALERT",
    userId: opts.userId,
    title,
    message,
    metadata,
  });
}
