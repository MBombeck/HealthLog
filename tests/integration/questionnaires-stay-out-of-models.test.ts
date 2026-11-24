/**
 * The mental-wellbeing page says the questionnaire answers and scores never
 * reach the Coach, another AI feature or a connected AI assistant. This file
 * holds every model-bound read to that sentence against a real record.
 *
 * The record holds one administration of each instrument (PHQ-9 with the
 * self-harm item answered, GAD-7, WHO-5, SCI), each with the total it files
 * as a `*_SCORE` reading, on a day that also holds a weight and a mood entry.
 * Then every MCP read tool is called (a tool the case table does not cover
 * fails the run), every resource and template is read, every Coach tool is
 * executed, the Coach snapshot is built over every source, and the AI
 * general-status prompt is assembled. None of them may name an instrument,
 * a score type, a severity band or the questionnaire section.
 *
 * The person's own day view is read first and must show the administrations:
 * without that the absence below would prove nothing.
 */
import { beforeAll, describe, expect, it } from "vitest";

process.env.APP_URL ??= "http://localhost";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "@/lib/mcp/server";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { COACH_TOOL_NAMES } from "@/lib/ai/coach/tools/definitions";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { COACH_SCOPE_SOURCES } from "@/lib/ai/coach/scope-sources";
import { prepareGeneralStatusForUser } from "@/lib/insights/general-status";
import { loadDay } from "@/lib/day/load-day";
import { resolveDayAccess } from "@/lib/day/sections";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  INSTRUMENT_MEASUREMENT_TYPE,
  severityBand,
  type InstrumentId,
} from "@/lib/mental-health/instruments";

import { getPrismaClient, truncateAllTables } from "./setup";

const DAY = 86_400_000;
const now = Date.now();
const daysAgo = (n: number, hour = 9) => {
  const d = new Date(now - n * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const SCREENED_DAY = isoDay(daysAgo(3));

/** What would give a questionnaire away in a model-bound payload. */
const MARKERS =
  /PHQ9|PHQ-9|GAD7|GAD-7|WHO5|WHO-5|SCI_SCORE|modSevere|item9|"assessments"|"kind":"assessment"/;

const TOTALS: Record<InstrumentId, number> = {
  PHQ9: 17,
  GAD7: 12,
  WHO5: 36,
  SCI: 11,
};

let userId = "";

async function seedRecord(): Promise<string> {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "questionnaire-egress",
      email: "questionnaire-egress@example.test",
      timezone: "UTC",
      createdAt: new Date(now - 400 * DAY),
      modulePreferencesJson: { mentalHealth: true, timeline: true },
    },
  });
  const id = user.id;

  const rows: Array<{
    userId: string;
    type: string;
    value: number;
    unit: string;
    measuredAt: Date;
    source: string;
  }> = [];
  for (let i = 1; i <= 60; i += 1) {
    rows.push({
      userId: id,
      type: "WEIGHT",
      unit: "kg",
      value: 80 + (i % 5) * 0.2,
      measuredAt: daysAgo(i, 7),
      source: "MANUAL",
    });
  }
  for (let i = 1; i <= 14; i += 1) {
    await prisma.moodEntry.create({
      data: {
        userId: id,
        date: isoDay(daysAgo(i)),
        mood: "GUT",
        score: 3 + (i % 2),
        moodLoggedAt: daysAgo(i, 20),
      },
    });
  }

  // Each instrument a few times, so a trend, a baseline and a day all have
  // something to show; the newest administration sits on SCREENED_DAY.
  for (const instrument of Object.keys(TOTALS) as InstrumentId[]) {
    for (const back of [3, 17, 31, 45]) {
      const takenAt = daysAgo(back, 10);
      const total = TOTALS[instrument] - (back === 3 ? 0 : 1);
      const assessment = await prisma.mentalHealthAssessment.create({
        data: {
          userId: id,
          instrument,
          locale: "en",
          responsesEncrypted: encryptToBytes(
            JSON.stringify({ items: null, schema: 1 }),
          ),
          totalScore: total,
          severityBand: severityBand(instrument, total),
          item9Flagged: instrument === "PHQ9",
          takenAt,
          tz: "UTC",
          source: "WEB",
        },
      });
      rows.push({
        userId: id,
        type: INSTRUMENT_MEASUREMENT_TYPE[instrument],
        unit: "score",
        value: total,
        measuredAt: takenAt,
        source: "COMPUTED",
      });
      void assessment;
    }
  }
  await prisma.measurement.createMany({ data: rows as never });
  return id;
}

/** The bodies of a resource read, without the address that was asked for. */
function bodies(read: { contents: Array<Record<string, unknown>> }) {
  return read.contents.map((c) => c.text ?? c.blob ?? null);
}

function ctxFor(id: string): McpAuthContext {
  return {
    userId: id,
    tokenId: "token-questionnaire-egress",
    scopes: ["health:read"],
    binding: `${id}:token-questionnaire-egress`,
    canRead: true,
    canWrite: false,
  };
}

async function connect(id: string) {
  const server = createMcpServer(ctxFor(id));
  const client = new Client({ name: "egress-guard", version: "1.0.0" });
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

/** Screener names a client could ask for by hand. */
const SCREENER_NAMES = [
  "PHQ9_SCORE",
  "phq9_score",
  "GAD7_SCORE",
  "WHO5_SCORE",
  "who-5",
  "SCI_SCORE",
  "PHQ-9 depression screen (total)",
];

/** Every MCP read tool, called with arguments that reach its main branches. */
const MCP_CASES: Record<string, Array<Record<string, unknown>>> = {
  list_metrics: [{}],
  get_metric_series: [
    { metric: "weight", window: "last90days" },
    { metric: "mood", window: "last90days" },
    ...SCREENER_NAMES.map((metric) => ({ metric, window: "last90days" })),
  ],
  get_metrics: [
    { metrics: ["weight", "mood"], window: "last90days" },
    { metrics: SCREENER_NAMES.slice(0, 4), window: "last90days" },
  ],
  compare_metric: [
    { metric: "weight", window: "last7days", windowB: "last30days" },
    ...SCREENER_NAMES.map((metric) => ({ metric, window: "last90days" })),
  ],
  get_metric_baseline: [
    { metric: "weight" },
    ...SCREENER_NAMES.map((metric) => ({ metric })),
  ],
  detect_changepoints: [
    { metric: "weight", window: "last90days" },
    ...SCREENER_NAMES.map((metric) => ({ metric, window: "last90days" })),
  ],
  get_correlations: [{}],
  get_correlation: [
    { metricA: "weight", metricB: "mood" },
    { metricA: "PHQ9_SCORE", metricB: "weight" },
  ],
  get_day: [{ date: SCREENED_DAY }, { date: isoDay(daysAgo(17)) }],
  get_medication_compliance: [{ window: "last30days" }],
  get_medication_schedule: [{}],
  get_labs: [{}],
  get_glucose_panel: [{ window: "last30days" }],
  get_sleep: [{ window: "last30days" }],
  get_workouts: [{ window: "last30days" }],
  get_illness_recovery: [{}],
  get_cycle: [{}],
  get_environment: [{}],
  get_integration_status: [{}],
  get_preventive_care: [{}],
  get_nutrients: [{}],
  get_seizures: [{}],
  get_intraday_pulse: [{}],
  get_ecg_recordings: [{}],
  get_visits: [{}],
  search: [
    { query: "PHQ-9" },
    { query: "depression" },
    { query: "questionnaire" },
    { query: "mental wellbeing" },
  ],
  fetch: [],
};

beforeAll(async () => {
  userId = await seedRecord();
});

describe("questionnaires stay out of every model-bound read", () => {
  it("the person's own day view shows the administrations", async () => {
    const access = await resolveDayAccess({
      recordId: userId,
      domainVisible: () => true,
      owner: true,
    });
    const day = await loadDay({
      recordId: userId,
      day: SCREENED_DAY,
      access,
      tz: "UTC",
    });
    const text = JSON.stringify(day);
    expect(text).toContain('"assessments"');
    expect(text).toMatch(/PHQ9/);
    expect(text).toContain("modSevere");
  });

  it("no MCP tool, resource or template hands one over", async () => {
    const { client, close } = await connect(userId);
    const leaks: string[] = [];
    const seen = (label: string, payload: unknown) => {
      const text = JSON.stringify(payload);
      const hit = text.match(MARKERS);
      if (hit) leaks.push(`${label}: ${hit[0]}`);
    };
    try {
      const { tools } = await client.listTools();
      const uncovered = tools
        .map((t) => t.name)
        .filter((name) => !(name in MCP_CASES));
      expect(uncovered, "add every new read tool to MCP_CASES").toEqual([]);

      const fetchIds: string[] = [];
      let dayValues = 0;
      for (const tool of tools) {
        for (const args of MCP_CASES[tool.name]) {
          const result = await client.callTool({
            name: tool.name,
            arguments: args,
          });
          // A refused call answers with the arguments it refused (a screener
          // name the client itself sent), never with record data.
          if (result.isError) continue;
          seen(`${tool.name}(${JSON.stringify(args)})`, result);
          const out = result.structuredContent as
            | {
                results?: Array<{ id: string }>;
                present?: boolean;
                data?: { values?: unknown[] };
              }
            | undefined;
          if (tool.name === "search") {
            for (const hit of out?.results ?? []) fetchIds.push(hit.id);
          }
          if (tool.name === "get_day" && args.date === SCREENED_DAY) {
            expect(out?.present).toBe(true);
            dayValues = out?.data?.values?.length ?? 0;
          }
        }
      }
      // The screened day still answers with its other readings.
      expect(dayValues).toBeGreaterThan(0);
      for (const id of new Set(fetchIds)) {
        seen(
          `fetch(${id})`,
          await client.callTool({ name: "fetch", arguments: { id } }),
        );
      }

      const { resources } = await client.listResources();
      seen("resources/list", resources);
      for (const resource of resources) {
        seen(
          `read ${resource.uri}`,
          bodies(await client.readResource({ uri: resource.uri })),
        );
      }
      const { resourceTemplates } = await client.listResourceTemplates();
      for (const name of SCREENER_NAMES) {
        const encoded = encodeURIComponent(name);
        for (const uri of [
          `healthlog://metric/${encoded}`,
          `healthlog://metric/${encoded}/last90days`,
        ]) {
          // The answer repeats the address the client asked for; the body is
          // what the record gave.
          seen(`read ${uri}`, bodies(await client.readResource({ uri })));
        }
      }
      for (const template of resourceTemplates) {
        const variable = template.uriTemplate.match(/\{(\w+)\}/)?.[1];
        if (!variable) continue;
        for (const value of ["PHQ", "phq9", "WHO", "SCI", "GAD"]) {
          try {
            seen(
              `complete ${template.uriTemplate}`,
              await client.complete({
                ref: { type: "ref/resource", uri: template.uriTemplate },
                argument: { name: variable, value },
              }),
            );
          } catch {
            // A template without completion for this variable: nothing left.
          }
        }
      }
    } finally {
      await close();
    }
    expect(leaks).toEqual([]);
  });

  it("no Coach tool, snapshot or AI status prompt hands one over", async () => {
    const leaks: string[] = [];
    const seen = (label: string, payload: unknown) => {
      const text = JSON.stringify(payload);
      const hit = text.match(MARKERS);
      if (hit) leaks.push(`${label}: ${hit[0]}`);
    };
    const coachCases: Record<string, Array<Record<string, unknown>>> = {
      get_metric_series: [
        { metric: "weight", window: "last90days" },
        { metric: "mood", window: "last90days" },
      ],
      get_metric_table: [{ metric: "mood", window: "last90days" }],
      get_day: [{ date: SCREENED_DAY }, { date: isoDay(daysAgo(17)) }],
    };
    for (const name of COACH_TOOL_NAMES) {
      for (const args of coachCases[name] ?? [{}]) {
        seen(
          `coach ${name}(${JSON.stringify(args)})`,
          await executeCoachTool({
            userId,
            name,
            rawArguments: JSON.stringify(args),
          }),
        );
      }
    }
    const day = await executeCoachTool({
      userId,
      name: "get_day",
      rawArguments: JSON.stringify({ date: SCREENED_DAY }),
    });
    expect(day.present).toBe(true);

    const snapshot = await buildCoachSnapshot(userId, {
      sources: [...COACH_SCOPE_SOURCES],
      window: "last90days",
    });
    seen("coach snapshot", snapshot);

    const prepared = await prepareGeneralStatusForUser(userId, {
      locale: "en",
      force: true,
    });
    if (prepared.phase === "pending") {
      // The prompt carries the weight series, so the read did run.
      expect(prepared.userPrompt).toMatch(/WEIGHT/);
      seen("general status prompt", {
        system: prepared.systemPrompt,
        user: prepared.userPrompt,
      });
    }
    expect(leaks).toEqual([]);
  });
});
