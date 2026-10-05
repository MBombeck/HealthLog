/**
 * S5 — the daily briefing push (§2.2).
 *
 * A CALM, once-per-day morning nudge that rides the EXISTING notification
 * cascade (`dispatchNotification` → APNs → Telegram → ntfy → Webhook → Email →
 * Web Push), inheriting the hard-reject classification and the `push_attempts`
 * ledger for free. It reads the ALREADY-CACHED daily digest (S1 `buildDailyDigest`
 * via `loadDailyDigest`) — it NEVER makes a fresh AI/provider call (the
 * warm-on-mount ban extends to warm-on-dispatch), so a keyless self-hoster gets
 * a first-class push from the digest's deterministic `line` floor.
 *
 * This module owns ONE decision seam — `maybeDispatchDailyBriefing` — that both
 * triggers funnel through: the S4 morning-refresh finalisation hook (event-
 * driven, on sleep arrival) and the fixed local-morning fallback cron
 * (`@/lib/jobs/daily-briefing`). Whichever fires first that morning writes the
 * `ok` ledger row; the frequency-cap check suppresses the second — one push per
 * user per local day, no "you haven't opened the app" second push, ever.
 *
 * Privacy + calm posture (load-bearing): the body is `digest.line`, which
 * carries no number by construction (a briefing lead sentence or the top
 * signal's headline without a figure in it, "your score is ready", or the
 * honest all-clear — never a reading, a dose or the score itself, since the
 * push lands on a locked phone). It is dispatched NON-URGENT, so it never escalates to a
 * Focus-bypassing / time-sensitive delivery — a concerning reading always stays
 * on `MEASUREMENT_ANOMALY`, never here. It fires ONLY inside a local morning
 * window, which is the quiet-hours guarantee for this nudge.
 */
import type { User } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

import { annotate, getEvent } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { ServerTranslator } from "@/lib/i18n/server-translator";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import type { DailyDigest } from "@/lib/daily/digest";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";

/**
 * The local-morning window this nudge may fire in, [earliest, latest). Both the
 * sleep-arrival finalisation hook and the fixed fallback slot are gated by it,
 * so a late-afternoon sleep sync (a full re-sync, a device that reconnected
 * hours after waking) can never fire a "morning briefing" at an odd hour —
 * outside the window the day simply carries no push (never-nag). 05:00 is the
 * earliest a genuine wake-time sleep sync lands; noon is a firm ceiling.
 */
export const DAILY_BRIEFING_MORNING_EARLIEST_HOUR = 5;
export const DAILY_BRIEFING_MORNING_LATEST_HOUR = 12;

/**
 * The fixed local hour the fallback cron dispatches at when sleep never
 * arrived (so the finalisation hook never fired). Inside the window above; the
 * earlier part of the window is left for the event-driven finalisation push, so
 * a user whose sleep synced on wake gets the warmer FINAL digest first and the
 * ledger suppresses this slot.
 */
export const DAILY_BRIEFING_FALLBACK_HOUR = 8;

/** The dashboard / Today view the push deep-links to (same-origin path). */
const DAILY_BRIEFING_DEEP_LINK = "/";

/**
 * The outcome of one dispatch attempt — one value per branch so the wide-event
 * annotation (and the tests) can assert the exact decision the seam took.
 */
export type DailyBriefingDispatchResult =
  | "sent"
  | "suppressed-frequency"
  | "no-digest"
  | "opted-out"
  | "outside-window"
  | "no-channel"
  | "missing-user"
  | "error";

export interface DailyBriefingDispatchDeps {
  dispatch?: typeof dispatchNotification;
  loadDigest?: (user: User, now: Date, locale: Locale) => Promise<DailyDigest>;
}

function loadDailyBriefingDigest(
  user: User,
  now: Date,
  locale: Locale,
): Promise<DailyDigest> {
  return loadDailyDigest(user, now, {
    enabledItemKinds: PRIORITY_ITEM_KINDS,
    locale,
  });
}

/**
 * A digest is "substantive" — worth a morning push — when it carries a score, a
 * briefing lead, a top signal, OR a worth-a-look item. A brand-new / empty
 * account whose only line would be the generic all-clear is NOT nudged every
 * morning (the never-nag rule); it falls through to the `no-digest` skip.
 */
export function digestHasSubstance(digest: DailyDigest): boolean {
  return (
    digest.score !== null ||
    digest.briefingLead !== null ||
    digest.topSignal !== null ||
    digest.worthALook.length > 0
  );
}

/**
 * Compose the push title + body from the cached digest. The body IS
 * `digest.line` — the cached briefing lead when present, else the deterministic
 * floor — so a no-AI self-hoster still gets a meaningful push. When the day is
 * still provisional (last night's sleep not yet in), the honest sleep-pending
 * wording is appended so the read is never silently presented as final.
 */
export function buildDailyBriefingPush(
  digest: DailyDigest,
  t: ServerTranslator["t"],
): { title: string; body: string } {
  const title = t("daily.push.title");
  const body = digest.sleepPending
    ? t("daily.push.bodyProvisional", { line: digest.line })
    : digest.line;
  return { title, body };
}

/**
 * The ONE dispatch-decision seam. Fully fault-isolated — every failure returns
 * a result value rather than throwing, so neither the sleep-arrival hook nor
 * the cron tick can be broken by it.
 *
 * Gates, cheapest first:
 *   1. user missing            → `missing-user`
 *   2. no opt-in (default OFF) → `opted-out` (no enabled DAILY_BRIEFING pref)
 *   3. outside morning window  → `outside-window`
 *   4. already pushed today    → `suppressed-frequency` (push_attempts ledger)
 *   5. digest not substantive  → `no-digest`
 *   6. dispatch; no channel    → `no-channel`; else `sent`.
 *
 * No module gate. The `insights` module is the AI analysis opt-out: with it
 * off (or AI unavailable for any other reason) the digest carries no briefing
 * lead or top signal, and the push body falls to the digest's deterministic
 * line (the score, or the all-clear). A digest with nothing deterministic to
 * say is skipped as `no-digest`, like any other.
 */
export async function maybeDispatchDailyBriefing(
  prisma: PrismaClient,
  userId: string,
  now: Date,
  deps: DailyBriefingDispatchDeps = {},
): Promise<DailyBriefingDispatchResult> {
  const dispatch = deps.dispatch ?? dispatchNotification;
  const loadDigest = deps.loadDigest ?? loadDailyBriefingDigest;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      annotate({ action: { name: "daily.briefing_push.missing_user" } });
      return "missing-user";
    }

    // Opt-in: DAILY_BRIEFING defaults OFF, so an opted-in user is one with at
    // least one enabled per-channel preference row. Silence until then.
    const optIn = await prisma.notificationPreference.findFirst({
      where: {
        eventType: "DAILY_BRIEFING",
        enabled: true,
        channel: { userId },
      },
      select: { id: true },
    });
    if (!optIn) {
      annotate({ action: { name: "daily.briefing_push.opted_out" } });
      return "opted-out";
    }

    const tz = user.timezone || DEFAULT_TIMEZONE;
    const { hour } = wallClockInTz(now, tz);
    if (
      hour < DAILY_BRIEFING_MORNING_EARLIEST_HOUR ||
      hour >= DAILY_BRIEFING_MORNING_LATEST_HOUR
    ) {
      annotate({
        action: { name: "daily.briefing_push.outside_window" },
        meta: { local_hour: hour },
      });
      return "outside-window";
    }

    // One per user per LOCAL day. Anchored on the `push_attempts` ledger the
    // senders already write (`ok` on a successful delivery), exactly like the
    // coach-nudge cap: whichever trigger fired first this morning left an `ok`
    // row, so the second is suppressed. Compared by local day-key (DST-safe),
    // so the day boundary is the user's, not UTC's.
    const lastOk = await prisma.pushAttempt.findFirst({
      where: { userId, eventType: "DAILY_BRIEFING", result: "ok" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (lastOk && userDayKey(lastOk.createdAt, tz) === userDayKey(now, tz)) {
      annotate({
        action: { name: "daily.briefing_push.suppressed_frequency" },
      });
      return "suppressed-frequency";
    }

    // Resolved once, off the job path (stored locale, then the operator
    // default), and handed to the digest so its lines and the push copy
    // are in the same language.
    const locale = await resolveJobLocale(user.locale);
    const digest = await loadDigest(user, now, locale);
    if (!digestHasSubstance(digest)) {
      annotate({ action: { name: "daily.briefing_push.no_digest" } });
      return "no-digest";
    }

    const { t } = getServerTranslator(locale);
    const { title, body } = buildDailyBriefingPush(digest, t);

    const outcome = await dispatch({
      // NON-URGENT by construction: no `urgent` flag, and DAILY_BRIEFING is not
      // MEDICATION_REMINDER, so `isUrgentPayload` is false — this never
      // escalates to a time-sensitive / Focus-bypassing delivery. It is a calm
      // nudge, never the anomaly channel.
      eventType: "DAILY_BRIEFING",
      userId,
      title,
      message: body,
      metadata: {
        url: DAILY_BRIEFING_DEEP_LINK,
        phase: digest.phase,
        scheduledAt: now.toISOString(),
      },
    });

    if (!outcome.dispatched) {
      // No channel delivered — leave the ledger slot free (no `ok` row) so a
      // later trigger this morning can still succeed once a channel recovers.
      annotate({ action: { name: "daily.briefing_push.no_channel" } });
      return "no-channel";
    }

    annotate({
      action: { name: "daily.briefing_push.sent" },
      meta: {
        daily_briefing_phase: digest.phase,
        daily_briefing_sleep_pending: digest.sleepPending,
      },
    });
    return "sent";
  } catch (err) {
    getEvent()?.addWarning(
      `daily-briefing push failed for ${userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "error";
  }
}
