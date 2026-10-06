/**
 * v1.41 — what the two background chokepoints put on the wire about
 * reasoning.
 *
 * Status cards and every other routine generation call `runStatusCompletion`
 * without a job and must send no `reasoning` at all. The daily briefing and
 * the period narratives name their job and get the resolved level, unless the
 * operator switched reasoning off, which wins over every job. The operator's
 * controls are read through the real loader against a stubbed settings row,
 * so the switch is exercised the way production reads it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { settingsRow } = vi.hoisted(() => ({
  settingsRow: {
    current: null as null | {
      aiReasoningEnabled: boolean;
      aiReasoningMaxEffort: string;
    },
    fail: false,
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(async () => {
        if (settingsRow.fail) throw new Error("db down");
        return settingsRow.current;
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ aiResponseTimeoutSeconds: null })),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => undefined,
}));

const { resolveProviderChain } = vi.hoisted(() => ({
  resolveProviderChain: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain,
  resolveProvider: vi.fn(),
  probeProviderPresence: vi.fn(async () => true),
  probeProviderChain: vi.fn(),
  isAnthropicBaseUrl: () => false,
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: vi.fn(async () => ({ available: true })),
}));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(async () => null),
}));

const { reserveBudget } = vi.hoisted(() => ({ reserveBudget: vi.fn() }));
vi.mock("@/lib/ai/coach/budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/coach/budget")>();
  return {
    ...actual,
    reserveBudget,
    reconcileSpend: vi.fn(async () => undefined),
  };
});

const { runRawCompletionWithFallback } = vi.hoisted(() => ({
  runRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback,
}));

import { runStatusCompletion } from "../status-provider";
import { runBriefingCompletion } from "../briefing-provider";
import type { CompletionParams } from "@/lib/ai/types";

const BYOK = [{ providerType: "anthropic" as const, instance: {} as never }];
const OPERATOR = [
  { providerType: "admin-openai" as const, instance: {} as never },
];

function sentParams(): CompletionParams {
  const call = runRawCompletionWithFallback.mock.calls.at(-1)?.[0] as {
    params: CompletionParams;
  };
  return call.params;
}

function reserved(): number {
  return reserveBudget.mock.calls.at(-1)?.[1] as number;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsRow.current = null;
  settingsRow.fail = false;
  resolveProviderChain.mockResolvedValue(BYOK);
  reserveBudget.mockImplementation(async (_u: string, n: number) => ({
    allowed: true,
    reserved: n,
    owner: "user",
  }));
  runRawCompletionWithFallback.mockResolvedValue({
    result: { content: '{"summary":"ok"}', tokensUsed: 10 },
    workingProvider: BYOK[0],
  });
});

const statusArgs = {
  userId: "u1",
  cacheAction: "status:test",
  systemPrompt: "system",
  userPrompt: "user",
  capability: "statusText" as const,
};

describe("runStatusCompletion", () => {
  it("sends no reasoning for a call that names no job (every status card)", async () => {
    await runStatusCompletion(statusArgs);
    expect(sentParams().reasoning).toBeUndefined();
    expect(sentParams().timeoutMs).toBe(60_000);
  });

  it("sends the job's level for a monthly narrative and reserves its thinking", async () => {
    await runStatusCompletion({
      ...statusArgs,
      capability: "periodNarrative",
      maxTokens: 400,
      reasoningJob: "period_narrative_month",
    });
    expect(sentParams().reasoning).toEqual({
      effort: "medium",
      summaries: false,
    });
    // The answer budget only; the client adds the thinking budget.
    expect(sentParams().maxTokens).toBe(400);
    expect(sentParams().timeoutMs).toBe(90_000);
    expect(reserved()).toBe(400 + 4_096 + Math.ceil(10 / 4));
  });

  it("drops to the operator level when the operator pays", async () => {
    resolveProviderChain.mockResolvedValue(OPERATOR);
    await runStatusCompletion({
      ...statusArgs,
      capability: "periodNarrative",
      reasoningJob: "period_narrative_month",
    });
    expect(sentParams().reasoning?.effort).toBe("low");
  });

  it("honours the operator's cap", async () => {
    settingsRow.current = {
      aiReasoningEnabled: true,
      aiReasoningMaxEffort: "low",
    };
    await runStatusCompletion({
      ...statusArgs,
      capability: "periodNarrative",
      reasoningJob: "period_narrative_month",
    });
    expect(sentParams().reasoning?.effort).toBe("low");
  });

  it("sends nothing when the operator switched reasoning off", async () => {
    settingsRow.current = {
      aiReasoningEnabled: false,
      aiReasoningMaxEffort: "high",
    };
    await runStatusCompletion({
      ...statusArgs,
      capability: "periodNarrative",
      maxTokens: 400,
      reasoningJob: "period_narrative_month",
    });
    expect(sentParams().reasoning).toBeUndefined();
    expect(sentParams().timeoutMs).toBe(60_000);
    expect(reserved()).toBe(400 + Math.ceil(10 / 4));
  });

  it("sends nothing when the controls cannot be read (fails closed)", async () => {
    settingsRow.fail = true;
    const outcome = await runStatusCompletion({
      ...statusArgs,
      capability: "periodNarrative",
      reasoningJob: "period_narrative_week",
    });
    expect(outcome.kind).toBe("ok");
    expect(sentParams().reasoning).toBeUndefined();
  });
});

describe("runBriefingCompletion", () => {
  const briefingArgs = {
    userId: "u1",
    chain: BYOK,
    systemPrompt: "system",
    userPrompt: "user",
    temperature: 0.3,
    maxTokens: 3000,
    timeoutMs: 180_000,
    stage: "generate" as const,
  };

  it("sends no reasoning without a job (the retries, the on-demand route)", async () => {
    await runBriefingCompletion(briefingArgs);
    expect(sentParams().reasoning).toBeUndefined();
    expect(reserved()).toBe(3000 + Math.ceil(10 / 4));
  });

  it("thinks at medium on the person's own provider", async () => {
    await runBriefingCompletion({
      ...briefingArgs,
      reasoningJob: "daily_briefing",
    });
    expect(sentParams().reasoning).toEqual({
      effort: "medium",
      summaries: false,
    });
    expect(sentParams().maxTokens).toBe(3000);
    expect(reserved()).toBe(3000 + 4_096 + Math.ceil(10 / 4));
  });

  it("thinks at low on the operator's provider", async () => {
    await runBriefingCompletion({
      ...briefingArgs,
      chain: OPERATOR,
      reasoningJob: "daily_briefing",
    });
    expect(sentParams().reasoning?.effort).toBe("low");
  });

  it("sends nothing when the operator switched reasoning off", async () => {
    settingsRow.current = {
      aiReasoningEnabled: false,
      aiReasoningMaxEffort: "high",
    };
    await runBriefingCompletion({
      ...briefingArgs,
      reasoningJob: "daily_briefing",
    });
    expect(sentParams().reasoning).toBeUndefined();
  });
});
