/**
 * Output parity for the per-card status generators.
 *
 * Every status card (the specialised cards, the generic HealthKit-metric
 * card, the biomarker card, the general overview, and the batched warm pass)
 * is driven against a real Postgres with fixed fixtures and a frozen clock,
 * through its public entry point. The model is the only stub: it records the
 * exact request it is sent and answers with a fixed completion. For each card
 * and each arm (a fresh generation, a cache hit, an unchanged-data run, the
 * next day, the read-only paths, no provider, no data, a screened reply and a
 * failing model) the file records
 *
 *   - every request the model received, prompts included,
 *   - the result the entry point returned,
 *   - the stored notes, decrypted, with their fingerprints and windows,
 *   - every out-of-band generation the read-only path queued,
 *
 * and compares the lot, byte for byte, with the golden files under
 * `__golden__/status-parity/`. A refactor of the generators must leave every
 * one of them unchanged; a deliberate change to what a card sends or answers
 * rewrites them with `STATUS_PARITY_WRITE=1` in the same commit, so the diff
 * shows exactly what moved.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { getPrismaClient, truncateAllTables } from "./setup";

interface ModelReply {
  content: string;
  model: string;
  tokensUsed: number;
}

const model = vi.hoisted(() => ({
  calls: [] as unknown[],
  reply: async (_params: unknown): Promise<ModelReply> => {
    throw new Error("no reply configured");
  },
}));

const queue = vi.hoisted(() => ({ enqueued: [] as unknown[] }));

/**
 * The negative-cache window a fallback opens is written without being awaited
 * (the render must not wait on it). The writer is passed through unchanged;
 * the test only keeps hold of the write so an arm can settle it before the
 * stored notes are read.
 */
const pendingWrites = vi.hoisted(() => new Set<Promise<unknown>>());

vi.mock("@/lib/ai/provider", async (importOriginal) => ({
  // The presence probe the capability reads stays real; only the chain the
  // generation walks is replaced by the recording stand-in.
  ...(await importOriginal<typeof import("@/lib/ai/provider")>()),
  resolveProviderChain: async () => [
    {
      providerType: "anthropic",
      instance: {
        type: "anthropic",
        generateCompletion: async (params: unknown) => {
          model.calls.push(params);
          return model.reply(params);
        },
      },
    },
  ],
  resolveProvider: async () => ({ type: "none" }),
}));

vi.mock(
  "@/lib/jobs/insight-status-generate-shared",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/jobs/insight-status-generate-shared")
    >()),
    enqueueStatusGeneration: async (args: unknown) => {
      queue.enqueued.push(args);
    },
  }),
);

vi.mock("@/lib/insights/status-negative-window", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/insights/status-negative-window")
    >();
  return {
    ...actual,
    writeStatusNegativeWindow: (
      args: Parameters<typeof actual.writeStatusNegativeWindow>[0],
    ) => {
      const write = actual.writeStatusNegativeWindow(args);
      pendingWrites.add(write);
      return write;
    },
  };
});

const GOLDEN_DIR = resolve(__dirname, "__golden__/status-parity");
const WRITE = process.env.STATUS_PARITY_WRITE === "1";
const NOW = new Date("2026-06-15T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOW = 180_000;

const RICH = "parity-rich";
const BARE = "parity-bare";
const KEYLESS = "parity-keyless";
const BIOMARKER = "parity-ldl";
const EMPTY_BIOMARKER = "parity-empty-marker";

// ── The model stand-in ───────────────────────────────────────────────────────

function answer(content: string): void {
  model.reply = async () => ({
    content,
    model: "parity-model",
    tokensUsed: 42,
  });
}

function answerSummary(text: string): void {
  answer(JSON.stringify({ summary: text }));
}

function fail(): void {
  model.reply = async () => {
    throw new Error("provider unavailable");
  };
}

/** One recorded request, with long prompt strings split into lines. */
function readable(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("\n") ? value.split("\n") : value;
  }
  if (Array.isArray(value)) return value.map(readable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, readable(entry)]),
    );
  }
  return value;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function daysAgo(days: number, hour = 7): Date {
  const at = new Date(NOW.getTime() - days * DAY_MS);
  at.setUTCHours(hour, 15, 0, 0);
  return at;
}

async function makeAccount(
  id: string,
  options: { withProvider: boolean; profile: "rich" | "plain" | "none" },
) {
  const prisma = getPrismaClient();
  const profile =
    options.profile === "rich"
      ? {
          heightCm: 178,
          dateOfBirth: new Date("1984-03-09T00:00:00.000Z"),
          gender: "MALE",
          unitPreference: "imperial",
          glucoseUnit: "mmol/L",
        }
      : options.profile === "plain"
        ? {
            heightCm: 165,
            dateOfBirth: new Date("1991-11-20T00:00:00.000Z"),
            gender: "FEMALE",
          }
        : {};
  return prisma.user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      onboardingCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...(options.withProvider
        ? {
            aiProviderChain: [{ providerType: "anthropic", enabled: true }],
            // Presence only: the capability probe never decrypts.
            aiAnthropicKeyEncrypted: "key-present",
          }
        : {}),
      ...profile,
    },
  });
}

async function seedMeasurements(userId: string): Promise<void> {
  const prisma = getPrismaClient();
  const rows: Array<{
    userId: string;
    type:
      | "WEIGHT"
      | "BLOOD_PRESSURE_SYS"
      | "BLOOD_PRESSURE_DIA"
      | "PULSE"
      | "RESTING_HEART_RATE"
      | "BLOOD_GLUCOSE"
      | "SLEEP_DURATION";
    value: number;
    unit: string;
    source: "MANUAL" | "APPLE_HEALTH";
    measuredAt: Date;
    sleepStage?: "ASLEEP";
  }> = [];
  for (let day = 0; day < 140; day++) {
    const wave = Math.sin(day / 5);
    if (day % 2 === 0) {
      rows.push({
        userId,
        type: "WEIGHT",
        value: 84.2 - day * 0.015 + wave * 0.4,
        unit: "kg",
        source: "MANUAL",
        measuredAt: daysAgo(day, 6),
      });
    }
    if (day % 3 !== 2) {
      rows.push(
        {
          userId,
          type: "BLOOD_PRESSURE_SYS",
          value: Math.round(128 + wave * 6 - (day % 7)),
          unit: "mmHg",
          source: "MANUAL",
          measuredAt: daysAgo(day, 8),
        },
        {
          userId,
          type: "BLOOD_PRESSURE_DIA",
          value: Math.round(82 + wave * 4 - (day % 5)),
          unit: "mmHg",
          source: "MANUAL",
          measuredAt: daysAgo(day, 8),
        },
      );
    }
    for (const hour of [8, 13, 19]) {
      rows.push({
        userId,
        type: "PULSE",
        value: Math.round(66 + wave * 5 + (hour === 19 ? 12 : 0)),
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(day, hour),
      });
    }
    rows.push({
      userId,
      type: "RESTING_HEART_RATE",
      value: Math.round(58 + wave * 3 + (day % 4)),
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: daysAgo(day, 5),
    });
    if (day % 4 === 0) {
      rows.push({
        userId,
        type: "BLOOD_GLUCOSE",
        value: Math.round(96 + wave * 9 + (day % 6)),
        unit: "mg/dL",
        source: "MANUAL",
        measuredAt: daysAgo(day, 7),
      });
    }
    if (day > 0 && day < 90) {
      rows.push({
        userId,
        type: "SLEEP_DURATION",
        value: Math.round(410 + wave * 35),
        unit: "min",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(day, 5),
        sleepStage: "ASLEEP",
      });
    }
  }
  await prisma.measurement.createMany({ data: rows });
}

async function seedMood(userId: string): Promise<void> {
  const prisma = getPrismaClient();
  const binary = await prisma.moodTag.findFirst({
    where: { kind: "BINARY", userId: null },
    orderBy: { key: "asc" },
  });
  const rated = await prisma.moodTag.findFirst({
    where: { kind: "RATED", userId: null },
    orderBy: { key: "asc" },
  });
  const labels = ["LAUSIG", "SCHLECHT", "OKAY", "GUT", "SUPER_GUT"];
  for (let day = 0; day < 70; day++) {
    const score = 1 + ((day * 7 + Math.floor(day / 3)) % 5);
    const at = daysAgo(day, day % 2 === 0 ? 20 : 9);
    const links = [
      ...(binary && day % 3 === 0 ? [{ moodTagId: binary.id }] : []),
      ...(rated && day % 2 === 0
        ? [{ moodTagId: rated.id, rating: 1 + (day % 5) }]
        : []),
    ];
    await prisma.moodEntry.create({
      data: {
        id: `${userId}-mood-${day}`,
        userId,
        date: at.toISOString().slice(0, 10),
        mood: labels[score - 1],
        score,
        tags:
          day % 4 === 0
            ? JSON.stringify(["work"])
            : day % 5 === 0
              ? JSON.stringify(["sport"])
              : null,
        tz: "Europe/Berlin",
        moodLoggedAt: at,
        ...(links.length > 0 ? { tagLinks: { create: links } } : {}),
      },
    });
  }
}

async function seedMedications(userId: string): Promise<void> {
  const prisma = getPrismaClient();
  const createdAt = daysAgo(120, 9);
  const medications = [
    { id: `${userId}-med-bp`, name: "Ramipril", dose: "5mg", bp: true },
    { id: `${userId}-med-d`, name: "Vitamin D", dose: "1000 IE", bp: false },
  ];
  for (const medication of medications) {
    await prisma.medication.create({
      data: {
        id: medication.id,
        userId,
        name: medication.name,
        dose: medication.dose,
        createdAt,
        schedules: {
          create: [
            {
              id: `${medication.id}-schedule`,
              windowStart: "08:00",
              windowEnd: "10:00",
            },
          ],
        },
      },
    });
    if (medication.bp) {
      await prisma.medicationCategoryAssignment.create({
        data: { medicationId: medication.id, category: "BLOOD_PRESSURE" },
      });
    }
    const events = [];
    for (let day = 1; day < 100; day++) {
      if (day % 9 === 4) continue;
      const scheduledFor = daysAgo(day, 8);
      events.push({
        id: `${medication.id}-intake-${day}`,
        userId,
        medicationId: medication.id,
        scheduledFor,
        skipped: day % 11 === 3,
        takenAt:
          day % 11 === 3
            ? null
            : new Date(scheduledFor.getTime() + 20 * 60_000),
        createdAt: scheduledFor,
      });
    }
    await prisma.medicationIntakeEvent.createMany({ data: events });
  }
}

async function seedBiomarkers(userId: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.biomarker.create({
    data: {
      id: `${userId}-${BIOMARKER}`,
      userId,
      name: "LDL Cholesterol",
      unit: "mg/dL",
      lowerBound: 0,
      upperBound: 116,
      createdAt: daysAgo(400),
    },
  });
  await prisma.biomarker.create({
    data: {
      id: `${userId}-${EMPTY_BIOMARKER}`,
      userId,
      name: "Ferritin",
      unit: "ng/mL",
      lowerBound: 30,
      upperBound: 400,
      createdAt: daysAgo(400),
    },
  });
  const readings = [
    { day: 360, value: 142 },
    { day: 250, value: 131 },
    { day: 130, value: 118 },
    { day: 20, value: 104, source: { low: 0, high: 130, text: "< 130" } },
  ];
  for (const [index, reading] of readings.entries()) {
    await prisma.labResult.create({
      data: {
        id: `${userId}-lab-${index}`,
        userId,
        biomarkerId: `${userId}-${BIOMARKER}`,
        analyte: "LDL",
        value: reading.value,
        unit: "mg/dL",
        referenceLow: 0,
        referenceHigh: 116,
        takenAt: daysAgo(reading.day, 9),
        ...(reading.source
          ? {
              sourceReferenceLow: reading.source.low,
              sourceReferenceHigh: reading.source.high,
              sourceReferenceText: reading.source.text,
            }
          : {}),
      },
    });
  }
}

async function seedWorld(): Promise<void> {
  await makeAccount(RICH, { withProvider: true, profile: "rich" });
  await makeAccount(BARE, { withProvider: true, profile: "none" });
  await makeAccount(KEYLESS, { withProvider: false, profile: "plain" });
  for (const userId of [RICH, KEYLESS]) {
    await seedMeasurements(userId);
    await seedMood(userId);
    await seedMedications(userId);
    await seedBiomarkers(userId);
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

async function storedNotes(): Promise<unknown[]> {
  const rows = await getPrismaClient().insightStatusCache.findMany({
    orderBy: [{ userId: "asc" }, { metric: "asc" }, { locale: "asc" }],
  });
  return rows.map((row) => ({
    userId: row.userId,
    metric: row.metric,
    locale: row.locale,
    text: row.textEncrypted ? decryptFromBytes(row.textEncrypted) : null,
    items: row.itemsEncrypted
      ? (JSON.parse(decryptFromBytes(row.itemsEncrypted)) as unknown)
      : null,
    inputHash: row.inputHash,
    snapshotHash: row.snapshotHash,
    dateKey: row.dateKey,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    retryAt: row.retryAt?.toISOString() ?? null,
    negativeReason: row.negativeReason,
  }));
}

interface Arm {
  /** Days after the frozen start the arm runs at. */
  day?: number;
  setup?: () => void;
  run: () => Promise<unknown>;
}

async function record(arms: Record<string, Arm>): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const [name, arm] of Object.entries(arms)) {
    vi.setSystemTime(new Date(NOW.getTime() + (arm.day ?? 0) * DAY_MS));
    model.calls = [];
    queue.enqueued = [];
    answerSummary(`Parity note for ${name}.`);
    arm.setup?.();
    const result = await arm.run();
    await settleBackgroundTasks();
    await Promise.allSettled([...pendingWrites]);
    pendingWrites.clear();
    out[name] = {
      // The batch runs its cards concurrently, so the order the requests
      // arrive in is not part of the contract; their content is.
      calls: readable(
        [...model.calls].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      ),
      enqueued: queue.enqueued,
      result,
      notes: await storedNotes(),
    };
  }
  return `${JSON.stringify(sortedKeys(out), null, 2)}\n`;
}

/**
 * A copy with every object's keys in sorted order, so a golden's text does
 * not depend on the order code happened to assign fields in and compresses
 * and diffs well. Arrays keep their order: that is content.
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          sortedKeys((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function compareGolden(name: string, actual: string): void {
  const path = resolve(GOLDEN_DIR, `${name}.json`);
  if (WRITE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

// ── The cards ────────────────────────────────────────────────────────────────

type Options = { locale?: string | null; force?: boolean; readOnly?: boolean };
type Entry = (userId: string, options?: Options) => Promise<unknown>;

/**
 * The arms every standard card runs, in order. Each arm sees the notes the
 * arms before it stored, which is what makes the cache, unchanged-data and
 * next-day arms meaningful.
 */
function standardArms(entry: Entry): Record<string, Arm> {
  return {
    "read-only-cold": {
      run: () => entry(RICH, { locale: "en", readOnly: true }),
    },
    "fresh-en": { run: () => entry(RICH, { locale: "en" }) },
    "cached-en": { run: () => entry(RICH, { locale: "en" }) },
    "forced-unchanged-en": {
      run: () => entry(RICH, { locale: "en", force: true }),
    },
    "next-day-en": { day: 1, run: () => entry(RICH, { locale: "en" }) },
    "read-only-stale": {
      day: 3,
      run: () => entry(RICH, { locale: "en", readOnly: true }),
    },
    "prose-de": {
      setup: () => answer("Das ist kein JSON."),
      run: () => entry(RICH, { locale: "de" }),
    },
    "unparseable-fr": {
      setup: () => answer('{"summary": "Votre'),
      run: () => entry(RICH, { locale: "fr" }),
    },
    "blocked-es": {
      setup: () =>
        answerSummary("Aumente su dosis a 2,4 mg la próxima semana."),
      run: () => entry(RICH, { locale: "es" }),
    },
    "bare-error-en": {
      setup: fail,
      run: () => entry(BARE, { locale: "en" }),
    },
    "bare-error-de": {
      setup: fail,
      run: () => entry(BARE, { locale: "de", force: true }),
    },
    "keyless-en": { run: () => entry(KEYLESS, { locale: "en" }) },
    "keyless-de": { run: () => entry(KEYLESS, { locale: "de" }) },
    "keyless-read-only": {
      run: () => entry(KEYLESS, { locale: "en", readOnly: true }),
    },
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await seedWorld();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("status generator output parity", () => {
  it(
    "pulse",
    async () => {
      const { generatePulseStatusForUser } =
        await import("@/lib/insights/pulse-status");
      compareGolden(
        "pulse",
        await record(standardArms(generatePulseStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "weight",
    async () => {
      const { generateWeightStatusForUser } =
        await import("@/lib/insights/weight-status");
      compareGolden(
        "weight",
        await record(standardArms(generateWeightStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "blood-pressure",
    async () => {
      const { generateBloodPressureStatusForUser } =
        await import("@/lib/insights/blood-pressure-status");
      compareGolden(
        "blood-pressure",
        await record(standardArms(generateBloodPressureStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "mood",
    async () => {
      const { generateMoodStatusForUser } =
        await import("@/lib/insights/mood-status");
      compareGolden(
        "mood",
        await record(standardArms(generateMoodStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "bmi",
    async () => {
      const { generateBmiStatusForUser } =
        await import("@/lib/insights/bmi-status");
      compareGolden(
        "bmi",
        await record(standardArms(generateBmiStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "medication-compliance",
    async () => {
      const { generateMedicationComplianceStatusForUser } =
        await import("@/lib/insights/medication-compliance-status");
      compareGolden(
        "medication-compliance",
        await record(standardArms(generateMedicationComplianceStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "general",
    async () => {
      const { generateGeneralStatusForUser } =
        await import("@/lib/insights/general-status");
      compareGolden(
        "general",
        await record(standardArms(generateGeneralStatusForUser)),
      );
    },
    SLOW,
  );

  it(
    "metric",
    async () => {
      const { generateMetricStatus } =
        await import("@/lib/insights/metric-status");
      const arms: Record<string, Arm> = {};
      for (const metric of [
        "RESTING_HEART_RATE",
        "BLOOD_GLUCOSE",
        "SLEEP_DURATION",
      ] as const) {
        const entry: Entry = (userId, options) =>
          generateMetricStatus({ metric, userId, ...options });
        for (const [name, arm] of Object.entries(standardArms(entry))) {
          arms[`${metric} ${name}`] = arm;
        }
      }
      arms["VO2_MAX no-data"] = {
        run: () =>
          generateMetricStatus({
            metric: "VO2_MAX",
            userId: RICH,
            locale: "en",
          }),
      };
      compareGolden("metric", await record(arms));
    },
    SLOW,
  );

  it(
    "biomarker",
    async () => {
      const { generateBiomarkerStatus } =
        await import("@/lib/insights/biomarker-status");
      const arms: Record<string, Arm> = {};
      const entry: Entry = (userId, options) =>
        generateBiomarkerStatus({
          biomarkerId: `${userId}-${BIOMARKER}`,
          userId,
          ...options,
        });
      for (const [name, arm] of Object.entries(standardArms(entry))) {
        arms[name] = arm;
      }
      arms["no-readings"] = {
        run: () =>
          generateBiomarkerStatus({
            biomarkerId: `${RICH}-${EMPTY_BIOMARKER}`,
            userId: RICH,
            locale: "en",
          }),
      };
      arms["foreign-marker"] = {
        run: () =>
          generateBiomarkerStatus({
            biomarkerId: `${KEYLESS}-${BIOMARKER}`,
            userId: RICH,
            locale: "en",
          }),
      };
      compareGolden("biomarker", await record(arms));
    },
    SLOW,
  );

  it(
    "batch",
    async () => {
      const { generateStatusBatchForUser } =
        await import("@/lib/insights/status-batch");
      const { STATUS_BATCH_KEY_BY_METRIC } =
        await import("@/lib/ai/prompts/status-batch");
      const perMetric = Object.fromEntries(
        Object.values(STATUS_BATCH_KEY_BY_METRIC)
          .filter((key) => key !== "mood")
          .map((key) => [key, `Batched parity note for ${key}.`]),
      );
      compareGolden(
        "batch",
        await record({
          "batch-en": {
            setup: () => answer(JSON.stringify({ perMetric })),
            run: () =>
              generateStatusBatchForUser(RICH, { locale: "en", force: true }),
          },
          "batch-unchanged-en": {
            run: () =>
              generateStatusBatchForUser(RICH, { locale: "en", force: true }),
          },
          "batch-failed-de": {
            setup: fail,
            run: () =>
              generateStatusBatchForUser(RICH, { locale: "de", force: true }),
          },
        }),
      );
    },
    SLOW,
  );
});
