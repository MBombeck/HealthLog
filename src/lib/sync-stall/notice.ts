/**
 * "Apple Health has sent nothing since yesterday": the `SYNC_STALLED` notice.
 *
 * Tells the owner once when a source that delivers on its own every day has
 * gone quiet against its own rhythm: an iPhone whose Apple Health upload
 * stopped (`devices.ts`; a force-quit app gets no silent push and no
 * background delivery, so only a visible notification still reaches it), or
 * a ring, watch, scale or cloud the integration watchdog flagged
 * (`IntegrationWatch.silentSince`, by the same rule, `cadence.ts`).
 *
 * Built not to nag:
 *
 *   - Once per stall. The stall's own stamp (`Device.healthQuietNotifiedAt`,
 *     `IntegrationWatch.ownerNotifiedAt`) is claimed before the send and
 *     cleared only when the stall ends, so the next delivery re-arms it.
 *   - Only in the person's daytime, local {@link NOTICE_EARLIEST_HOUR} to
 *     {@link NOTICE_LATEST_HOUR}, never at night; a stall that begins at night
 *     is told in the morning.
 *   - At most one notice a day, whatever else went quiet; the next source
 *     waits for the next day, and is not told at all if it delivered by then.
 *   - An iPhone whose sibling device still delivers Apple Health data is
 *     settled without a notice: the data is arriving.
 *   - A notice nobody wanted (every channel off for the event) settles the
 *     stall; a notice that failed on every channel hands its claims back, so
 *     the next hour tries again.
 *
 * The Apple Health line asks for one thing: open HealthLog once, which runs
 * the foreground upload and lets iOS resume background delivery. The tap
 * opens the source's own card on the integrations page.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  OWNED_BY_ACTIVE_ACCOUNT,
  activeAccount,
} from "@/lib/account-deletion/active-account";
import { prisma as defaultPrisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  CONNECTION_LABELS,
  type ConnectionKey,
} from "@/lib/integrations/connection-health";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";

import { runDeviceStallPass } from "./devices";
import {
  STALL_SOURCES,
  iphoneDelivers,
  quietSinceDate,
  quietSinceWording,
  stallTapUrl,
} from "./quiet";

export const SYNC_STALLED_EVENT = "SYNC_STALLED";
/** The first local hour a notice may go out in. */
export const NOTICE_EARLIEST_HOUR = 9;
/** The local hour from which no notice goes out until the next morning. */
export const NOTICE_LATEST_HOUR = 20;
/**
 * The least spacing between two notices to one person. A little under a
 * day, so the hourly pass can tell the next stall at the same hour tomorrow.
 */
export const NOTICE_SPACING_MS = 22 * 60 * 60 * 1000;

/** Whether `now` lies in the person's daytime, when a notice may go out. */
export function inNoticeWindow(now: Date, tz: string): boolean {
  const { hour } = wallClockInTz(now, tz);
  return hour >= NOTICE_EARLIEST_HOUR && hour < NOTICE_LATEST_HOUR;
}

/** One untold stall. */
interface Stall {
  kind: "device" | "integration";
  /** The device or the watch row. */
  id: string;
  userId: string;
  source: ConnectionKey;
  since: Date;
}

/** The notice for one stall in one locale. Pure. */
export function renderStallNotice(
  stall: { source: ConnectionKey; since: Date },
  now: Date,
  tz: string,
  locale: Locale,
): { title: string; message: string } {
  const { t } = getServerTranslator(locale);
  const provider = CONNECTION_LABELS[stall.source];
  const date = quietSinceDate(stall.since, tz, locale);
  const params = { provider, date };
  const yesterday = quietSinceWording(stall.since, now, tz) === "yesterday";
  // An iPhone resumes once the app runs; a ring, a watch or a cloud may need
  // its own app opened, or a reconnect.
  const message =
    stall.source === "apple-health"
      ? yesterday
        ? t("notifications.syncStalled.appleYesterday", params)
        : t("notifications.syncStalled.appleSince", params)
      : yesterday
        ? t("notifications.syncStalled.sourceYesterday", params)
        : t("notifications.syncStalled.sourceSince", params);
  return {
    title: t("notifications.syncStalled.title", { provider }),
    message,
  };
}

export interface SyncStallFacts {
  devicesJudged: number;
  devicesFlagged: number;
  devicesCleared: number;
  hoursPruned: number;
  candidates: number;
  sent: number;
  settled: number;
  /** People whose notice threw or reached no channel; the pass carried on. */
  failed: number;
}

/**
 * The hourly pass: judge the iPhones, then tell whoever has an untold stall
 * and is in their daytime. Runs after the integration watchdog, so its flags
 * are this hour's.
 */
export async function runSyncStallPass(
  now: Date = new Date(),
  prisma: PrismaClient = defaultPrisma,
): Promise<SyncStallFacts> {
  const devices = await runDeviceStallPass(prisma, now);
  const notices = await runSyncStallNotices(now, prisma);
  const facts: SyncStallFacts = {
    devicesJudged: devices.judged,
    devicesFlagged: devices.flagged,
    devicesCleared: devices.cleared,
    hoursPruned: devices.pruned,
    ...notices,
  };
  annotate({
    action: { name: "notification.syncStalled.pass" },
    meta: { ...facts },
  });
  return facts;
}

async function untoldStalls(prisma: PrismaClient): Promise<Stall[]> {
  const [devices, watches] = await Promise.all([
    prisma.device.findMany({
      where: {
        platform: "ios",
        healthQuietSince: { not: null },
        healthQuietNotifiedAt: null,
        ...OWNED_BY_ACTIVE_ACCOUNT,
      },
      select: { id: true, userId: true, healthQuietSince: true },
    }),
    prisma.integrationWatch.findMany({
      where: {
        silentSince: { not: null },
        ownerNotifiedAt: null,
        // An iPhone is told per device above, never as the account's
        // Apple Health connection.
        integration: { not: "apple-health" },
        ...OWNED_BY_ACTIVE_ACCOUNT,
      },
      select: { id: true, userId: true, integration: true, silentSince: true },
    }),
  ]);
  const stalls: Stall[] = [];
  for (const d of devices) {
    stalls.push({
      kind: "device",
      id: d.id,
      userId: d.userId,
      source: "apple-health",
      since: d.healthQuietSince!,
    });
  }
  for (const w of watches) {
    const key = w.integration as ConnectionKey;
    if (!STALL_SOURCES.includes(key)) continue;
    stalls.push({
      kind: "integration",
      id: w.id,
      userId: w.userId,
      source: key,
      since: w.silentSince!,
    });
  }
  return stalls;
}

/** Claim (or hand back) a stall's once-per-stall stamp. */
async function stampStall(
  prisma: PrismaClient,
  stall: Stall,
  at: Date | null,
): Promise<boolean> {
  if (stall.kind === "device") {
    const { count } = await prisma.device.updateMany({
      where: {
        id: stall.id,
        healthQuietSince: stall.since,
        healthQuietNotifiedAt: at === null ? { not: null } : null,
      },
      data: { healthQuietNotifiedAt: at },
    });
    return count > 0;
  }
  const { count } = await prisma.integrationWatch.updateMany({
    where: {
      id: stall.id,
      silentSince: stall.since,
      ownerNotifiedAt: at === null ? { not: null } : null,
    },
    data: { ownerNotifiedAt: at },
  });
  return count > 0;
}

/** Whether another iPhone of the account still delivers Apple Health data. */
async function siblingDelivers(
  prisma: PrismaClient,
  stall: Stall,
  now: Date,
): Promise<boolean> {
  const siblings = await prisma.device.findMany({
    where: {
      userId: stall.userId,
      platform: "ios",
      id: { not: stall.id },
      healthIngestAt: { not: null },
    },
    select: { healthIngestAt: true },
  });
  return siblings.some((d) => iphoneDelivers(d.healthIngestAt, now));
}

export async function runSyncStallNotices(
  now: Date,
  prisma: PrismaClient = defaultPrisma,
): Promise<Pick<SyncStallFacts, "candidates" | "sent" | "settled" | "failed">> {
  const facts = { candidates: 0, sent: 0, settled: 0, failed: 0 };
  const stalls = await untoldStalls(prisma);
  facts.candidates = stalls.length;
  if (stalls.length === 0) return facts;

  const byUser = new Map<string, Stall[]>();
  for (const stall of stalls) {
    const list = byUser.get(stall.userId) ?? [];
    list.push(stall);
    byUser.set(stall.userId, list);
  }
  const users = await prisma.user.findMany({
    where: activeAccount({ id: { in: [...byUser.keys()] } }),
    select: { id: true, timezone: true, locale: true },
  });

  for (const user of users) {
    const tz = user.timezone || DEFAULT_TIMEZONE;
    // Oldest first: the source quiet the longest is told first.
    const own = byUser
      .get(user.id)!
      .sort((a, b) => a.since.getTime() - b.since.getTime());
    try {
      const outcome = await noticeUser(prisma, user, tz, own, now);
      facts.settled += outcome.settled;
      if (outcome.result === "sent") facts.sent += 1;
      if (outcome.result === "undelivered") facts.failed += 1;
    } catch (err) {
      facts.failed += 1;
      logCaught("notification.syncStalled.failed", err);
    }
  }
  return facts;
}

async function noticeUser(
  prisma: PrismaClient,
  user: { id: string; locale: string | null },
  tz: string,
  stalls: Stall[],
  now: Date,
): Promise<{ result: "sent" | "quiet" | "undelivered"; settled: number }> {
  let settled = 0;
  const open: Stall[] = [];
  for (const stall of stalls) {
    // Another iPhone still delivers: the data is arriving, nothing to tell.
    if (
      stall.kind === "device" &&
      (await siblingDelivers(prisma, stall, now))
    ) {
      if (await stampStall(prisma, stall, now)) settled += 1;
      continue;
    }
    open.push(stall);
  }
  if (open.length === 0 || !inNoticeWindow(now, tz)) {
    return { result: "quiet", settled };
  }

  for (const stall of open) {
    // The stall's own claim first: two workers on one pass tell it once.
    if (!(await stampStall(prisma, stall, now))) continue;
    const dayFree = await claimNotificationEvent(prisma, {
      recordUserId: user.id,
      eventType: SYNC_STALLED_EVENT,
      dedupKey: "day",
      since: new Date(now.getTime() - NOTICE_SPACING_MS),
      at: now,
    });
    if (!dayFree) {
      // Told about another source today: this one waits for tomorrow.
      await stampStall(prisma, stall, null);
      return { result: "quiet", settled };
    }
    const releaseDay = () =>
      prisma.notificationEvent.deleteMany({
        where: {
          recordUserId: user.id,
          eventType: SYNC_STALLED_EVENT,
          dedupKey: "day",
          createdAt: { gte: new Date(now.getTime() - NOTICE_SPACING_MS) },
        },
      });

    const render = (locale: Locale) =>
      renderStallNotice(stall, now, tz, locale);
    let outcome: Awaited<ReturnType<typeof dispatchNotification>>;
    try {
      const text = render(await resolveJobLocale(user.locale));
      outcome = await dispatchNotification({
        eventType: SYNC_STALLED_EVENT,
        userId: user.id,
        title: text.title,
        message: text.message,
        renderForRecipient: render,
        metadata: { source: stall.source, url: stallTapUrl(stall.source) },
      });
    } catch (err) {
      await releaseDay();
      await stampStall(prisma, stall, null);
      throw err;
    }
    if (outcome.dispatched) {
      annotate({
        action: { name: "notification.syncStalled.sent" },
        meta: { source: stall.source, kind: stall.kind },
      });
      return { result: "sent", settled };
    }
    // Nothing went out, so the day is not used up.
    await releaseDay();
    if (outcome.channelsAttempted > 0) {
      // Every channel tried and failed: the next hour tries again.
      await stampStall(prisma, stall, null);
      return { result: "undelivered", settled };
    }
    // No channel wants the event: the stall is settled, untold.
    settled += 1;
  }
  return { result: "quiet", settled };
}
