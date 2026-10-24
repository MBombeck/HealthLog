/**
 * The negative-cache window of a status note: how long a note whose
 * generation stalled, erred or was screened waits before it is generated
 * again.
 *
 * The window used to be a fixed five minutes that only the read path
 * honoured. #1279 — a model that never answers then failed every five
 * minutes per note, and a note the next data sync selected again ignored the
 * window altogether. The window now grows with the failures in a row
 * (`failureStreak`), and every generation waits it out at the provider
 * chokepoint (`runStatusCompletion`), whichever path selected the note.
 */
import { prisma } from "@/lib/db";
import { statusCacheKey } from "@/lib/insights/status-cache";

/** The first negative-cache window after a generation that left no note. */
export const STATUS_NEGATIVE_WINDOW_BASE_MS = 5 * 60 * 1000;

/** The longest window: a note is tried again at least this often. */
export const STATUS_NEGATIVE_WINDOW_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * The window after `streak` generations in a row ended without a note:
 * five minutes, doubling per further failure, up to two hours (#1279).
 */
export function statusNegativeWindowMs(streak: number): number {
  const doublings = Math.min(Math.max(streak - 1, 0), 16);
  return Math.min(
    STATUS_NEGATIVE_WINDOW_BASE_MS * 2 ** doublings,
    STATUS_NEGATIVE_WINDOW_MAX_MS,
  );
}

/**
 * Open a negative-cache window for a note: the generation stalled, erred, or
 * was screened. Leaves any stored note exactly as it was.
 *
 * #1279 — the window grows with the failures in a row (`failureStreak`,
 * `statusNegativeWindowMs`), so a model that never answers is asked about a
 * note less and less often instead of every five minutes. A failure while a
 * window is still open (a generation that was refused for it, or one that
 * raced another) neither moves it nor counts.
 */
export async function writeStatusNegativeWindow(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  reason: "timeout" | "error" | "screened";
}): Promise<void> {
  const key = statusCacheKey(args.cacheAction);
  if (!key) return;
  const where = { userId_metric_locale: { userId: args.userId, ...key } };
  const row = await prisma.insightStatusCache.findUnique({
    where,
    select: { retryAt: true, failureStreak: true },
  });
  const now = Date.now();
  if (row?.retryAt && row.retryAt.getTime() > now) return;
  const failureStreak = (row?.failureStreak ?? 0) + 1;
  const retryAt = new Date(now + statusNegativeWindowMs(failureStreak));
  await prisma.insightStatusCache.upsert({
    where,
    create: {
      userId: args.userId,
      ...key,
      dateKey: args.todayKey,
      retryAt,
      negativeReason: args.reason,
      failureStreak,
    },
    update: { retryAt, negativeReason: args.reason, failureStreak },
  });
}

/**
 * #1279 — hold a note while its chain sent nothing: every provider was
 * benched for background work (or refused by the operator cost cap). Such a
 * run says nothing about the note, and counting it left the note waiting up
 * to two hours after the provider recovered. Opens the first window unless
 * one is open and leaves the streak as it was, so the caller's own failure
 * write lands inside it and neither moves nor counts. Best-effort: a missed
 * hold only lets that write count.
 */
export async function holdStatusNoteWhileBenched(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
}): Promise<void> {
  const key = statusCacheKey(args.cacheAction);
  if (!key) return;
  const where = { userId_metric_locale: { userId: args.userId, ...key } };
  try {
    const row = await prisma.insightStatusCache.findUnique({
      where,
      select: { retryAt: true },
    });
    const now = Date.now();
    if (row?.retryAt && row.retryAt.getTime() > now) return;
    const retryAt = new Date(now + STATUS_NEGATIVE_WINDOW_BASE_MS);
    await prisma.insightStatusCache.upsert({
      where,
      create: {
        userId: args.userId,
        ...key,
        dateKey: args.todayKey,
        retryAt,
        negativeReason: "error",
        failureStreak: 0,
      },
      update: { retryAt, negativeReason: "error" },
    });
  } catch {
    // The caller's own write still opens a window.
  }
}

/**
 * True while the note's negative-cache window is open. #1279 — checked right
 * before a status generation reaches a provider (`runStatusCompletion`), so
 * no path that selects the note again (the next data sync, a warm pass, a
 * queued job) can ask about it inside the window.
 */
export async function statusNoteCoolingDown(
  userId: string,
  cacheAction: string,
): Promise<boolean> {
  const key = statusCacheKey(cacheAction);
  if (!key) return false;
  const row = await prisma.insightStatusCache.findUnique({
    where: { userId_metric_locale: { userId, ...key } },
    select: { retryAt: true },
  });
  return row?.retryAt != null && row.retryAt.getTime() > Date.now();
}

/**
 * Close every open window on one record's notes, streaks included: the person
 * asked for fresh notes (the regenerate action) or changed what answers them.
 * Without `userId`, on every record's notes: the operator changed the
 * provider every account may fall back on. Best-effort: a failed write leaves
 * windows that lapse on their own.
 */
export async function clearStatusNegativeWindows(
  userId?: string,
): Promise<void> {
  try {
    await prisma.insightStatusCache.updateMany({
      where: {
        ...(userId ? { userId } : {}),
        OR: [{ retryAt: { not: null } }, { failureStreak: { gt: 0 } }],
      },
      data: { retryAt: null, negativeReason: null, failureStreak: 0 },
    });
  } catch {
    // The windows lapse by themselves.
  }
}
