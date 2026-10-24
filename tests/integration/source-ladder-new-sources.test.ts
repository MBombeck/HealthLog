/**
 * The sources that had no place on a ladder, against real Postgres through
 * the SQL collapse every 90-day aggregate reads (`canonicalMeasurementsFrom`).
 *
 * A source a ladder does not name ranks 90, below everything it does name:
 * a weight typed as a reply to a Telegram reminder lost its day to a WHOOP
 * strap's estimate, and a Health Connect day lost to a hand-typed one. The
 * hand-entered sources now rank with MANUAL, Health Connect with Apple
 * Health, and a day between two sources that were on the ladder before
 * resolves exactly as it did.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import {
  buildSourceRankCase,
  canonicalMeasurementsFrom,
} from "@/lib/analytics/source-rank-sql";
import { boundInstantSql } from "@/lib/analytics/request-clock-sql";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const USER = "ladder-new-sources";
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;

/** One reading per (type, source) on day `n` days back, at 08:00 / 09:00 UTC. */
function reading(
  type: MeasurementType,
  source: MeasurementSource,
  n: number,
  value: number,
  hour = 8,
) {
  return {
    userId: USER,
    type,
    source,
    value,
    unit: type === "WEIGHT" ? "kg" : "count",
    measuredAt: new Date(today - n * DAY + hour * 3_600_000),
  };
}

async function canonicalSources(): Promise<Map<string, string[]>> {
  const rank = buildSourceRankCase(null, '"type"', '"source"');
  const rows = await prisma.$queryRawUnsafe<
    Array<{ type: string; day: Date; source: string }>
  >(
    `SELECT DISTINCT m."type"::text AS type,
            date_trunc('day', m."measured_at") AS day,
            m."source"::text AS source
     FROM ${canonicalMeasurementsFrom(rank, { from: boundInstantSql(2), interval: "90 days" })}
     ORDER BY 1, 2, 3`,
    USER,
    new Date(),
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.type}@${r.day.toISOString().slice(0, 10)}`;
    out.set(key, [...(out.get(key) ?? []), r.source]);
  }
  return out;
}

const dayKey = (n: number) =>
  new Date(today - n * DAY).toISOString().slice(0, 10);

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  await prisma.measurement.createMany({
    data: [
      // Day 1: a strap's weight estimate and a typed reply to a reminder.
      reading("WEIGHT", "WHOOP", 1, 84),
      reading("WEIGHT", "TELEGRAM", 1, 82.5, 9),
      // Day 2: an assistant logging on the person's word beside a Fitbit
      // scale-less estimate.
      reading("WEIGHT", "FITBIT", 2, 85),
      reading("WEIGHT", "MCP", 2, 82.4, 9),
      // Day 3: a hand-typed weight and the person's own bridged scale.
      reading("WEIGHT", "MANUAL", 3, 82.3),
      reading("WEIGHT", "EXTERNAL", 3, 82.6, 9),
      // Day 4: two sources the ladder always named: unchanged.
      reading("WEIGHT", "APPLE_HEALTH", 4, 82.2),
      reading("WEIGHT", "WITHINGS", 4, 82.1, 9),
      // Day 1: Health Connect's daily steps beside a hand-typed count.
      reading("ACTIVITY_STEPS", "HEALTH_CONNECT", 1, 9000),
      reading("ACTIVITY_STEPS", "MANUAL", 1, 5000, 9),
      // Day 2: Apple Health still outranks Health Connect.
      reading("ACTIVITY_STEPS", "APPLE_HEALTH", 2, 9100),
      reading("ACTIVITY_STEPS", "HEALTH_CONNECT", 2, 8900, 9),
    ],
  });
}, 120_000);

describe("source ladders for the sources that had no place", () => {
  it("ranks a reading the person entered through Telegram or MCP above a device estimate", async () => {
    const picked = await canonicalSources();
    expect(picked.get(`WEIGHT@${dayKey(1)}`)).toEqual(["TELEGRAM"]);
    expect(picked.get(`WEIGHT@${dayKey(2)}`)).toEqual(["MCP"]);
  });

  it("keeps MANUAL above the person's own bridge", async () => {
    const picked = await canonicalSources();
    expect(picked.get(`WEIGHT@${dayKey(3)}`)).toEqual(["MANUAL"]);
  });

  it("ranks Health Connect right after Apple Health", async () => {
    const picked = await canonicalSources();
    expect(picked.get(`ACTIVITY_STEPS@${dayKey(1)}`)).toEqual([
      "HEALTH_CONNECT",
    ]);
    expect(picked.get(`ACTIVITY_STEPS@${dayKey(2)}`)).toEqual(["APPLE_HEALTH"]);
  });

  it("resolves a day between two long-ranked sources exactly as before", async () => {
    const picked = await canonicalSources();
    expect(picked.get(`WEIGHT@${dayKey(4)}`)).toEqual(["WITHINGS"]);
  });
});
