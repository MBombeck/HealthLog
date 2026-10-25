/**
 * The restore drill's kept verdict, against Postgres, read back the way the
 * readiness tile reads it. The unit tests of the drill stub this write; here
 * it is the subject.
 *
 * The rule: a failure stays the verdict until a later drill passes, with no
 * time window, and a run that checked nothing changes no verdict. Mutations
 * that must turn this red: let a pass clear `lastFailureAt`, or let a failure
 * clear `lastSuccessAt` (the next pass would then read as recovered from
 * nothing); record a run that checked nothing as a pass.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { recordRestoreDrillOutcome } from "@/lib/jobs/restore-drill-outcome";
import { evaluateRestoreDrill } from "@/lib/recovery/readiness-model";

const DAY = 86_400_000;
const T0 = new Date("2026-09-01T04:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

async function verdict() {
  const row = await getPrismaClient().restoreDrillOutcome.findUniqueOrThrow({
    where: { id: "singleton" },
  });
  return {
    row,
    signal: evaluateRestoreDrill({
      offhost: { configured: true, databaseLifecycle: null, accounts: [] },
      drill: row,
    }),
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("the restore drill's kept verdict", () => {
  it("keeps a pass and a failure apart, and a failure until a later pass", async () => {
    await recordRestoreDrillOutcome(
      { ok: true, accountsChecked: 3, accountsFailed: 0 },
      at(0),
    );
    expect((await verdict()).signal).toMatchObject({
      state: "ok",
      reason: "passed",
    });

    await recordRestoreDrillOutcome(
      {
        ok: false,
        accountsChecked: 3,
        accountsFailed: 1,
        reason: "backup object 2026-09-30/user-x.json.enc does not decrypt",
      },
      at(30),
    );
    const failed = await verdict();
    expect(failed.row.lastSuccessAt).toEqual(at(0));
    expect(failed.row.lastFailureAt).toEqual(at(30));
    expect(failed.signal).toMatchObject({
      state: "failing",
      reason: "failed",
      detail: expect.stringMatching(/does not decrypt/),
    });

    // A run that stopped before its first object is no verdict: the failure
    // stands, and the tile does not call it passed.
    await recordRestoreDrillOutcome(
      { ok: null, accountsChecked: 0, accountsFailed: 0 },
      at(60),
    );
    const nothing = await verdict();
    expect(nothing.row.lastFailureAt).toEqual(at(30));
    expect(nothing.row.lastSuccessAt).toEqual(at(0));
    expect(nothing.row.lastRunAt).toEqual(at(60));
    expect(nothing.signal.state).toBe("failing");

    await recordRestoreDrillOutcome(
      { ok: true, accountsChecked: 4, accountsFailed: 0 },
      at(90),
    );
    const recovered = await verdict();
    expect(recovered.row.lastFailureAt).toEqual(at(30));
    expect(recovered.row.lastFailureReason).toMatch(/does not decrypt/);
    expect(recovered.signal).toMatchObject({ state: "ok", reason: "passed" });
  });

  it("does not record a run that checked nothing as a pass", async () => {
    await recordRestoreDrillOutcome(
      { ok: null, accountsChecked: 0, accountsFailed: 0 },
      at(0),
    );
    const { row, signal } = await verdict();
    expect(row.lastSuccessAt).toBeNull();
    expect(signal).toMatchObject({
      state: "attention",
      reason: "nothing_checked",
    });
  });
});
