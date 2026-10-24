/**
 * #1217 — what the usage levels do to a watch-synced account, simulated
 * deterministically through the real invalidator.
 *
 * One day of a phone that delivers a watch's samples every 15 minutes from
 * 07:00 to 23:00, the morning sleep and recovery figures, two hand-entered
 * blood-pressure readings and a hand-entered weight. Every scope the
 * invalidator enqueues counts as one generation, the worst case the issue
 * describes: today's partial bucket moves on every sync, so the content-hash
 * gate never short-circuits a sync-driven run. The 04:30 nightly warm
 * regenerates every scope once on every level and is counted apart.
 *
 * The clock, the cache rows and the queue are in memory; the scope mapping,
 * the per-source gap and the level resolution are the production code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({
  notes: new Map<string, number>(),
  generations: 0,
  level: null as string | null,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        locale: "en",
        aiUsageLevel: sim.level,
      })),
    },
    appSettings: {
      findUnique: vi.fn(async () => ({
        aiUsageMaxLevel: "FULL",
        aiUsageDefaultLevel: "STANDARD",
        aiSyncRegenGapHours: null,
      })),
    },
    insightStatusCache: {
      findMany: vi.fn(
        async (args: {
          where: {
            OR: Array<{ metric: string; locale: string }>;
            generatedAt?: { gte: Date };
          };
        }) => {
          // The second probe asks for open negative windows; every
          // generation in this simulation succeeds, so there are none.
          const since = args.where.generatedAt?.gte;
          if (!since) return [];
          return args.where.OR.filter(
            (key) =>
              (sim.notes.get(key.metric) ?? -Infinity) >= since.getTime(),
          ).map((key) => ({ metric: key.metric, locale: key.locale }));
        },
      ),
    },
  },
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: vi.fn(async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  })),
}));
vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: vi.fn(async (job: { metric: string }) => {
    sim.generations += 1;
    sim.notes.set(job.metric, Date.now());
  }),
}));
vi.mock("@/lib/measurements/live-types", () => ({
  listLiveMeasurementTypes: vi.fn(async () => []),
}));

import { invalidateStatusInsightsForTypes } from "../status-invalidation";
import type { MeasurementType } from "@/generated/prisma/client";

type Event = {
  at: string;
  source: "sync" | "manual";
  types: MeasurementType[];
};

/** One day of a watch account, minute-exact and the same on every run. */
function day(): Event[] {
  const events: Event[] = [];
  for (let minutes = 7 * 60; minutes <= 23 * 60; minutes += 15) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    const types: MeasurementType[] = [
      "ACTIVITY_STEPS",
      "ACTIVE_ENERGY_BURNED",
      "WALKING_RUNNING_DISTANCE",
      "PULSE",
      "FLIGHTS_CLIMBED",
    ];
    if (minutes % 60 === 0)
      types.push("TIME_IN_DAYLIGHT", "AUDIO_EXPOSURE_ENV");
    if (minutes % 120 === 0) {
      types.push("HEART_RATE_VARIABILITY", "WALKING_HEART_RATE_AVERAGE");
    }
    if (minutes === 7 * 60) {
      types.push(
        "SLEEP_DURATION",
        "RESTING_HEART_RATE",
        "RESPIRATORY_RATE",
        "OXYGEN_SATURATION",
        "WRIST_TEMPERATURE",
        "VO2_MAX",
      );
    }
    events.push({ at: `${hh}:${mm}`, source: "sync", types });
  }
  events.push(
    { at: "07:30", source: "manual", types: ["WEIGHT"] },
    {
      at: "08:00",
      source: "manual",
      types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    },
    {
      at: "20:00",
      source: "manual",
      types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    },
  );
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

const ALL_SCOPES_AT_WARM = new Set<string>();

async function simulate(level: string | null): Promise<{
  warm: number;
  ingest: number;
  bySource: Record<"sync" | "manual", number>;
}> {
  sim.notes.clear();
  sim.generations = 0;
  sim.level = level;
  // The 04:30 warm regenerates every scope the day will touch.
  const warmAt = Date.parse("2026-10-15T04:30:00Z");
  for (const scope of ALL_SCOPES_AT_WARM) sim.notes.set(scope, warmAt);
  const warm = ALL_SCOPES_AT_WARM.size;
  const bySource = { sync: 0, manual: 0 };
  for (const event of day()) {
    vi.setSystemTime(new Date(`2026-10-15T${event.at}:00Z`));
    const before = sim.generations;
    await invalidateStatusInsightsForTypes("u1", event.types, {
      source: event.source,
    });
    bySource[event.source] += sim.generations - before;
  }
  return { warm, ingest: sim.generations, bySource };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

describe("generations per day on a watch-synced account", () => {
  it("counts the scopes once to seed the warm", async () => {
    // Discover every scope the day dirties: run it once on `full` with no
    // warm, which enqueues each scope at least once.
    ALL_SCOPES_AT_WARM.clear();
    sim.notes.clear();
    sim.level = "FULL";
    for (const event of day()) {
      vi.setSystemTime(new Date(`2026-10-15T${event.at}:00Z`));
      await invalidateStatusInsightsForTypes("u1", event.types, {
        source: event.source,
      });
    }
    for (const scope of sim.notes.keys()) ALL_SCOPES_AT_WARM.add(scope);
    expect(ALL_SCOPES_AT_WARM.size).toBe(19);
  });

  it("before v1.43 (every ingest at one hour) versus each level", async () => {
    const full = await simulate("FULL"); // the behaviour before v1.43
    const standard = await simulate("STANDARD");
    const frugal = await simulate("FRUGAL");
    const result = { full, standard, frugal };
    process.stdout.write(`SIMULATION ${JSON.stringify(result)}\n`);

    // Ingest-driven generations a day (the warm adds 19 on every level).
    expect(full).toEqual({
      warm: 19,
      ingest: 122,
      bySource: { sync: 118, manual: 4 },
    });
    expect(standard).toEqual({
      warm: 19,
      ingest: 25,
      bySource: { sync: 20, manual: 5 },
    });
    expect(frugal).toEqual({
      warm: 19,
      ingest: 2,
      bySource: { sync: 0, manual: 2 },
    });
    // The contract's aim: standard well below a quarter of the old ingest
    // volume, and below a third with the warm counted.
    expect(standard.ingest / full.ingest).toBeLessThan(0.25);
    expect(
      (standard.warm + standard.ingest) / (full.warm + full.ingest),
    ).toBeLessThan(0.32);
    // Hand entries are narrated within the hour on standard, as before; on
    // full the sync drip had often refreshed the same scope just before.
    expect(standard.bySource.manual).toBeGreaterThanOrEqual(
      full.bySource.manual,
    );
  });
});
