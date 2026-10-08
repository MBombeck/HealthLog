/**
 * Every MCP tool's real output validates against the output schema
 * `tools/list` advertises, under a strict JSON Schema 2020-12 validator.
 *
 * The advertised output schema closes every object (`additionalProperties:
 * false`, the `io: "output"` rendering). The SDK checks `structuredContent`
 * against the Zod shape on the server, and a Zod object strips a key it does
 * not declare instead of refusing it, so a handler that returns a field its
 * schema never declared passes every server-side check while a strict client
 * refuses the whole result. That is how `list_metrics` shipped
 * `availability` undeclared (#1170).
 *
 * This file closes the class rather than the one field: a real server over
 * an in-memory transport, a real Postgres record with enough in it that the
 * tools return their full shapes (present series, a history the default
 * window cannot reach, labs, a medication, a workout, sleep stages, mood,
 * clinical signals), and every advertised tool called with arguments that
 * reach its main branches. Each `structuredContent` is validated against the
 * schema exactly as it was advertised. A tool the case table does not cover
 * fails the run, so a new tool cannot ship without joining it.
 *
 * v1.42: `get_environment` declares its result field by field, so the
 * strict validator here is also what proves it carries no coordinate and no
 * place name: an undeclared key would fail the run.
 *
 * It also pins the live-rows rule on the two presence probes: a measurement
 * type whose readings were all deleted is not listed as present.
 */
import { beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";

process.env.APP_URL ??= "http://localhost";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "@/lib/mcp/server";
import {
  MCP_CLINICAL_SIGNALS,
  MCP_METRIC_STATUS_DISCOVERY,
} from "@/lib/mcp/rich-reads";
import type { McpAuthContext } from "@/lib/mcp/auth";

import { sealLocation } from "@/lib/environment/location-cipher";
import { getPrismaClient, truncateAllTables } from "./setup";

const DAY = 86_400_000;
const now = Date.now();
const daysAgo = (n: number, hour = 8) => {
  const d = new Date(now - n * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** A discovery metric with live rows, and one with only tombstones. */
const LIVE_STATUS = MCP_METRIC_STATUS_DISCOVERY.find(
  (s) => s.key === "CARDIO_RECOVERY",
)!;
const DELETED_STATUS = MCP_METRIC_STATUS_DISCOVERY.find(
  (s) => s.key === "WRIST_TEMPERATURE",
)!;
const LIVE_SIGNAL = MCP_CLINICAL_SIGNALS.find((s) => s.key === "PAIN_NRS")!;
const DELETED_SIGNAL = MCP_CLINICAL_SIGNALS.find(
  (s) => s.key === "GRIP_STRENGTH",
)!;

let userId = "";

async function seedRecord(): Promise<string> {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "mcp-conformance",
      email: "mcp-conformance@example.test",
      timezone: "UTC",
      createdAt: new Date(now - 800 * DAY),
    },
  });
  const id = user.id;

  type Row = {
    userId: string;
    type: string;
    value: number;
    unit: string;
    measuredAt: Date;
    source?: string;
    sleepStage?: string;
    deletedAt?: Date;
  };
  const rows: Row[] = [];
  const daily = (
    type: string,
    unit: string,
    days: number,
    value: (i: number) => number,
    extra: Partial<Row> = {},
  ) => {
    for (let i = 1; i <= days; i += 1) {
      rows.push({
        userId: id,
        type,
        unit,
        value: value(i),
        measuredAt: daysAgo(i),
        ...extra,
      });
    }
  };
  daily("WEIGHT", "kg", 120, (i) => 80 + (i % 7) * 0.2);
  daily("BODY_FAT", "%", 60, (i) => 22 + (i % 5) * 0.1);
  daily("BLOOD_PRESSURE_SYS", "mmHg", 60, (i) => 118 + (i % 9));
  daily("BLOOD_PRESSURE_DIA", "mmHg", 60, (i) => 76 + (i % 6));
  daily("RESTING_HEART_RATE", "bpm", 60, (i) => 58 + (i % 4));
  daily("HEART_RATE_VARIABILITY", "ms", 60, (i) => 45 + (i % 10));
  daily("ACTIVITY_STEPS", "count", 60, (i) => 6_000 + i * 37);
  daily("BLOOD_GLUCOSE", "mg/dL", 30, (i) => 90 + (i % 20));
  daily(LIVE_STATUS.measurementType, "s", 30, (i) => 25 + (i % 3));
  daily(LIVE_SIGNAL.measurementType, "score", 20, (i) => i % 6);
  // A domain the default window cannot reach: readings 200 days back only.
  for (let i = 0; i < 6; i += 1) {
    rows.push({
      userId: id,
      type: "VO2_MAX",
      unit: "mL/kg/min",
      value: 41 + i * 0.3,
      measuredAt: daysAgo(200 + i),
    });
  }
  // Pulse through yesterday, hourly, so the intraday read has a day.
  for (let i = 1; i <= 14; i += 1) {
    for (let h = 0; h < 24; h += 2) {
      rows.push({
        userId: id,
        type: "PULSE",
        unit: "bpm",
        value: 60 + ((i + h) % 25),
        measuredAt: daysAgo(i, h),
      });
    }
  }
  // Sleep stages per night.
  for (let i = 1; i <= 30; i += 1) {
    for (const [stage, minutes] of [
      ["CORE", 210],
      ["DEEP", 60],
      ["REM", 90],
      ["AWAKE", 15],
    ] as const) {
      rows.push({
        userId: id,
        type: "SLEEP_DURATION",
        unit: "minutes",
        value: minutes,
        measuredAt: daysAgo(i, 6),
        source: "APPLE_HEALTH",
        sleepStage: stage,
      });
    }
  }
  // Tombstones only: these two types must not count as present.
  daily(DELETED_STATUS.measurementType, "°C", 40, () => 0.2, {
    deletedAt: new Date(now - DAY),
  });
  daily(DELETED_SIGNAL.measurementType, "kg", 40, () => 38, {
    deletedAt: new Date(now - DAY),
  });
  await prisma.measurement.createMany({
    data: rows.map((r) => ({ source: "MANUAL", ...r })) as never,
  });

  await prisma.labResult.createMany({
    data: [
      {
        userId: id,
        analyte: "LDL",
        value: 3.1,
        unit: "mmol/L",
        takenAt: daysAgo(40),
      },
      {
        userId: id,
        analyte: "LDL",
        value: 2.8,
        unit: "mmol/L",
        takenAt: daysAgo(10),
      },
      {
        userId: id,
        analyte: "HbA1c",
        value: 5.4,
        unit: "%",
        takenAt: daysAgo(10),
      },
    ],
  });
  const med = await prisma.medication.create({
    data: {
      userId: id,
      name: "Ramipril",
      dose: "5mg",
      active: true,
      createdAt: daysAgo(60),
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  for (let i = 1; i <= 14; i += 1) {
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: id,
        medicationId: med.id,
        scheduledFor: daysAgo(i, 8),
        takenAt: i % 5 === 0 ? null : daysAgo(i, 8),
        skipped: i % 5 === 0,
        source: "REMINDER",
      },
    });
  }
  await prisma.workout.create({
    data: {
      userId: id,
      sportType: "RUNNING",
      startedAt: daysAgo(3, 17),
      endedAt: new Date(daysAgo(3, 17).getTime() + 40 * 60_000),
      durationSec: 2_400,
      source: "MANUAL",
    },
  });
  for (let i = 1; i <= 10; i += 1) {
    await prisma.moodEntry.create({
      data: {
        userId: id,
        date: isoDay(daysAgo(i)),
        mood: "GUT",
        score: 3 + (i % 3),
        moodLoggedAt: daysAgo(i, 20),
      },
    });
  }
  // v1.42 — environment days with weather and air quality, one of them not
  // yet fetched, so get_environment answers its full shape (and a null
  // air-quality part) under the strict validator. The location is sealed.
  for (let i = 2; i <= 12; i += 1) {
    await prisma.environmentContext.create({
      data: {
        userId: id,
        date: isoDay(daysAgo(i)),
        source: i === 5 ? "TRAVEL" : "HOME",
        locationEncrypted: sealLocation({
          lat: 51.5,
          lon: 7.2,
          label: "Somewhere",
        }),
        tempMin: 10 + (i % 4),
        tempMax: 20,
        tempMean: 15,
        apparentMax: 21,
        sunshineSec: 7200,
        ...(i === 3
          ? {}
          : {
              pm25Mean: 8,
              pm25Max: 16,
              o3Max8h: 70,
              eaqiMax: 40,
              uvIndexMax: 3,
              pollenGrassMax: 12,
              pollenBirchMax: null,
              aqDomain: "cams_europe",
              aqHours: 24,
              aqFetchedAt: daysAgo(1),
            }),
      },
    });
  }
  return id;
}

function ctxFor(id: string): McpAuthContext {
  return {
    userId: id,
    tokenId: "token-conformance",
    scopes: ["health:read", "health:write"],
    binding: `${id}:token-conformance`,
    canRead: true,
    canWrite: true,
  };
}

async function connect(id: string) {
  const server = createMcpServer(ctxFor(id));
  const client = new Client({ name: "conformance", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * The arguments each tool is called with: one entry per call, chosen to reach
 * the tool's main branches. `fetch` takes its ids from `search` at run time.
 */
const CASES: Record<string, Array<Record<string, unknown>>> = {
  list_metrics: [{}],
  get_metric_series: [
    { metric: "weight", window: "last90days" },
    { metric: "bp", window: "last30days" },
    { metric: "sleep", window: "last30days" },
    { metric: "vo2_max", window: "last30days" },
  ],
  get_medication_compliance: [{ window: "last30days" }],
  get_labs: [{}, { analyte: "LDL", history: true }, { analyte: "Ferritin" }],
  get_correlations: [{}],
  get_correlation: [{ metricA: "weight", metricB: "resting_hr" }],
  compare_metric: [
    { metric: "weight", window: "last7days", windowB: "last30days" },
    { metric: "weight", metricB: "body_fat", window: "last30days" },
    { metric: LIVE_STATUS.key, window: "last30days" },
  ],
  get_metric_baseline: [{ metric: "resting_hr" }, { metric: LIVE_SIGNAL.key }],
  detect_changepoints: [{ metric: "weight", window: "last90days" }],
  get_glucose_panel: [{ window: "last30days" }],
  get_sleep: [{ window: "last30days" }],
  get_workouts: [{ window: "last30days" }],
  get_illness_recovery: [{}],
  get_cycle: [{}],
  get_environment: [{}, { window: "last7days" }],
  get_metrics: [
    { metrics: ["weight", "bp", "steps"], window: "last30days" },
    { metrics: ["hrv", "vo2_max"] },
  ],
  get_medication_schedule: [{}],
  get_integration_status: [{}],
  get_preventive_care: [{}],
  get_nutrients: [{}, { nutrient: "water", days: 7 }],
  get_intraday_pulse: [{ date: isoDay(daysAgo(1)) }, {}],
  get_ecg_recordings: [{}],
  get_visits: [{}, { months: 12 }],
  search: [
    { query: "blood pressure" },
    { query: "LDL" },
    { query: "pain" },
    { query: "ramipril" },
  ],
  fetch: [],
  log_measurement: [
    { type: "WEIGHT", value: 80.4, unit: "kg", idempotencyKey: "conf-w-1" },
    {
      type: "WEIGHT",
      value: 80.4,
      unit: "kg",
      idempotencyKey: "conf-w-1",
      confirm: true,
    },
  ],
  log_mood: [
    { score: 4, idempotencyKey: "conf-m-1" },
    { score: 4, idempotencyKey: "conf-m-1", confirm: true },
  ],
  log_blood_pressure: [
    { systolic: 121, diastolic: 79, idempotencyKey: "conf-bp-1" },
    {
      systolic: 121,
      diastolic: 79,
      idempotencyKey: "conf-bp-1",
      confirm: true,
    },
  ],
};

beforeAll(async () => {
  userId = await seedRecord();
});

describe("MCP tool outputs against their advertised schemas", () => {
  it("every structuredContent validates under a strict 2020-12 validator", async () => {
    const { client, close } = await connect(userId);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      const uncovered = tools
        .map((t) => t.name)
        .filter((name) => !(name in CASES));
      expect(uncovered, "add every new tool to CASES").toEqual([]);

      const ajv = new Ajv2020({ strict: true, allErrors: true });
      const failures: string[] = [];
      let validated = 0;
      // Tools that answered with data, not only a miss: a run where every
      // read came back empty would validate nothing but the miss shape.
      const presentReads = new Set<string>();
      const fetchIds: string[] = [];

      const check = async (
        name: string,
        schema: Record<string, unknown> | undefined,
        args: Record<string, unknown>,
      ) => {
        const label = `${name}(${JSON.stringify(args)})`;
        let result: Awaited<ReturnType<typeof client.callTool>>;
        try {
          // The SDK client validates against the advertised schema too, with
          // its own validator; its refusal is a failure of the same kind.
          result = await client.callTool({ name, arguments: args });
        } catch (err) {
          failures.push(`${label}: ${(err as Error).message}`);
          return undefined;
        }
        if (result.isError) {
          failures.push(
            `${label}: tool error ${JSON.stringify(result.content)}`,
          );
          return undefined;
        }
        expect(schema, `${name} advertises an output schema`).toBeDefined();
        const structured = result.structuredContent;
        if (!structured) {
          failures.push(`${label}: no structuredContent`);
          return undefined;
        }
        const validate = ajv.compile(schema!);
        if (!validate(structured)) {
          failures.push(
            `${label}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
          );
        }
        validated += 1;
        if ((structured as { present?: unknown }).present === true) {
          presentReads.add(name);
        }
        return structured;
      };

      for (const tool of tools) {
        if (tool.name === "fetch") continue;
        for (const args of CASES[tool.name]) {
          const out = await check(
            tool.name,
            tool.outputSchema as Record<string, unknown> | undefined,
            args,
          );
          if (tool.name === "search" && out) {
            for (const hit of (out as { results: Array<{ id: string }> })
              .results) {
              fetchIds.push(hit.id);
            }
          }
        }
      }

      const fetchTool = tools.find((t) => t.name === "fetch")!;
      const distinct = [...new Set(fetchIds)];
      expect(distinct.length).toBeGreaterThan(3);
      for (const id of distinct) {
        await check(
          "fetch",
          fetchTool.outputSchema as Record<string, unknown>,
          { id },
        );
      }

      expect(failures).toEqual([]);
      expect(validated).toBeGreaterThan(Object.keys(CASES).length);
      expect(presentReads.size).toBeGreaterThanOrEqual(12);
    } finally {
      await close();
    }
  });

  it("get_environment answers with data and no location anywhere", async () => {
    const { client, close } = await connect(userId);
    try {
      const result = await client.callTool({
        name: "get_environment",
        arguments: {},
      });
      const out = result.structuredContent as {
        present: boolean;
        data?: { daily: Array<{ airQuality?: unknown }> };
      };
      expect(out.present).toBe(true);
      expect(out.data!.daily.some((d) => d.airQuality === null)).toBe(true);
      const text = JSON.stringify(out);
      expect(text).not.toMatch(/"(lat|lon|label|locationLabel)"/);
      expect(text).not.toContain("Somewhere");
    } finally {
      await close();
    }
  });

  it("list_metrics carries availability, and it is declared", async () => {
    const { client, close } = await connect(userId);
    try {
      const result = await client.callTool({
        name: "list_metrics",
        arguments: {},
      });
      const metrics = (
        result.structuredContent as {
          metrics: Array<{ present: boolean; availability?: unknown }>;
        }
      ).metrics;
      // The seeded VO2 max history sits outside the default window: the
      // row is absent but says what the record holds. Without it the
      // conformance run above would not have exercised the field.
      expect(metrics.some((m) => !m.present && m.availability)).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("tombstones on the presence probes", () => {
  it("list_metrics lists a live discovery metric and not one whose rows were all deleted", async () => {
    const { client, close } = await connect(userId);
    try {
      const result = await client.callTool({
        name: "list_metrics",
        arguments: {},
      });
      const metrics = (
        result.structuredContent as {
          metrics: Array<{ metric?: string; present: boolean }>;
        }
      ).metrics;
      const byMetric = new Map(metrics.map((m) => [m.metric, m]));
      expect(byMetric.get(LIVE_STATUS.key)?.present).toBe(true);
      expect(byMetric.get(DELETED_STATUS.key)?.present ?? false).toBe(false);
    } finally {
      await close();
    }
  });

  it("search finds a live clinical signal and not one whose rows were all deleted", async () => {
    const { client, close } = await connect(userId);
    try {
      const ids = async (query: string) =>
        (
          (await client.callTool({ name: "search", arguments: { query } }))
            .structuredContent as { results: Array<{ id: string }> }
        ).results.map((r) => r.id);
      expect(await ids("pain")).toContain(`metric:${LIVE_SIGNAL.key}`);
      expect(await ids("grip strength")).not.toContain(
        `metric:${DELETED_SIGNAL.key}`,
      );
      expect(await ids("wrist temperature")).not.toContain(
        `metric:${DELETED_STATUS.key}`,
      );
    } finally {
      await close();
    }
  });
});
