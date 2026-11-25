/**
 * Gather the facts `resolveQuietSources` reads, for one account.
 *
 * One light read first (both stamp tables in one statement): the connections
 * the watchdog has stamped, and the account's iPhones. Only a stamped connection needs its health resolved
 * (`loadConnectionFacts`, the integration card's own loader), so an account
 * with nothing quiet costs one statement.
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
  // One statement for both stamps: the digest reads this on every request,
  // and its statement budget (`query-budget-hot-routes.test.ts`) counts it.
  const rows = await prisma.$queryRaw<
    Array<{
      integration: string | null;
      ingestAt: Date | null;
      quietSince: Date | null;
    }>
  >`
    SELECT integration, NULL::timestamp AS "ingestAt", NULL::timestamp AS "quietSince"
      FROM integration_watches
     WHERE user_id = ${userId}
       AND silent_since IS NOT NULL
       AND integration = ANY(${[...STALL_SOURCES]}::text[])
    UNION ALL
    SELECT NULL, health_ingest_at, health_quiet_since
      FROM devices
     WHERE user_id = ${userId}
       AND platform = 'ios'
       AND health_ingest_at IS NOT NULL`;
  const stamped = rows.flatMap((r) =>
    r.integration === null ? [] : [r.integration as ConnectionKey],
  );
  const iphones = rows
    .filter((r) => r.integration === null)
    .map((r) => ({
      healthIngestAt: r.ingestAt,
      healthQuietSince: r.quietSince,
    }));
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
