/**
 * Gather the facts `resolveQuietSources` reads, for one account.
 *
 * Two light reads first: the connections the watchdog has stamped, and the
 * account's iPhones. Only a stamped connection needs its health resolved
 * (`loadConnectionFacts`, the integration card's own loader), so an account
 * with nothing quiet costs two indexed reads.
 */
import type { DailyDigestQuietSource } from "@/lib/daily/quiet-source-items";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import {
  CONNECTION_LABELS,
  type ConnectionKey,
} from "@/lib/integrations/connection-health";
import { loadConnectionFacts } from "@/lib/integrations/connection-health-load";

import {
  STALL_SOURCES,
  quietSinceDate,
  quietSinceWording,
  resolveQuietSources,
  stallTapUrl,
  type QuietSource,
} from "./quiet";

export async function loadQuietSources(
  userId: string,
  now: Date = new Date(),
): Promise<QuietSource[]> {
  const [watches, iphones] = await Promise.all([
    prisma.integrationWatch.findMany({
      where: {
        userId,
        silentSince: { not: null },
        integration: { in: [...STALL_SOURCES] },
      },
      select: { integration: true },
    }),
    prisma.device.findMany({
      where: { userId, platform: "ios", healthIngestAt: { not: null } },
      select: { healthIngestAt: true, healthQuietSince: true },
    }),
  ]);
  const stamped = watches.map((w) => w.integration as ConnectionKey);
  const facts =
    stamped.length > 0
      ? [...(await loadConnectionFacts(userId, stamped, now)).values()]
      : [];
  return resolveQuietSources({ connections: facts, iphones, now });
}

/** The quiet sources worded for the Today rail, the push's own wording. */
export function wordQuietSources(
  quiet: readonly QuietSource[],
  now: Date,
  tz: string,
  locale: Locale,
): DailyDigestQuietSource[] {
  return quiet.map((q) => ({
    source: q.source,
    provider: CONNECTION_LABELS[q.source],
    sinceYesterday: quietSinceWording(q.since, now, tz) === "yesterday",
    date: quietSinceDate(q.since, tz, locale),
    href: stallTapUrl(q.source),
  }));
}
