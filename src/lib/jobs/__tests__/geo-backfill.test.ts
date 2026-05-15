import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(),
  lookupIpAsn: vi.fn(),
}));

import {
  GEO_BACKFILL_BATCH_CAP,
  GEO_BACKFILL_WINDOW_DAYS,
  runGeoBackfill,
} from "../geo-backfill";
import { lookupIpAsn, lookupIpLocation } from "@/lib/geo";

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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lookupIpAsn).mockReturnValue(null);
  vi.mocked(lookupIpLocation).mockResolvedValue(null);
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

  it("queries rows where location is null + ipAddress is not null + createdAt > now()-30d", async () => {
    const prisma = makePrismaMock([]);
    const now = new Date("2026-05-15T12:00:00Z");
    await runGeoBackfill(prisma, now);

    const args = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({
      location: null,
      ipAddress: { not: null },
      createdAt: {
        gt: new Date(
          now.getTime() - GEO_BACKFILL_WINDOW_DAYS * 86_400_000,
        ),
      },
    });
    expect(args?.take).toBe(GEO_BACKFILL_BATCH_CAP);
  });

  it("caps the batch at 5000 rows per pass", async () => {
    expect(GEO_BACKFILL_BATCH_CAP).toBe(5000);
  });

  it("updates a row with location only when ASN resolver misses", async () => {
    const prisma = makePrismaMock([{ id: "a1", ipAddress: "203.0.113.7" }]);
    vi.mocked(lookupIpLocation).mockResolvedValueOnce("Berlin, DE");
    vi.mocked(lookupIpAsn).mockReturnValueOnce(null);

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 1,
      located: 1,
      carrierResolved: 0,
      stillUnresolved: 0,
    });
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { location: "Berlin, DE" },
    });
  });

  it("updates a row with asn + carrier alongside location", async () => {
    const prisma = makePrismaMock([{ id: "a2", ipAddress: "84.131.0.1" }]);
    vi.mocked(lookupIpLocation).mockResolvedValueOnce("München, DE");
    vi.mocked(lookupIpAsn).mockReturnValueOnce({
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
      },
    });
  });

  it("updates a row with ASN only when location resolver misses but ASN hits", async () => {
    const prisma = makePrismaMock([{ id: "a3", ipAddress: "139.7.0.1" }]);
    vi.mocked(lookupIpLocation).mockResolvedValueOnce(null);
    vi.mocked(lookupIpAsn).mockReturnValueOnce({
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
      data: { asn: 3209, carrier: "Vodafone GmbH" },
    });
  });

  it("skips the update when both resolvers miss, counts as still-unresolved", async () => {
    const prisma = makePrismaMock([{ id: "a4", ipAddress: "192.0.2.1" }]);
    vi.mocked(lookupIpLocation).mockResolvedValueOnce(null);
    vi.mocked(lookupIpAsn).mockReturnValueOnce(null);

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 1,
      located: 0,
      carrierResolved: 0,
      stillUnresolved: 1,
    });
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("handles a mixed batch of hits and misses", async () => {
    const prisma = makePrismaMock([
      { id: "a", ipAddress: "84.131.0.1" },
      { id: "b", ipAddress: "192.0.2.99" },
      { id: "c", ipAddress: "139.7.0.1" },
    ]);
    vi.mocked(lookupIpLocation)
      .mockResolvedValueOnce("Berlin, DE") // a
      .mockResolvedValueOnce(null) // b
      .mockResolvedValueOnce("Hamburg, DE"); // c
    vi.mocked(lookupIpAsn)
      .mockReturnValueOnce({ asn: 3320, carrier: "Deutsche Telekom AG" }) // a
      .mockReturnValueOnce(null) // b
      .mockReturnValueOnce({ asn: 3209, carrier: "Vodafone GmbH" }); // c

    const summary = await runGeoBackfill(prisma);

    expect(summary).toEqual({
      scanned: 3,
      located: 2,
      carrierResolved: 2,
      stillUnresolved: 1,
    });
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(2);
  });

  it("treats a Prisma update throw as still-unresolved without aborting the pass", async () => {
    const prisma = makePrismaMock([
      { id: "x", ipAddress: "84.131.0.1" },
      { id: "y", ipAddress: "139.7.0.1" },
    ]);
    vi.mocked(lookupIpLocation)
      .mockResolvedValueOnce("Berlin, DE")
      .mockResolvedValueOnce("Hamburg, DE");
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
    expect(lookupIpLocation).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });
});
