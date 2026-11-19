/**
 * The Apple Health deletion ledger in a restore: each section owns its own
 * domain's lines. The workouts section clears and writes the `workout` lines
 * only, the ECG section the `ecg` lines, so neither section's restore wipes
 * what guards the other's rows.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearWorkouts,
  restoreAppleHealthTombstones,
  restoreWorkouts,
} from "@/lib/export/workouts-backup";
import type { RestoreContext } from "@/lib/export/restore-context";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "ah-ledger-restore";
const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, email: `${USER}@example.test` },
  });
});

async function lines() {
  const rows = await prisma.appleHealthTombstone.findMany({
    where: { userId: USER },
    orderBy: [{ domain: "asc" }, { externalId: "asc" }],
    select: { domain: true, externalId: true },
  });
  return rows.map((r) => `${r.domain}:${r.externalId}`);
}

const fileLedger = [
  {
    domain: "workout" as const,
    externalId: "WK-file",
    createdAt: "2026-11-01T08:00:00.000Z",
  },
  {
    domain: "ecg" as const,
    externalId: "ECG-file",
    createdAt: "2026-11-01T08:00:00.000Z",
  },
];

describe("the deletion ledger in a restore", () => {
  it("keeps each section to its own domain's lines", async () => {
    for (const [domain, externalId] of [
      ["workout", "WK-old"],
      ["ecg", "ECG-old"],
    ]) {
      await prisma.appleHealthTombstone.create({
        data: { userId: USER, domain, externalId },
      });
    }

    await prisma.$transaction(async (tx) => {
      const ctx = {
        tx,
        ownerId: USER,
        cleared: {},
        payload: { appleHealthTombstones: fileLedger, workouts: [] },
      } as unknown as RestoreContext;
      await clearWorkouts(ctx);
      await restoreWorkouts(ctx);
    });
    // The workouts section replaced the workout lines and left the ECG one.
    expect(await lines()).toEqual(["ecg:ECG-old", "workout:WK-file"]);

    await prisma.$transaction((tx) =>
      restoreAppleHealthTombstones(tx, USER, fileLedger, "ecg"),
    );
    expect(await lines()).toEqual(["ecg:ECG-file", "workout:WK-file"]);
  });
});
