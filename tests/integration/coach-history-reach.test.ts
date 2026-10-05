/**
 * The Coach lookback limit against real Postgres.
 *
 * The guard in `coach-history-reach-guard.test.ts` mocks every reader and
 * proves the executor hands the limit on. This file proves the readers obey
 * it: real builders, real SQL, an account with blood pressure from 200 days
 * ago and from the last fortnight, weight and a lab panel only from 200 days
 * ago, and a limit of 90 days saved in the account's Coach preferences.
 *
 * The old readings carry values that never occur in the recent ones (a
 * systolic of 187, a weight of 93.7 kg, an LDL of 211), so any leak shows up
 * as that number in what the Coach is given. The same calls with no limit
 * ("All", the default) still return them, which pins that the default kept
 * its behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import {
  buildCoachDataInventory,
  renderDataInventory,
} from "@/lib/ai/coach/tools/inventory";
import { __resetCoachSnapshotCacheForTests } from "@/lib/ai/coach/snapshot";
import { readCoachReach } from "@/lib/ai/coach/history-reach-read";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { assembleTurnContext } from "@/lib/ai/coach/turn/context";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY = 86_400_000;
const OLD_SYS = 187;
const OLD_WEIGHT = 93.7;
const OLD_LDL = 211;

let seq = 0;

async function seedAccount(defaultWindow: string | null) {
  seq += 1;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `history-reach-${seq}`,
      email: `history-reach-${seq}@example.test`,
      role: "USER",
      timezone: "UTC",
      createdAt: new Date(Date.now() - 400 * DAY),
      ...(defaultWindow ? { coachPrefsJson: { defaultWindow } } : {}),
    },
  });
  const now = Date.now();
  const bp = (daysAgo: number, sys: number, dia: number) => [
    {
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS" as const,
      value: sys,
      unit: "mmHg",
      measuredAt: new Date(now - daysAgo * DAY),
    },
    {
      userId: user.id,
      type: "BLOOD_PRESSURE_DIA" as const,
      value: dia,
      unit: "mmHg",
      measuredAt: new Date(now - daysAgo * DAY),
    },
  ];
  await prisma.measurement.createMany({
    data: [
      ...bp(200, OLD_SYS, 109),
      ...bp(201, OLD_SYS, 109),
      ...bp(202, OLD_SYS, 109),
      ...bp(10, 121, 79),
      ...bp(11, 122, 78),
      ...bp(12, 123, 77),
      ...bp(13, 124, 76),
      ...[200, 201, 202].map((daysAgo) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: OLD_WEIGHT,
        unit: "kg",
        measuredAt: new Date(now - daysAgo * DAY),
      })),
    ],
  });
  await prisma.labResult.create({
    data: {
      userId: user.id,
      analyte: "LDL",
      value: OLD_LDL,
      unit: "mg/dL",
      takenAt: new Date(now - 200 * DAY),
    },
  });
  return user;
}

function call(
  userId: string,
  name: string,
  args: Record<string, unknown>,
  reach: Awaited<ReturnType<typeof readCoachReach>>,
) {
  return executeCoachTool({
    userId,
    name,
    rawArguments: JSON.stringify(args),
    fallbackWindow: "allTime",
    reach,
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  __resetCoachSnapshotCacheForTests();
});
afterEach(() => {
  __resetCoachSnapshotCacheForTests();
});

describe("a 90-day lookback limit", () => {
  it("reads the saved limit from the account's Coach preferences", async () => {
    const user = await seedAccount("last90days");
    expect(await readCoachReach(user.id)).toEqual({
      window: "last90days",
      days: 90,
    });
  });

  it("serves only the recent readings when the model asks for all time", async () => {
    const user = await seedAccount("last90days");
    const reach = await readCoachReach(user.id);
    const result = await call(
      user.id,
      "get_metric_series",
      { metric: "bp", window: "allTime" },
      reach,
    );
    expect(result.present).toBe(true);
    const payload = JSON.stringify(result.data);
    expect(payload).toContain("121");
    expect(payload).not.toContain(String(OLD_SYS));
  });

  it("names a history entirely beyond the limit without any figure from it", async () => {
    const user = await seedAccount("last90days");
    const reach = await readCoachReach(user.id);
    const result = await call(
      user.id,
      "get_metric_series",
      { metric: "weight", window: "allTime" },
      reach,
    );
    expect(result).toMatchObject({ present: false, reason: "outside_reach" });
    expect(result.available).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(String(OLD_WEIGHT));
  });

  it("refuses a year-ago table and an earlier lab panel", async () => {
    const user = await seedAccount("last90days");
    const reach = await readCoachReach(user.id);
    const table = await call(
      user.id,
      "get_metric_table",
      { metric: "bp", window: "last30days", period: "yearAgo" },
      reach,
    );
    expect(table).toMatchObject({ present: false, reason: "outside_reach" });

    const labs = await call(user.id, "get_labs", {}, reach);
    expect(labs).toMatchObject({ present: false, reason: "outside_reach" });
    expect(JSON.stringify(labs)).not.toContain(String(OLD_LDL));
  });

  it("marks the old domains beyond the lookback in the inventory, with no figures", async () => {
    const user = await seedAccount("last90days");
    const reach = await readCoachReach(user.id);
    const inventory = await buildCoachDataInventory(
      user.id,
      { window: "allTime" },
      reach,
    );
    expect(inventory.window).toBe("last90days");
    expect(inventory.lookbackLimit).toBe("last90days");
    const weight = inventory.entries.find((e) => e.metric === "weight");
    expect(weight?.availability).toEqual({
      state: "outside_reach",
      reachableWithWindow: null,
    });
    const text = renderDataInventory(inventory);
    expect(text).toContain("BEYOND LOOKBACK");
    expect(text).not.toContain(String(OLD_WEIGHT));
    expect(text).not.toContain(String(OLD_SYS));
  });

  it("caps a wider window the client sends with the turn", async () => {
    const user = await seedAccount("last90days");
    const ctx = await assembleTurnContext({
      userId: user.id,
      locale: "en",
      message: "How was my blood pressure?",
      scope: { window: "allTime" },
      guidedQuestion: undefined,
      workoutId: undefined,
      conversation: {
        conversationId: "history-reach-conversation",
        priorTurns: [],
        priorSummary: null,
      } as never,
    });
    expect(ctx.reach.days).toBe(90);
    expect(ctx.effectiveScope?.window).toBe("last90days");
    expect(ctx.snapshot.snapshotJson).not.toContain(String(OLD_SYS));
    expect(ctx.snapshot.snapshotJson).not.toContain(String(OLD_WEIGHT));
    expect(ctx.snapshot.snapshotJson).not.toContain(String(OLD_LDL));
  });
});

describe("no limit (the default)", () => {
  it("still reads the whole history", async () => {
    const user = await seedAccount(null);
    const reach = await readCoachReach(user.id);
    expect(reach).toEqual(UNBOUNDED_REACH);

    const bp = await call(
      user.id,
      "get_metric_series",
      { metric: "bp", window: "allTime" },
      reach,
    );
    expect(bp.present).toBe(true);
    expect(JSON.stringify(bp.data)).toContain(String(OLD_SYS));

    const labs = await call(user.id, "get_labs", {}, reach);
    expect(labs.present).toBe(true);
    expect(JSON.stringify(labs.data)).toContain(String(OLD_LDL));

    const table = await call(
      user.id,
      "get_metric_table",
      { metric: "bp", window: "last30days", period: "yearAgo" },
      reach,
    );
    expect(table.reason).not.toBe("outside_reach");
  });
});
