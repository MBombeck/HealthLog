/**
 * The provenance page names the source the charts actually use (#1204).
 *
 * Against a real Postgres: for every day of a two-source account, the source
 * `readDayProvenance` reports as picked is the source the canonical CTE keeps
 * (`canonicalMeasurementsCte`, which the series, rollups and summaries read
 * through), under the default ladder and after the person reorders it. Sleep
 * day values count asleep stages only, and the comparison lines the two
 * sources up per day.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  buildSourceRankCase,
  canonicalMeasurementsCte,
} from "@/lib/analytics/source-rank-sql";
import { instantLiteralSql } from "@/lib/analytics/request-clock-sql";
import {
  readDayProvenance,
  readSourceComparison,
} from "@/lib/provenance/source-provenance";
import type { Prisma } from "@/generated/prisma/client";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const USER = "provenance-user";
const DAY = 86_400_000;
const base = new Date(Date.now() - 10 * DAY);
base.setUTCHours(0, 0, 0, 0);
const dayKey = (n: number) =>
  new Date(base.getTime() + n * DAY).toISOString().slice(0, 10);
const at = (n: number, hour: number) =>
  new Date(base.getTime() + n * DAY + hour * 3_600_000);

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (let d = 0; d < 5; d++) {
    // Oura on every day, WHOOP on days 0, 2, 4.
    rows.push({
      userId: USER,
      type: "SLEEP_DURATION",
      value: 300 + d,
      unit: "min",
      source: "OURA",
      measuredAt: at(d, 3),
      sleepStage: "CORE",
    });
    rows.push({
      userId: USER,
      type: "SLEEP_DURATION",
      value: 90,
      unit: "min",
      source: "OURA",
      measuredAt: at(d, 5),
      sleepStage: "DEEP",
    });
    rows.push({
      userId: USER,
      type: "SLEEP_DURATION",
      value: 30,
      unit: "min",
      source: "OURA",
      measuredAt: at(d, 6),
      sleepStage: "AWAKE",
    });
    if (d % 2 === 0) {
      rows.push({
        userId: USER,
        type: "SLEEP_DURATION",
        value: 420,
        unit: "min",
        source: "WHOOP",
        measuredAt: at(d, 4),
        sleepStage: "ASLEEP",
      });
    }
    rows.push({
      userId: USER,
      type: "ACTIVITY_STEPS",
      value: 8000,
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: at(d, 12),
    });
    rows.push({
      userId: USER,
      type: "ACTIVITY_STEPS",
      value: 7000,
      unit: "steps",
      source: "FITBIT",
      measuredAt: at(d, 12),
    });
  }
  await prisma.measurement.createMany({ data: rows });
});

async function canonicalSource(type: string, date: string, priority: unknown) {
  const rank = buildSourceRankCase(priority, '"type"', '"source"');
  const found = await prisma.$queryRawUnsafe<Array<{ source: string }>>(
    `SELECT DISTINCT m."source"::text AS source FROM (${canonicalMeasurementsCte(rank, { from: instantLiteralSql(new Date()), interval: "30 days" })}) m
     WHERE m."type"::text = $2 AND to_char(date_trunc('day', m."measured_at"), 'YYYY-MM-DD') = $3`,
    USER,
    type,
    date,
  );
  return found.map((r) => r.source);
}

describe("provenance against the canonical pick", () => {
  it.each([
    ["default ladder", null],
    [
      "reordered",
      {
        metricPriority: {
          sleep: ["OURA", "WHOOP"],
          steps: ["FITBIT", "APPLE_HEALTH"],
        },
      },
    ],
  ])("%s", async (_label, priority) => {
    await prisma.user.update({
      where: { id: USER },
      data: { sourcePriorityJson: priority ?? undefined },
    });
    if (priority === null) {
      await prisma.$executeRawUnsafe(
        `UPDATE users SET source_priority_json = NULL WHERE id = $1`,
        USER,
      );
    }
    for (const type of ["SLEEP_DURATION", "ACTIVITY_STEPS"] as const) {
      for (let d = 0; d < 5; d++) {
        const p = await readDayProvenance({
          userId: USER,
          type,
          date: dayKey(d),
        });
        expect(await canonicalSource(type, dayKey(d), priority)).toEqual([
          p.picked,
        ]);
      }
    }
  });

  it("counts asleep stages only and compares per day", async () => {
    const p = await readDayProvenance({
      userId: USER,
      type: "SLEEP_DURATION",
      date: dayKey(1),
    });
    expect(p.sources).toHaveLength(1);
    expect(p.sources[0].value).toBe(301 + 90);
    expect(p.pickReason).toBe("only_source");

    const c = await readSourceComparison({
      userId: USER,
      type: "SLEEP_DURATION",
      from: dayKey(0),
      to: dayKey(4),
      a: "OURA",
      b: "WHOOP",
    });
    expect(c.summary.daysA).toBe(5);
    expect(c.summary.daysB).toBe(3);
    expect(c.summary.daysBoth).toBe(3);
    expect(c.days[1]).toMatchObject({ a: 391, b: null, picked: "OURA" });
  });
});
