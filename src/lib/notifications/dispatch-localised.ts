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
 *
 * v1.4.28 R3d (R1.2 H5) — the locale lookup previously fired
 * `prisma.user.findUnique` on every call. A 30-second TTL LRU keyed on
 * `userId` collapses repeat reads inside the same recipient burst onto
 * one DB round-trip; the next read after 30 s re-validates. The
 * trade-off: a user who flips their locale in Settings won't see the
 * change reflected in dispatch output for up to 30 s. That's
 * acceptable for the call-sites this helper serves (admin alerts,
 * deploy webhooks, reminder cron) — none of them are user-initiated
 * within a tight feedback loop.
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
 * Process-level locale cache.
 *
 * `Map`-based; capped to 1 000 entries with FIFO-style eviction once
 * we hit the cap (LRU on insertion order — `Map` iterates in insertion
 * order, so deleting + re-inserting on read marks the entry "fresh").
 * Each entry stores the resolved `Locale` and the `Date.now()` at
 * which it expires. Reads past the expiry re-fire the Prisma query
 * and refresh the entry.
 *
 * Memory footprint at the cap is trivial (1 000 short strings + 1 000
 * numbers ≈ 50 KB worst-case), so no eviction-by-size pressure is
 * needed. The cap exists only to bound unbounded growth in workers
 * that dispatch to many distinct users.
 */
const LOCALE_CACHE_TTL_MS = 30_000;
const LOCALE_CACHE_MAX = 1_000;
const localeCache = new Map<string, { locale: Locale; expiresAt: number }>();

/**
 * Reset hook for tests. Production code never calls this — the cache
 * is intentionally process-lifetime.
 */
export function __resetDispatchLocaleCacheForTests(): void {
  localeCache.clear();
}

async function resolveRecipientLocale(userId: string): Promise<Locale> {
  // v1.4.28 R3d (R1.2 H5) — fast path: cached entry within TTL.
  const cached = localeCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    // Mark as fresh by re-inserting (Map iteration order doubles as
    // LRU order — older entries sit at the head, newer at the tail).
    localeCache.delete(userId);
    localeCache.set(userId, cached);
    return cached.locale;
  }

  // Cache miss or stale → resolve from Prisma.
  let resolved: Locale = defaultLocale;
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    if (isLocale(row?.locale)) resolved = row.locale;
  } catch (err) {
    getEvent()?.addWarning(
      `dispatchLocalisedNotification — locale lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return defaultLocale;
  }

  // Insert + opportunistic eviction at the head when over the cap.
  if (localeCache.size >= LOCALE_CACHE_MAX) {
    const firstKey = localeCache.keys().next().value;
    if (firstKey !== undefined) localeCache.delete(firstKey);
  }
  localeCache.set(userId, {
    locale: resolved,
    expiresAt: Date.now() + LOCALE_CACHE_TTL_MS,
  });
  return resolved;
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
