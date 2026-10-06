/**
 * A Coach series read over a long window on an account with years of scale
 * data must hand the model numbers.
 *
 * Inside a chat turn every tool read lands on the turn's shared full-source
 * snapshot when its window matches the turn's. On an account with many synced
 * series that snapshot passes the prompt budget, and the budget pass collapses
 * the body-composition blocks first to a bare unit and then to an
 * `{ omitted }` marker. The tool used to slice that marker out and answer
 * `present: true` with it, so the model was told the readings exist and got
 * no figure: "the data are there, but the numbers were not handed to me".
 *
 * The account here holds four years of daily scale readings (every body
 * composition type a scale reports) plus a year of steps and pulse, which is
 * enough for the full-source build to collapse those blocks. The tool must
 * still return the series with its values, and the step the person sees must
 * name what was read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "@/lib/ai/coach/snapshot";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { toStep } from "@/lib/ai/coach/turn/steps";
import { describeStep } from "@/components/insights/coach-panel/turn-activity";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { pluralKey } from "@/lib/i18n/plural";
import type { MeasurementType } from "@/generated/prisma/client";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY = 86_400_000;
const YEARS = 4;

const SCALE: Array<{
  type: MeasurementType;
  unit: string;
  value: (d: number) => number;
}> = [
  { type: "WEIGHT", unit: "kg", value: (d) => 84 - d * 0.002 },
  { type: "BODY_FAT", unit: "%", value: (d) => 24 - d * 0.001 },
  { type: "FAT_MASS", unit: "kg", value: (d) => 20.1 - d * 0.001 },
  { type: "FAT_FREE_MASS", unit: "kg", value: (d) => 63.4 + (d % 5) * 0.1 },
  { type: "MUSCLE_MASS", unit: "kg", value: (d) => 60.2 + (d % 7) * 0.1 },
  { type: "LEAN_BODY_MASS", unit: "kg", value: (d) => 64.1 + (d % 3) * 0.1 },
  { type: "BONE_MASS", unit: "kg", value: (d) => 3.2 + (d % 2) * 0.1 },
  { type: "TOTAL_BODY_WATER", unit: "kg", value: (d) => 46.3 + (d % 4) * 0.1 },
  { type: "BODY_MASS_INDEX", unit: "kg/m2", value: (d) => 26 - d * 0.0005 },
  { type: "VISCERAL_FAT", unit: "", value: (d) => 9 + (d % 3) },
];

let userId = "";

function call(
  name: string,
  args: Record<string, unknown>,
  sharedScope?: {
    sources?: string[];
    window?: string;
  },
) {
  return executeCoachTool({
    userId,
    name,
    rawArguments: JSON.stringify(args),
    fallbackWindow: "allTime",
    sharedScope: sharedScope as never,
    reach: UNBOUNDED_REACH,
  });
}

/** Every finite number anywhere in a payload. */
function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return Number.isFinite(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(numbersIn);
  }
  return [];
}

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "coach-series-long-window",
      email: "coach-series-long-window@example.test",
      timezone: "Europe/Berlin",
      dateOfBirth: new Date("1980-05-01T00:00:00Z"),
      heightCm: 180,
      createdAt: new Date(Date.now() - (YEARS * 365 + 10) * DAY),
    },
  });
  userId = user.id;
  const now = Date.now();
  const rows: Array<{
    userId: string;
    type: MeasurementType;
    value: number;
    unit: string;
    source: "WITHINGS" | "APPLE_HEALTH";
    measuredAt: Date;
    externalId?: string;
  }> = [];
  for (let d = 0; d < YEARS * 365; d++) {
    const at = new Date(now - d * DAY - 6 * 3_600_000);
    for (const s of SCALE) {
      rows.push({
        userId,
        type: s.type,
        value: Math.round(s.value(d) * 10) / 10,
        unit: s.unit,
        source: "WITHINGS",
        measuredAt: at,
      });
    }
  }
  for (let d = 1; d <= 365; d++) {
    rows.push({
      userId,
      type: "ACTIVITY_STEPS",
      value: 6000 + ((d * 977) % 5000),
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date(now - d * DAY),
      externalId: `stats:HKQuantityTypeIdentifierStepCount:${d}`,
    });
    for (const [type, unit, base] of [
      ["PULSE", "bpm", 62],
      ["RESTING_HEART_RATE", "bpm", 54],
      ["HEART_RATE_VARIABILITY", "ms", 41],
      ["ACTIVE_ENERGY_BURNED", "kcal", 480],
      ["WALKING_RUNNING_DISTANCE", "km", 5],
      ["WALKING_SPEED", "km/h", 4.8],
      ["RESPIRATORY_RATE", "breaths/min", 14],
      ["OXYGEN_SATURATION", "%", 96],
    ] as const) {
      rows.push({
        userId,
        type,
        value: base + (d % 5),
        unit,
        source: "APPLE_HEALTH",
        measuredAt: new Date(now - d * DAY - 9 * 3_600_000),
      });
    }
  }
  for (let i = 0; i < rows.length; i += 5_000) {
    await prisma.measurement.createMany({ data: rows.slice(i, i + 5_000) });
  }
  await recomputeUserRollups(userId, {
    from: new Date(now - (YEARS * 365 + 5) * DAY),
    to: new Date(now),
  });
}, 240_000);

afterAll(() => {
  __resetCoachSnapshotCacheForTests();
});

describe("a body-composition series over all time inside a chat turn", () => {
  it("collapses the scale blocks in the shared full-source build (the precondition)", async () => {
    __resetCoachSnapshotCacheForTests();
    const inventory = await buildCoachDataInventory(
      userId,
      { window: "allTime" },
      UNBOUNDED_REACH,
    );
    const shared = await buildCoachSnapshot(userId, inventory.probeScope, {
      reach: UNBOUNDED_REACH,
    });
    // Without this the test below would not exercise the defect at all.
    expect(numbersIn(shared.sections.fatMass)).toEqual([]);
  });

  it.each(["fat_mass", "body_fat", "weight", "muscle_mass"] as const)(
    "%s returns its values, not a bare 'present'",
    async (metric) => {
      __resetCoachSnapshotCacheForTests();
      const inventory = await buildCoachDataInventory(
        userId,
        { window: "allTime" },
        UNBOUNDED_REACH,
      );
      const result = await call(
        "get_metric_series",
        { metric, window: "allTime" },
        inventory.probeScope,
      );
      expect(result.present).toBe(true);
      const data = result.data as { section: Record<string, unknown> };
      expect(data.section).not.toHaveProperty("omitted");
      const timeline = data.section.timeline as
        { recent?: unknown[]; weekly?: unknown[] } | undefined;
      expect(timeline?.recent?.length ?? 0).toBeGreaterThan(0);
      expect(timeline?.weekly?.length ?? 0).toBeGreaterThan(40);
      expect(numbersIn(data.section).length).toBeGreaterThan(100);
      // A long window says what it holds and where the rest is.
      expect((result.data as { coverage?: string }).coverage).toContain(
        "get_metric_table",
      );
    },
  );

  it("labels the step with the domain and the window, separated cleanly", async () => {
    __resetCoachSnapshotCacheForTests();
    const inventory = await buildCoachDataInventory(
      userId,
      { window: "allTime" },
      UNBOUNDED_REACH,
    );
    const args = { metric: "fat_mass", window: "allTime" };
    const result = await call("get_metric_series", args, inventory.probeScope);
    const step = toStep({
      call: {
        id: "c1",
        name: "get_metric_series",
        arguments: JSON.stringify(args),
      },
      index: 0,
      parsedArgs: args,
      result,
      locale: "de",
      fallbackWindow: "allTime",
    });
    expect(step).not.toBeNull();
    expect(step!.status).toBe("done");
    expect(step!.label).toBe("Prüfe: Fettmasse, gesamter Zeitraum");
    const { t } = getServerTranslator("de");
    const tCount = (base: string, count: number) =>
      t(pluralKey(base, count, "de"), { count });
    const { title, meta } = describeStep(step!, t, tCount);
    expect([title, ...meta].join(" · ")).toMatch(
      /^Fettmasse · gesamter Zeitraum · \d+ Messwerte$/,
    );
  });
});
