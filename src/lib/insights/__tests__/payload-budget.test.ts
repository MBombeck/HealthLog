import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Wave 1D — payload-budget verification. A dense daily weigher (2 years
 * of daily WEIGHT + BP, plus a many-type Apple-Health account for
 * general-status) used to embed the full ~360-day daily array per
 * metric, running ~20-100 K tokens. After the graded-series rewrite the
 * snapshot the prompt carries must sit well under the ~24 000-char
 * (~6 000-token) cap.
 *
 * The snapshot JSON is the `{ … }` block embedded in the user prompt;
 * `runStatusCompletion` is stubbed to capture it.
 */

// The graded series folds per-day aggregates in SQL; the fake folds the
// mocked `measurement.findMany` rows with the same rules.
// The input gate's stamp read answers from the mocked grouped count.
vi.mock("@/lib/insights/measurement-input-stamps", async () => ({
  readMeasurementInputStamps: (await import("./fake-input-stamps"))
    .stampsFromMockedGroupBy,
}));

vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    insightStatusCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    // v1.18.11 — the slow-mover input gate probes salient inputs.
    measurement: { findMany: vi.fn(), groupBy: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // Weekly / monthly / yearly buckets are folded from the DAY tier in SQL.
    $queryRaw: vi.fn(),
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn(), aggregate: vi.fn() },
    customMetric: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock(
  "@/lib/ai/coach/bytes-codec",
  async () => (await import("./status-note-fixtures")).fakeBytesCodec,
);

// statusText is available in these fixtures — the capability read has its
// own tests in status-cache.test.ts.
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  aiCapabilityToServe: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generateWeightStatusForUser } from "../weight-status";
import { generateGeneralStatusForUser } from "../general-status";

const dayMs = 24 * 60 * 60 * 1000;
const BUDGET_CHARS = 24_000;

let capturedPrompt: string | null = null;

function stubCapture() {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { userPrompt: string }) => {
      capturedPrompt = args.userPrompt;
      return {
        kind: "ok",
        content: '{"summary":"OK"}',
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

function snapshotChars(): number {
  const match = capturedPrompt!.match(/\{[\s\S]*\}/);
  return match![0].length;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.insightStatusCache.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.insightStatusCache.updateMany).mockResolvedValue(
    {} as never,
  );
  capturedPrompt = null;
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // v1.18.11 — input-gate probe: empty groups + zero mood so the gate
  // misses (no cached inputHash) and every fixture builds normally.
  vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.moodEntry.aggregate).mockResolvedValue({
    _count: { _all: 0 },
    _max: { moodLoggedAt: null },
  } as never);
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: null,
    gender: null,
    heightCm: 175,
  } as never);
  stubCapture();
});

describe("status snapshot payload budget", () => {
  it("weight-status: a 2-year daily weigher + daily BP stays under the char cap", async () => {
    const now = new Date();
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 730; day++) {
      const measuredAt = new Date(now.getTime() - day * dayMs);
      rows.push({ type: "WEIGHT", value: 80 + (day % 5), measuredAt });
      rows.push({
        type: "BLOOD_PRESSURE_SYS",
        value: 120 + (day % 10),
        measuredAt,
      });
      rows.push({
        type: "BLOOD_PRESSURE_DIA",
        value: 80 + (day % 5),
        measuredAt,
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    await generateWeightStatusForUser("user-1", { locale: "en" });

    const chars = snapshotChars();
    // Pre-rewrite this ran ~80-110 KB for this exact account; the
    // graded rewrite lands it around ~15 KB.
    expect(chars).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it("general-status: a many-type dense account stays under the char cap", async () => {
    const now = new Date();
    const types = [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "PULSE",
      "BODY_FAT",
      "STEPS",
    ];
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 730; day++) {
      const measuredAt = new Date(now.getTime() - day * dayMs);
      for (const type of types) {
        rows.push({ type, value: 50 + (day % 30), measuredAt });
      }
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    await generateGeneralStatusForUser("user-1", { locale: "en" });

    const chars = snapshotChars();
    // Pre-rewrite a many-type dense account could exceed 100 K tokens;
    // the graded rewrite lands it around ~12 KB.
    expect(chars).toBeLessThanOrEqual(BUDGET_CHARS);
  });
});
