import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    withingsConnection: { findUnique: vi.fn() },
    whoopConnection: { findUnique: vi.fn() },
    fitbitConnection: { findUnique: vi.fn() },
    googleHealthConnection: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  getSourcesInUse,
  RANKABLE_SOURCES,
} from "@/lib/integrations/sources-in-use";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.fitbitConnection.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.googleHealthConnection.findUnique).mockResolvedValue(null);
});

describe("getSourcesInUse", () => {
  it("lists a source the account holds data from", async () => {
    vi.mocked(prisma.measurement.findFirst).mockImplementation(((args: {
      where: { source: string };
    }) =>
      Promise.resolve(
        args.where.source === "MANUAL" ? { id: "m1" } : null,
      )) as never);

    expect(await getSourcesInUse("u1")).toEqual(["MANUAL"]);
  });

  it("does not count a source whose readings were all deleted", async () => {
    // The probe answers like the database: a MANUAL row exists, but it is a
    // tombstone, so only a probe that admits deleted rows finds it.
    vi.mocked(prisma.measurement.findFirst).mockImplementation(((args: {
      where: { source: string; deletedAt?: null };
    }) =>
      Promise.resolve(
        args.where.source === "MANUAL" && !("deletedAt" in args.where)
          ? { id: "m-deleted" }
          : null,
      )) as never);

    expect(await getSourcesInUse("u1")).toEqual([]);
  });

  it("lists a connected integration that has not delivered yet", async () => {
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      userId: "u1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      polarAccessTokenEncrypted: "x",
      ouraAccessTokenEncrypted: null,
      stravaAccessTokenEncrypted: null,
    } as never);

    const inUse = await getSourcesInUse("u1");
    expect(inUse).toContain("WITHINGS");
    expect(inUse).toContain("POLAR");
    expect(inUse).not.toContain("OURA");
  });

  it("lists nothing for an account with no data and no connection", async () => {
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    expect(await getSourcesInUse("u1")).toEqual([]);
  });

  it("probes every rankable source exactly once", async () => {
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    await getSourcesInUse("u1");
    expect(prisma.measurement.findFirst).toHaveBeenCalledTimes(
      RANKABLE_SOURCES.length,
    );
  });
});
