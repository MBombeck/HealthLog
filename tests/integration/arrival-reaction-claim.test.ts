/**
 * The `ArrivalReaction` claim, against real Postgres.
 *
 * Unit mocks cannot prove any of this: the once-per-kind-per-day contract is a
 * unique INDEX, the claim is an ON CONFLICT DO NOTHING whose semantics live in
 * the database, and the losing side of a concurrent claim is a race only a real
 * connection pool can produce. A mocked `createMany` returning `{count: 1}`
 * would happily report a successful claim for every caller.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function createUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
}

const LOCAL_DATE = "2026-07-14";

function marker(userId: string, kind: string, occurredAt: Date) {
  return {
    userId,
    kind,
    localDate: LOCAL_DATE,
    occurredAt,
    refId: null,
  };
}

describe("ArrivalReaction — the day claim", () => {
  it("admits the first claim and refuses the second for the same kind and day", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-claim");

    const first = await prisma.arrivalReaction.createMany({
      data: [marker(user.id, "weight", new Date("2026-07-14T06:00:00Z"))],
      skipDuplicates: true,
    });
    const second = await prisma.arrivalReaction.createMany({
      data: [marker(user.id, "weight", new Date("2026-07-14T18:00:00Z"))],
      skipDuplicates: true,
    });

    expect(first.count).toBe(1);
    // The second weigh-in of the day does not get its own line. This IS the
    // throttle — there is no code path to a second generation.
    expect(second.count).toBe(0);
    expect(await prisma.arrivalReaction.count()).toBe(1);
  });

  it("keeps kinds independent within one day", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-kinds");
    const at = new Date("2026-07-14T06:00:00Z");

    for (const kind of ["weight", "sleep_night", "blood_pressure"]) {
      const res = await prisma.arrivalReaction.createMany({
        data: [marker(user.id, kind, at)],
        skipDuplicates: true,
      });
      expect(res.count).toBe(1);
    }
    expect(await prisma.arrivalReaction.count()).toBe(3);
  });

  it("keeps users independent — one user's claim never blocks another's", async () => {
    const prisma = getPrismaClient();
    const a = await createUser("arrival-tenant-a");
    const b = await createUser("arrival-tenant-b");
    const at = new Date("2026-07-14T06:00:00Z");

    const first = await prisma.arrivalReaction.createMany({
      data: [marker(a.id, "weight", at)],
      skipDuplicates: true,
    });
    const second = await prisma.arrivalReaction.createMany({
      data: [marker(b.id, "weight", at)],
      skipDuplicates: true,
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(1);
  });

  it("exactly one of many concurrent claims wins", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-race");
    const at = new Date("2026-07-14T06:00:00Z");

    // Ten seams firing at once, the shape a device batch storm takes.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        prisma.arrivalReaction.createMany({
          data: [marker(user.id, "workout", at)],
          skipDuplicates: true,
        }),
      ),
    );

    const winners = results.filter((r) => r.count === 1);
    expect(winners).toHaveLength(1);
    expect(await prisma.arrivalReaction.count()).toBe(1);
  });

  it("the marker moves forward on a later arrival and never backwards", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-forward");
    const early = new Date("2026-07-14T06:00:00Z");
    const late = new Date("2026-07-14T18:00:00Z");

    await prisma.arrivalReaction.createMany({
      data: [marker(user.id, "weight", early)],
      skipDuplicates: true,
    });

    const forward = await prisma.arrivalReaction.updateMany({
      where: {
        userId: user.id,
        kind: "weight",
        localDate: LOCAL_DATE,
        occurredAt: { lt: late },
      },
      data: { occurredAt: late },
    });
    expect(forward.count).toBe(1);

    const backward = await prisma.arrivalReaction.updateMany({
      where: {
        userId: user.id,
        kind: "weight",
        localDate: LOCAL_DATE,
        occurredAt: { lt: early },
      },
      data: { occurredAt: early },
    });
    expect(backward.count).toBe(0);

    const row = await prisma.arrivalReaction.findFirst({
      where: { userId: user.id },
    });
    expect(row?.occurredAt.toISOString()).toBe(late.toISOString());
  });

  it("replaces a generated marker and rejects the stale generation owner", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-replacement");
    const early = new Date("2026-07-14T06:00:00Z");
    const late = new Date("2026-07-14T18:00:00Z");
    const providerInvokedAt = new Date("2026-07-14T06:01:00Z");
    const existing = await prisma.arrivalReaction.create({
      data: {
        ...marker(user.id, "weight", early),
        refId: "old-ref",
        lineEncrypted: Buffer.from("old-ciphertext"),
        generatedAt: new Date("2026-07-14T06:02:00Z"),
        generationClaimId: "old-claim",
        generationClaimedAt: providerInvokedAt,
        generationReservedTokens: 220,
        generationBudgetDateKey: "2026-07-14",
        generationProviderInvokedAt: providerInvokedAt,
      },
    });
    await prisma.coachUsage.create({
      data: {
        userId: user.id,
        dateKey: "2026-07-14",
        totalTokens: 220,
        messageCount: 1,
      },
    });

    const { runDataArrival } = await import("@/lib/jobs/data-arrival");
    const outcome = await runDataArrival(prisma as never, {
      userId: user.id,
      kind: "weight",
      salience: "salient",
      localDate: LOCAL_DATE,
      occurredAt: late.toISOString(),
      count: 1,
      source: "withings",
      refId: "new-ref",
    });

    expect(outcome).toMatchObject({ status: "processed", dedup: false });
    const replaced = await prisma.arrivalReaction.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(replaced).toMatchObject({
      occurredAt: late,
      refId: "new-ref",
      lineEncrypted: null,
      generatedAt: null,
      generationClaimId: null,
      generationClaimedAt: null,
      generationReservedTokens: null,
      generationBudgetDateKey: null,
      generationProviderInvokedAt: null,
    });

    const staleCommit = await prisma.arrivalReaction.updateMany({
      where: {
        id: existing.id,
        generationClaimId: "old-claim",
        generationProviderInvokedAt: providerInvokedAt,
      },
      data: {
        lineEncrypted: Buffer.from("stale-ciphertext"),
        generatedAt: new Date(),
      },
    });
    expect(staleCommit.count).toBe(0);

    const usage = await prisma.coachUsage.findUniqueOrThrow({
      where: {
        userId_dateKey: { userId: user.id, dateKey: "2026-07-14" },
      },
    });
    expect(usage).toMatchObject({ totalTokens: 220, messageCount: 1 });
  });

  it("refunds a superseded pre-provider reservation", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-reservation-refund");
    const early = new Date("2026-07-14T06:00:00Z");
    const late = new Date("2026-07-14T18:00:00Z");
    await prisma.arrivalReaction.create({
      data: {
        ...marker(user.id, "weight", early),
        generationClaimId: "pre-provider-claim",
        generationClaimedAt: new Date("2026-07-14T06:01:00Z"),
        generationReservedTokens: 220,
        generationBudgetDateKey: "2026-07-14",
      },
    });
    await prisma.coachUsage.create({
      data: {
        userId: user.id,
        dateKey: "2026-07-14",
        totalTokens: 500,
        messageCount: 2,
      },
    });

    const { runDataArrival } = await import("@/lib/jobs/data-arrival");
    await runDataArrival(prisma as never, {
      userId: user.id,
      kind: "weight",
      salience: "salient",
      localDate: LOCAL_DATE,
      occurredAt: late.toISOString(),
      count: 1,
      source: "withings",
    });

    const usage = await prisma.coachUsage.findUniqueOrThrow({
      where: {
        userId_dateKey: { userId: user.id, dateKey: "2026-07-14" },
      },
    });
    expect(usage).toMatchObject({ totalTokens: 280, messageCount: 1 });
  });

  it("stores the line as encrypted bytes, and tolerates its absence", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-crypto");
    const { encryptToBytes, decryptFromBytes } =
      await import("@/lib/ai/coach/bytes-codec");

    await prisma.arrivalReaction.createMany({
      data: [marker(user.id, "weight", new Date("2026-07-14T06:00:00Z"))],
      skipDuplicates: true,
    });

    // A provider-less install leaves the column null — the marker is the
    // feature, the sentence is garnish.
    const before = await prisma.arrivalReaction.findFirst({
      where: { userId: user.id },
    });
    expect(before?.lineEncrypted).toBeNull();
    expect(before?.generatedAt).toBeNull();

    const line = "Last night is in — a steady base for the day.";
    await prisma.arrivalReaction.update({
      where: { id: before!.id },
      data: { lineEncrypted: encryptToBytes(line), generatedAt: new Date() },
    });

    const after = await prisma.arrivalReaction.findFirst({
      where: { userId: user.id },
    });
    expect(after?.lineEncrypted).not.toBeNull();
    // Ciphertext at rest — the plaintext must not be readable off the column.
    expect(Buffer.from(after!.lineEncrypted!).toString("utf8")).not.toContain(
      "steady base",
    );
    expect(decryptFromBytes(after!.lineEncrypted!)).toBe(line);
  });

  it("cascades on user delete, leaving no orphan markers", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-cascade");
    await prisma.arrivalReaction.createMany({
      data: [marker(user.id, "weight", new Date("2026-07-14T06:00:00Z"))],
      skipDuplicates: true,
    });

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.arrivalReaction.count()).toBe(0);
  });

  it("the retention window deletes only rows past it", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("arrival-retention");
    const now = new Date();
    const old = new Date(now.getTime() - 20 * 86_400_000);
    const recent = new Date(now.getTime() - 3 * 86_400_000);

    await prisma.arrivalReaction.create({
      data: {
        ...marker(user.id, "weight", now),
        localDate: "2026-06-24",
        createdAt: old,
      },
    });
    await prisma.arrivalReaction.create({
      data: {
        ...marker(user.id, "sleep_night", now),
        localDate: "2026-07-11",
        createdAt: recent,
      },
    });

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 14);
    const deleted = await prisma.arrivalReaction.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    expect(deleted.count).toBe(1);
    const survivor = await prisma.arrivalReaction.findFirst();
    expect(survivor?.kind).toBe("sleep_night");
  });
});
