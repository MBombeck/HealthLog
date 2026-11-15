import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the seven prepare modules. Each test sets a prepare's return to a
// `served` or `pending` card. The pending card's `finalize` / `timeout` are
// vi.fn so we can assert the fan-out hit the right closure.
vi.mock("@/lib/insights/blood-pressure-status", () => ({
  prepareBloodPressureStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/weight-status", () => ({
  prepareWeightStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/pulse-status", () => ({
  preparePulseStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/bmi-status", () => ({
  prepareBmiStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/mood-status", () => ({
  prepareMoodStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/medication-compliance-status", () => ({
  prepareMedicationComplianceStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/general-status", () => ({
  prepareGeneralStatusForUser: vi.fn(),
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: vi.fn(),
}));

// The single-card fallback path — assert it is invoked for omitted / failed
// metrics, but don't re-drive a real completion.
vi.mock("@/lib/insights/status-card-generation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/insights/status-card-generation")
    >();
  return { ...actual, runPreparedStatusCard: vi.fn(async () => ({})) };
});

import { prepareBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { prepareWeightStatusForUser } from "@/lib/insights/weight-status";
import { preparePulseStatusForUser } from "@/lib/insights/pulse-status";
import { prepareBmiStatusForUser } from "@/lib/insights/bmi-status";
import { prepareMoodStatusForUser } from "@/lib/insights/mood-status";
import { prepareMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import { prepareGeneralStatusForUser } from "@/lib/insights/general-status";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { runPreparedStatusCard } from "@/lib/insights/status-card-generation";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { generateStatusBatchForUser } from "../status-batch";

function servedCard() {
  return {
    phase: "served" as const,
    result: { hasProvider: true, text: "cached", cached: true, updatedAt: "t" },
  };
}

function pendingCard(
  metric: string,
  finalize: (arg: { content: string }) => Promise<unknown> = vi.fn(
    async (): Promise<unknown> => ({}),
  ),
) {
  const timeout = vi.fn(() => ({
    hasProvider: true,
    text: "stub",
    cached: true,
    updatedAt: null,
  }));
  return {
    phase: "pending" as const,
    metric,
    userId: "u1",
    cacheAction: `insights.${metric}-status.en`,
    systemPrompt: "sys",
    userPrompt: `snapshot for ${metric}`,
    snapshotHash: "h",
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      text: "nokey",
      cached: true,
      updatedAt: null,
    },
    timeout,
    finalize,
  };
}

const ALL_PREPARES = [
  prepareBloodPressureStatusForUser,
  prepareWeightStatusForUser,
  preparePulseStatusForUser,
  prepareBmiStatusForUser,
  prepareMoodStatusForUser,
  prepareMedicationComplianceStatusForUser,
  prepareGeneralStatusForUser,
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(aiCapabilityForJob).mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  } as never);
});

describe("generateStatusBatchForUser — the statusText capability comes first", () => {
  it("builds no snapshot and makes no call while statusText is unavailable", async () => {
    vi.mocked(aiCapabilityForJob).mockResolvedValue({
      available: false,
      reason: "consent_required",
      onDeviceAllowed: false,
    } as never);
    ALL_PREPARES.forEach((prepare, i) => {
      vi.mocked(prepare).mockResolvedValue(pendingCard(`m${i}`) as never);
    });

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "statusText");
    for (const prepare of ALL_PREPARES) expect(prepare).not.toHaveBeenCalled();
    expect(runStatusCompletion).not.toHaveBeenCalled();
    expect(runPreparedStatusCard).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      served: 0,
      batched: 0,
      fellBack: 0,
      fellBackAnswered: 0,
      batchCallMade: false,
    });
  });
});

describe("generateStatusBatchForUser — one call covers all present metrics", () => {
  it("issues exactly ONE provider call for the seven pending cards and fans each summary into its finalize", async () => {
    const mkFinalize = () =>
      vi.fn((arg: { content: string }): Promise<unknown> => {
        void arg;
        return Promise.resolve({});
      });
    const finalizers = {
      "blood-pressure": mkFinalize(),
      weight: mkFinalize(),
      pulse: mkFinalize(),
      bmi: mkFinalize(),
      mood: mkFinalize(),
      "medication-compliance": mkFinalize(),
      general: mkFinalize(),
    } as const;
    vi.mocked(prepareBloodPressureStatusForUser).mockResolvedValue(
      pendingCard("blood-pressure", finalizers["blood-pressure"]) as never,
    );
    vi.mocked(prepareWeightStatusForUser).mockResolvedValue(
      pendingCard("weight", finalizers.weight) as never,
    );
    vi.mocked(preparePulseStatusForUser).mockResolvedValue(
      pendingCard("pulse", finalizers.pulse) as never,
    );
    vi.mocked(prepareBmiStatusForUser).mockResolvedValue(
      pendingCard("bmi", finalizers.bmi) as never,
    );
    vi.mocked(prepareMoodStatusForUser).mockResolvedValue(
      pendingCard("mood", finalizers.mood) as never,
    );
    vi.mocked(prepareMedicationComplianceStatusForUser).mockResolvedValue(
      pendingCard(
        "medication-compliance",
        finalizers["medication-compliance"],
      ) as never,
    );
    vi.mocked(prepareGeneralStatusForUser).mockResolvedValue(
      pendingCard("general", finalizers.general) as never,
    );

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "ok",
      content: JSON.stringify({
        perMetric: {
          bp: "BP assessment.",
          weight: "Weight assessment.",
          pulse: "Pulse assessment.",
          bmi: "BMI assessment.",
          mood: "Mood assessment.",
          compliance: "Adherence assessment.",
          general: "Overview assessment.",
        },
      }),
      providerType: "anthropic",
      model: "x",
      tokensUsed: 100,
    } as never);

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    // ONE provider round-trip for all seven metrics.
    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    // The chokepoint re-checks the same capability at the wire.
    expect(runStatusCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "statusText" }),
    );
    expect(result.batched).toBe(7);
    expect(result.fellBack).toBe(0);
    // Each metric's finalize got its own summary, wrapped in the { summary }
    // envelope each card's finalize parses.
    for (const f of Object.values(finalizers)) {
      expect(f).toHaveBeenCalledTimes(1);
    }
    const bpArg = finalizers["blood-pressure"].mock.calls[0][0];
    expect(JSON.parse(bpArg.content)).toEqual({ summary: "BP assessment." });
    // No card fell back to a single-card call.
    expect(runPreparedStatusCard).not.toHaveBeenCalled();
  });
});

describe("generateStatusBatchForUser — absent metrics are omitted, not fabricated", () => {
  it("only prompts for the metrics with data and never finalizes an absent metric", async () => {
    // Five metrics resolve `served` (cache hit / unchanged / no data); only
    // weight + pulse are pending.
    vi.mocked(prepareBloodPressureStatusForUser).mockResolvedValue(
      servedCard() as never,
    );
    const weightFinalize = vi.fn(async () => ({}));
    const pulseFinalize = vi.fn(async () => ({}));
    vi.mocked(prepareWeightStatusForUser).mockResolvedValue(
      pendingCard("weight", weightFinalize) as never,
    );
    vi.mocked(preparePulseStatusForUser).mockResolvedValue(
      pendingCard("pulse", pulseFinalize) as never,
    );
    vi.mocked(prepareBmiStatusForUser).mockResolvedValue(servedCard() as never);
    vi.mocked(prepareMoodStatusForUser).mockResolvedValue(
      servedCard() as never,
    );
    vi.mocked(prepareMedicationComplianceStatusForUser).mockResolvedValue(
      servedCard() as never,
    );
    vi.mocked(prepareGeneralStatusForUser).mockResolvedValue(
      servedCard() as never,
    );

    let capturedSystem = "";
    vi.mocked(runStatusCompletion).mockImplementation(
      async (args: { systemPrompt: string }) => {
        capturedSystem = args.systemPrompt;
        return {
          kind: "ok",
          content: JSON.stringify({
            perMetric: { weight: "W.", pulse: "P." },
          }),
          providerType: "anthropic",
          model: "x",
          tokensUsed: 10,
        } as never;
      },
    );

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    expect(result.served).toBe(5);
    expect(result.batched).toBe(2);
    // The prompt names ONLY the present keys (in prepare order: pulse before
    // weight, since the batch runs [bp, pulse, weight, …]).
    expect(capturedSystem).toContain("keys present: pulse, weight");
    expect(capturedSystem).not.toContain('"bp"');
    expect(weightFinalize).toHaveBeenCalledTimes(1);
    expect(pulseFinalize).toHaveBeenCalledTimes(1);
  });
});

describe("generateStatusBatchForUser — hash gate short-circuits unchanged data", () => {
  it("makes NO provider call when every card resolved served (cache / unchanged)", async () => {
    for (const prepare of ALL_PREPARES) {
      vi.mocked(prepare).mockResolvedValue(servedCard() as never);
    }

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    expect(runStatusCompletion).not.toHaveBeenCalled();
    expect(result.served).toBe(7);
    expect(result.batched).toBe(0);
    expect(result.batchCallMade).toBe(false);
  });
});

describe("generateStatusBatchForUser — graceful partial degradation", () => {
  it("falls a metric the batch omitted back to its single-card path", async () => {
    const weightFinalize = vi.fn(async () => ({}));
    const pulseFinalize = vi.fn(async () => ({}));
    vi.mocked(prepareWeightStatusForUser).mockResolvedValue(
      pendingCard("weight", weightFinalize) as never,
    );
    vi.mocked(preparePulseStatusForUser).mockResolvedValue(
      pendingCard("pulse", pulseFinalize) as never,
    );
    for (const prepare of [
      prepareBloodPressureStatusForUser,
      prepareBmiStatusForUser,
      prepareMoodStatusForUser,
      prepareMedicationComplianceStatusForUser,
      prepareGeneralStatusForUser,
    ]) {
      vi.mocked(prepare).mockResolvedValue(servedCard() as never);
    }

    // The batch returns weight but OMITS pulse.
    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "ok",
      content: JSON.stringify({ perMetric: { weight: "W." } }),
      providerType: "anthropic",
      model: "x",
      tokensUsed: 10,
    } as never);

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    expect(weightFinalize).toHaveBeenCalledTimes(1);
    // pulse was omitted → fell back to the single-card path, NOT finalized
    // from the batch.
    expect(pulseFinalize).not.toHaveBeenCalled();
    expect(runPreparedStatusCard).toHaveBeenCalledTimes(1);
    expect(result.batched).toBe(1);
    expect(result.fellBack).toBe(1);
  });

  it("degrades every pending metric to its single-card path on a batch provider error", async () => {
    const finalizers = ALL_PREPARES.map(() => vi.fn(async () => ({})));
    ALL_PREPARES.forEach((prepare, i) => {
      vi.mocked(prepare).mockResolvedValue(
        pendingCard(`m${i}`, finalizers[i]) as never,
      );
    });
    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "error",
    } as never);
    // #1384 — one card's own call came back with a model note; the other six
    // served their fallback. A nightly warm over a provider that only failed
    // reported `assessments_warmed: 6`, because every fallback counted.
    vi.mocked(runPreparedStatusCard).mockResolvedValueOnce({
      hasProvider: true,
      text: "note",
      cached: false,
      updatedAt: "t",
    });

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    // No finalize from the batch; every metric fell back.
    for (const f of finalizers) expect(f).not.toHaveBeenCalled();
    expect(runPreparedStatusCard).toHaveBeenCalledTimes(7);
    expect(result.fellBack).toBe(7);
    expect(result.fellBackAnswered).toBe(1);
    expect(result.batched).toBe(0);
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    const wf = vi.fn(async () => ({}));
    const pf = vi.fn(async () => ({}));
    vi.mocked(prepareWeightStatusForUser).mockResolvedValue(
      pendingCard("weight", wf) as never,
    );
    vi.mocked(preparePulseStatusForUser).mockResolvedValue(
      pendingCard("pulse", pf) as never,
    );
    for (const prepare of [
      prepareBloodPressureStatusForUser,
      prepareBmiStatusForUser,
      prepareMoodStatusForUser,
      prepareMedicationComplianceStatusForUser,
      prepareGeneralStatusForUser,
    ]) {
      vi.mocked(prepare).mockResolvedValue(servedCard() as never);
    }

    vi.mocked(runStatusCompletion)
      .mockResolvedValueOnce({
        kind: "ok",
        content: "not json at all",
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never)
      .mockResolvedValueOnce({
        kind: "ok",
        content: JSON.stringify({ perMetric: { weight: "W.", pulse: "P." } }),
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never);

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    expect(runStatusCompletion).toHaveBeenCalledTimes(2);
    expect(wf).toHaveBeenCalledTimes(1);
    expect(pf).toHaveBeenCalledTimes(1);
    expect(result.batched).toBe(2);
  });

  it("serves the no-key result for every pending card when no provider is configured", async () => {
    const finalizers = ALL_PREPARES.map(() => vi.fn(async () => ({})));
    ALL_PREPARES.forEach((prepare, i) => {
      vi.mocked(prepare).mockResolvedValue(
        pendingCard(`m${i}`, finalizers[i]) as never,
      );
    });
    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "none",
      reason: "no_provider",
    } as never);

    const result = await generateStatusBatchForUser("u1", { locale: "en" });

    // No finalize, no re-issued completion (the no-key result is precomputed).
    for (const f of finalizers) expect(f).not.toHaveBeenCalled();
    expect(runPreparedStatusCard).not.toHaveBeenCalled();
    expect(result.fellBack).toBe(7);
    expect(result.fellBackAnswered).toBe(0);
    expect(result.batchCallMade).toBe(false);
  });
});
