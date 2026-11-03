/**
 * The geo backfill tries a row once per retry wait, and finds its candidates
 * through the partial index that holds only them.
 *
 * Before migration 0418 an address no database could place was looked up on
 * every hourly pass for thirty days, and every pass walked thirty days of
 * audit rows to find it. Run against the real table: the second pass must not
 * pick the row again, a pass past the wait must, and the candidate read must
 * go through `audit_logs_geo_backfill_idx` (read off the index's own scan
 * counter, so the statement under test is the one Prisma actually sends).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/geo", () => ({
  lookupIpGeo: vi.fn(async (ip: string) =>
    ip.startsWith("10.")
      ? { location: null, asn: null, carrier: null }
      : { location: "Bochum, DE", asn: 3320, carrier: "Deutsche Telekom AG" },
  ),
}));

const { runGeoBackfill, GEO_BACKFILL_RETRY_DAYS } =
  await import("@/lib/jobs/geo-backfill");
const { lookupIpGeo } = await import("@/lib/geo");

const prisma = getPrismaClient();
const USER = "geo-backfill-attempt";
const DAY = 86_400_000;
const NOW = new Date();

async function indexScans(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT idx_scan AS n FROM pg_stat_user_indexes
    WHERE indexrelname = 'audit_logs_geo_backfill_idx'`;
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
  // Enough resolved history that a sequential walk is the costlier plan.
  await prisma.$executeRaw`
    INSERT INTO audit_logs (id, user_id, action, ip_address, location, asn, carrier, created_at)
    SELECT 'resolved-' || g, ${USER}, 'measurement.create', '84.131.0.1',
           'Bochum, DE', 3320, 'Deutsche Telekom AG',
           ${NOW}::timestamp - (g * interval '5 seconds')
    FROM generate_series(1, 20000) g`;
  await prisma.auditLog.createMany({
    data: [
      // Never placeable: a private address.
      {
        id: "private",
        userId: USER,
        action: "auth.login",
        ipAddress: "10.1.2.3",
        createdAt: new Date(NOW.getTime() - 2 * DAY),
      },
      // Placeable, missing only its carrier.
      {
        id: "carrierless",
        userId: USER,
        action: "auth.login",
        ipAddress: "84.131.0.9",
        location: "Bochum, DE",
        createdAt: new Date(NOW.getTime() - 3 * DAY),
      },
    ],
  });
  await prisma.$executeRawUnsafe("ANALYZE audit_logs");
}, 120_000);

// Three passes in order: the second must find what the first marked, the
// third runs past the wait the first one set. The order holds under a
// shuffled run.
describe("runGeoBackfill", { shuffle: false }, () => {
  it("reads its candidates through the partial index", async () => {
    const before = await indexScans();
    const summary = await runGeoBackfill(prisma, NOW);
    expect(summary.scanned).toBe(2);
    expect(summary.carrierResolved).toBe(1);
    expect(summary.stillUnresolved).toBe(1);
    // Statistics reach the view asynchronously; give them a moment.
    let after = await indexScans();
    for (let i = 0; i < 40 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      after = await indexScans();
    }
    expect(after).toBeGreaterThan(before);
  });

  it("does not try the unplaceable row again inside the wait", async () => {
    vi.mocked(lookupIpGeo).mockClear();
    const summary = await runGeoBackfill(
      prisma,
      new Date(NOW.getTime() + 60 * 60_000),
    );
    expect(summary.scanned).toBe(0);
    expect(lookupIpGeo).not.toHaveBeenCalled();
  });

  it("tries it again once the wait has passed", async () => {
    const later = new Date(NOW.getTime() + (GEO_BACKFILL_RETRY_DAYS + 1) * DAY);
    const summary = await runGeoBackfill(prisma, later);
    expect(summary.scanned).toBe(1);
    const row = await prisma.auditLog.findUnique({ where: { id: "private" } });
    expect(row?.geoAttemptedAt?.getTime()).toBe(later.getTime());
  });
});
