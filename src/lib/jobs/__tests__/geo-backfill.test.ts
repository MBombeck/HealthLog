import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

vi.mock("@/lib/geo", () => ({
  lookupIpGeo: vi.fn(),
}));

import {
  GEO_BACKFILL_BATCH_CAP,
  GEO_BACKFILL_CRON,
  GEO_BACKFILL_QUEUE,
  GEO_BACKFILL_RETRY_DAYS,
  GEO_BACKFILL_WINDOW_DAYS,
  runGeoBackfill,
} from "../geo-backfill";
import { lookupIpGeo } from "@/lib/geo";

interface FakeRow {
  id: string;
  ipAddress: string | null;
}

function makePrismaMock(rows: FakeRow[]) {
  return {
    auditLog: {
      findMany: vi.fn().mockResolvedValue(rows),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
}

const EMPTY_GEO = { location: null, asn: null, carrier: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lookupIpGeo).mockResolvedValue(EMPTY_GEO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runGeoBackfill", () => {
  it("returns an empty summary when no rows match the filter", async () => {
    const prisma = makePrismaMock([]);
    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 0,
      located: 0,
      carrierResolved: 0,
      stillUnresolved: 0,
    });
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("queries rows missing location OR carrier + ipAddress is not null + createdAt > now()-30d", async () => {
    const prisma = makePrismaMock([]);
    const now = new Date("2026-05-15T12:00:00Z");
    await runGeoBackfill(prisma, now);

    const args = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({
      OR: [{ location: null }, { carrier: null }],
      ipAddress: { not: null },
      createdAt: {
        gt: new Date(now.getTime() - GEO_BACKFILL_WINDOW_DAYS * 86_400_000),
      },
      // A row tried less than the retry wait ago is not picked again.
      AND: [
        {
          OR: [
            { geoAttemptedAt: null },
            {
              geoAttemptedAt: {
                lt: new Date(
                  now.getTime() - GEO_BACKFILL_RETRY_DAYS * 86_400_000,
                ),
              },
            },
          ],
        },
      ],
    });
    expect(args?.take).toBe(GEO_BACKFILL_BATCH_CAP);
  });

  it("caps the batch at 500 rows per pass (v1.4.38 — tightened from 5000 to bound the worst-case ipwho.is fallback budget)", async () => {
    expect(GEO_BACKFILL_BATCH_CAP).toBe(500);
  });

  it("updates a row with location only when the carrier resolver misses", async () => {
    const prisma = makePrismaMock([{ id: "a1", ipAddress: "203.0.113.7" }]);
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Berlin, DE",
      asn: null,
      carrier: null,
    });

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 1,
      located: 1,
      carrierResolved: 0,
      stillUnresolved: 0,
    });
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { location: "Berlin, DE", geoAttemptedAt: expect.any(Date) },
    });
  });

  it("updates a row with asn + carrier alongside location", async () => {
    const prisma = makePrismaMock([{ id: "a2", ipAddress: "84.131.0.1" }]);
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "München, DE",
      asn: 3320,
      carrier: "Deutsche Telekom AG",
    });

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 1,
      located: 1,
      carrierResolved: 1,
      stillUnresolved: 0,
    });
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "a2" },
      data: {
        location: "München, DE",
        asn: 3320,
        carrier: "Deutsche Telekom AG",
        geoAttemptedAt: expect.any(Date),
      },
    });
  });

  it("updates a row with carrier (no asn) when the online provider omits the AS number", async () => {
    // v1.25.8 — ip-api can return `isp` without a parseable `as` field, so a
    // carrier resolves without an ASN. The carrier alone still counts.
    const prisma = makePrismaMock([{ id: "a2b", ipAddress: "84.131.0.2" }]);
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Bochum, DE",
      asn: null,
      carrier: "Deutsche Telekom AG",
    });

    const summary = await runGeoBackfill(prisma);

    expect(summary.carrierResolved).toBe(1);
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "a2b" },
      data: {
        location: "Bochum, DE",
        carrier: "Deutsche Telekom AG",
        geoAttemptedAt: expect.any(Date),
      },
    });
  });

  it("updates a row with carrier only when the location resolver misses", async () => {
    const prisma = makePrismaMock([{ id: "a3", ipAddress: "139.7.0.1" }]);
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: null,
      asn: 3209,
      carrier: "Vodafone GmbH",
    });

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 1,
      located: 0,
      carrierResolved: 1,
      stillUnresolved: 0,
    });
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "a3" },
      data: {
        carrier: "Vodafone GmbH",
        asn: 3209,
        geoAttemptedAt: expect.any(Date),
      },
    });
  });

  it("stamps only the attempt when the resolver misses entirely, counts as still-unresolved", async () => {
    const prisma = makePrismaMock([{ id: "a4", ipAddress: "192.0.2.1" }]);
    vi.mocked(lookupIpGeo).mockResolvedValueOnce(EMPTY_GEO);
    const now = new Date("2026-05-15T12:00:00Z");

    const summary = await runGeoBackfill(prisma, now);

    expect(summary).toEqual({
      scanned: 1,
      located: 0,
      carrierResolved: 0,
      stillUnresolved: 1,
    });
    // The try is recorded, so the next passes leave the row alone until
    // the retry wait has passed.
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "a4" },
      data: { geoAttemptedAt: now },
    });
  });

  it("handles a mixed batch of hits and misses", async () => {
    const prisma = makePrismaMock([
      { id: "a", ipAddress: "84.131.0.1" },
      { id: "b", ipAddress: "192.0.2.99" },
      { id: "c", ipAddress: "139.7.0.1" },
    ]);
    vi.mocked(lookupIpGeo)
      .mockResolvedValueOnce({
        location: "Berlin, DE",
        asn: 3320,
        carrier: "Deutsche Telekom AG",
      }) // a
      .mockResolvedValueOnce(EMPTY_GEO) // b
      .mockResolvedValueOnce({
        location: "Hamburg, DE",
        asn: 3209,
        carrier: "Vodafone GmbH",
      }); // c

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 3,
      located: 2,
      carrierResolved: 2,
      stillUnresolved: 1,
    });
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(3);
  });

  it("treats a Prisma update throw as still-unresolved without aborting the pass", async () => {
    const prisma = makePrismaMock([
      { id: "x", ipAddress: "84.131.0.1" },
      { id: "y", ipAddress: "139.7.0.1" },
    ]);
    vi.mocked(lookupIpGeo)
      .mockResolvedValueOnce({
        location: "Berlin, DE",
        asn: null,
        carrier: null,
      })
      .mockResolvedValueOnce({
        location: "Hamburg, DE",
        asn: null,
        carrier: null,
      });
    vi.mocked(prisma.auditLog.update)
      .mockRejectedValueOnce(new Error("row gone"))
      .mockResolvedValueOnce({} as never);

    const summary = await runGeoBackfill(prisma);

    expect(summary.scanned).toBe(2);
    expect(summary.located).toBe(2);
    expect(summary.stillUnresolved).toBe(1);
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(2);
  });

  it("skips rows whose ipAddress is null (defensive — findMany filter already excludes)", async () => {
    const prisma = makePrismaMock([{ id: "z", ipAddress: null }]);

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 1,
      located: 0,
      carrierResolved: 0,
      stillUnresolved: 1,
    });
    expect(lookupIpGeo).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });
});

/**
 * The helper is scheduled via pg-boss at the hourly :40 slot. The
 * schedule constants live in the helper module so the worker registry
 * pulls them by import; this test pins both shapes so a regression that
 * drops the cadence or drifts the queue name lands here, not in
 * production.
 */
describe("geo-backfill scheduling contract", () => {
  it("exports the pg-boss queue name", () => {
    expect(GEO_BACKFILL_QUEUE).toBe("geo-backfill");
  });

  it("schedules on the :40 slot every hour to avoid colliding with the existing crons", () => {
    expect(GEO_BACKFILL_CRON).toBe("40 * * * *");
  });

  it("the worker registry schedules the queue and binds the ops handler", async () => {
    // The handler module's import is read as text; the queue facts come from
    // the registry, so neither pg-boss nor a live Postgres connection boots.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const handlerSrc = await fs.readFile(
      path.resolve(__dirname, "..", "reminder", "ops-handlers.ts"),
      "utf-8",
    );
    expect(handlerSrc).toMatch(
      /import \{[^}]*runGeoBackfill[^}]*\} from "@\/lib\/jobs\/geo-backfill";/,
    );
    const { groupOf, jobOf, loadedHandler } =
      await import("../registry/__tests__/registry-helpers");
    const { handleGeoBackfill } = await import("../reminder/ops-handlers");
    expect(groupOf(GEO_BACKFILL_QUEUE).name).toBe("maintenance");
    expect(jobOf(GEO_BACKFILL_QUEUE).cron).toBe(GEO_BACKFILL_CRON);
    expect(await loadedHandler(GEO_BACKFILL_QUEUE)).toBe(handleGeoBackfill);
  });
});
