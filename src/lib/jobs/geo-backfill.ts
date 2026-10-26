/**
 * v1.4.27 — Backfill `location` + `asn` + `carrier` on audit-log
 * rows that landed with the offline DB unavailable or with `ipwho.is`
 * timing out.
 *
 * The fire-and-forget lookup in `src/lib/auth/audit.ts` runs once at
 * audit-creation time. If the offline MMDB was missing on a host
 * (operator skipped the GeoLite2 fetch step) or if the online
 * provider was down, the row stays at `location IS NULL` forever
 * with no retry path. This helper walks those rows and re-resolves
 * them through the now-bundled offline databases.
 *
 * The scope is intentionally narrow:
 *
 *   - Only rows where `location IS NULL` OR `carrier IS NULL`, and
 *     `ipAddress IS NOT NULL`. A null IP has no signal to backfill against.
 *     (v1.25.8 widened this from location-only so rows whose location had
 *     already resolved online but whose carrier was left null on a host
 *     without the offline ASN MMDB get the now-online carrier filled in.)
 *   - Only rows from the last 30 days. Rows beyond that retention
 *     window typically belong to deleted users or have aged out of
 *     the operational triage window where the `location` chip
 *     matters.
 *   - Capped at 500 rows per pass. Each row spends up to 3 s on the
 *     `lookupIpLocation` online fallback (offline MMDB miss → ipwho.is
 *     timeout), so 500 rows × 3 s caps the worst-case pass at ~25 min
 *     and keeps the hourly cron from stacking. Earlier passes ran at
 *     5 000 rows, which let a single backfill burst block for ~4 h and
 *     starve the next scheduled run. The trade-off: a tenant with a
 *     large null-`location` backlog now drains over multiple hourly
 *     passes instead of one mega-pass — fine because the helper is
 *     idempotent and the admin sign-in overview tolerates a stale
 *     Standort cell for the few hours convergence takes.
 *
 * Idempotent: a row that the resolver still cannot match (private IP
 * sneaking through CF egress, freshly-allocated range the GeoLite2
 * release hasn't picked up yet) stays NULL. Every row a pass looks at is
 * stamped `geoAttemptedAt`, and a row stamped less than
 * `GEO_BACKFILL_RETRY_DAYS` ago is not picked again: an address no
 * database will ever place used to be looked up on every hourly pass for
 * its whole 30-day window, and finding it walked every audit row of those
 * 30 days. The wait still lets a range a later GeoLite2 release learns
 * resolve on a later pass. The candidates are read through the partial
 * index `audit_logs_geo_backfill_idx` (migration 0418), which holds only
 * the rows still missing something. The cap is per-call, not per-row, so
 * the helper can be scheduled at any cadence without doubling up.
 *
 * No notifications, no event ladder — the maintainer can read the
 * counts off the returned summary and decide whether to keep
 * scheduling.
 */
// account-deletion(file): fills the place of audit rows by their IP address; bookkeeping on rows, not work for an account.
import type { PrismaClient } from "@/generated/prisma/client";
import { lookupIpGeo } from "@/lib/geo";

export const GEO_BACKFILL_BATCH_CAP = 500;
export const GEO_BACKFILL_WINDOW_DAYS = 30;
/** How long a row the backfill could not complete waits for its next try. */
export const GEO_BACKFILL_RETRY_DAYS = 7;

/**
 * v1.4.37 — pg-boss queue name + cron expression for the recurring
 * backfill. Offset to :40 every hour so the schedule does not collide
 * with the existing :00 / :15 / :30 Withings crons that
 * already crowd the top of the hour. The helper is idempotent + the
 * batch cap is per-call, so an hourly cadence is the right balance
 * between freshness of the admin sign-in "Standort" column and the
 * audit-log write budget.
 */
export const GEO_BACKFILL_QUEUE = "geo-backfill";
export const GEO_BACKFILL_CRON = "40 * * * *";

export interface GeoBackfillSummary {
  scanned: number;
  located: number;
  carrierResolved: number;
  stillUnresolved: number;
}

export async function runGeoBackfill(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<GeoBackfillSummary> {
  const cutoff = new Date(
    now.getTime() - GEO_BACKFILL_WINDOW_DAYS * 86_400_000,
  );
  const retryBefore = new Date(
    now.getTime() - GEO_BACKFILL_RETRY_DAYS * 86_400_000,
  );

  const rows = await prisma.auditLog.findMany({
    where: {
      // v1.25.8 — pick up rows missing EITHER the location or the carrier.
      // Before, the carrier resolved only from the optional offline ASN MMDB,
      // so hosts without it left `carrier` null on rows whose `location` had
      // already resolved online. Now that the online provider yields the
      // carrier too, those rows are re-resolved on the next pass.
      OR: [{ location: null }, { carrier: null }],
      ipAddress: { not: null },
      createdAt: { gt: cutoff },
      AND: [
        {
          OR: [
            { geoAttemptedAt: null },
            { geoAttemptedAt: { lt: retryBefore } },
          ],
        },
      ],
    },
    select: { id: true, ipAddress: true },
    orderBy: { createdAt: "desc" },
    take: GEO_BACKFILL_BATCH_CAP,
  });

  const summary: GeoBackfillSummary = {
    scanned: rows.length,
    located: 0,
    carrierResolved: 0,
    stillUnresolved: 0,
  };

  for (const row of rows) {
    const ip = row.ipAddress;
    if (!ip) {
      summary.stillUnresolved += 1;
      continue;
    }

    // One unified resolve: online location + carrier merged with the offline
    // ASN MMDB. The online fallback bounds itself with a request timeout.
    const { location, asn, carrier } = await lookupIpGeo(ip);

    // Stamped whatever the outcome: a row that resolved leaves the candidate
    // set anyway, and one that did not waits for its next try.
    const data: {
      location?: string;
      asn?: number;
      carrier?: string | null;
      geoAttemptedAt: Date;
    } = { geoAttemptedAt: now };
    if (location) {
      data.location = location;
      summary.located += 1;
    }
    if (carrier) {
      data.carrier = carrier;
      if (typeof asn === "number") data.asn = asn;
      summary.carrierResolved += 1;
    }

    const resolved = data.location !== undefined || data.carrier !== undefined;
    if (!resolved) summary.stillUnresolved += 1;

    try {
      await prisma.auditLog.update({
        where: { id: row.id },
        data,
      });
    } catch {
      // The row may have been deleted by the retention sweeper between
      // findMany and update. Treat as unresolved; the next pass will
      // skip it because the row no longer exists.
      if (resolved) summary.stillUnresolved += 1;
    }
  }

  return summary;
}
