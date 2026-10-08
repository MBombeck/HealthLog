/**
 * The sources the Settings ladder lists, against real Postgres.
 *
 * A source counts while the account holds a live reading from it. Deleting
 * readings tombstones them (`deletedAt`), so the probe has to skip the
 * tombstones or a source whose readings were all deleted stays marked as in
 * use for good.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seed() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "sources-in-use",
      email: "sources-in-use@example.test",
      role: "USER",
    },
  });
  const reading = (source: "MANUAL" | "APPLE_HEALTH", minutes: number) =>
    prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source,
        measuredAt: new Date(Date.UTC(2026, 4, 12, 7, minutes)),
      },
    });
  return { prisma, user, reading };
}

describe("getSourcesInUse", () => {
  it("lists a source with a live reading", async () => {
    const { user, reading } = await seed();
    await reading("MANUAL", 0);
    const { getSourcesInUse } =
      await import("@/lib/integrations/sources-in-use");
    expect(await getSourcesInUse(user.id)).toEqual(["MANUAL"]);
  });

  it("drops a source once every reading from it is deleted", async () => {
    const { prisma, user, reading } = await seed();
    const manual = await reading("MANUAL", 0);
    await reading("APPLE_HEALTH", 1);
    await prisma.measurement.update({
      where: { id: manual.id },
      data: { deletedAt: new Date() },
    });
    const { getSourcesInUse } =
      await import("@/lib/integrations/sources-in-use");
    expect(await getSourcesInUse(user.id)).toEqual(["APPLE_HEALTH"]);
  });
});
