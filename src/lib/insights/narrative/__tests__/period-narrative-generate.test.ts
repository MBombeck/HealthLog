import { describe, it, expect, vi, beforeEach } from "vitest";

// Identity "encryption" so the test asserts on plaintext round-trips without
// an ENCRYPTION_KEYS env. The generator's `encryptToBytes`/`decryptFromBytes`
// wrap these.
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));

// Keep the wide-event annotate a no-op.
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

// The default DB import must resolve to something; every test injects its own
// prisma double, so this is only a guard against accidental real-DB use.
vi.mock("@/lib/db", () => ({ prisma: {} }));

// The `periodNarrative` capability decides whether model-written prose may be
// served. Available unless a test says otherwise.
const { aiCapabilityForRecord } = vi.hoisted(() => ({
  aiCapabilityForRecord: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord,
  aiCapabilityToServe: aiCapabilityForRecord,
}));

const UNAVAILABLE = {
  available: false,
  reason: "user_disabled",
  onDeviceAllowed: false,
} as const;

import {
  generatePeriodNarrative,
  readPeriodNarrative,
  buildNarrativeUserPrompt,
  NARRATIVE_PROMPT_VERSION,
} from "@/lib/insights/narrative/period-narrative-generate";
import type {
  PeriodNarrativeContext,
  PeriodNarrativeResult,
} from "@/lib/insights/narrative/period-narrative";
import { toneContract } from "@/lib/ai/prompts/shared-contracts";

function readyContext(
  over: Partial<PeriodNarrativeContext> = {},
): PeriodNarrativeContext {
  return {
    status: "ready",
    period: "week",
    metricDeltas: [
      {
        type: "WEIGHT",
        unit: "kg",
        current: 80,
        prior: 81,
        delta: -1,
        deltaPercent: -1.2,
        currentDays: 6,
        priorDays: 7,
      },
    ],
    bandTransitions: [],
    drivers: [
      {
        behaviour: "ACTIVITY_STEPS",
        outcome: "SLEEP_DURATION",
        r: 0.4,
        qValue: 0.02,
        n: 14,
        interpretation: "more steps tended to coincide with longer sleep",
      },
    ],
    coincidentFlags: [],
    pairsTested: 12,
    fdrQ: 0.1,
    provenance: {
      metrics: ["WEIGHT", "ACTIVITY_STEPS", "SLEEP_DURATION"],
      window: {
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-15T00:00:00.000Z",
      },
      computedAt: "2026-05-15T05:00:00.000Z",
    },
    ...over,
  };
}

interface FakeRow {
  userId: string;
  period: string;
  locale: string;
  dateKey: string;
  encryptedContent: Uint8Array;
  provenanceJson: string | null;
  providerType: string | null;
  promptVersion: string | null;
  updatedAt: Date;
}

/** Minimal in-memory prisma double for the (user, period, locale) row + user. */
function makePrisma(seedRow?: FakeRow) {
  let row: FakeRow | undefined = seedRow;
  return {
    _get: () => row,
    user: {
      findUnique: vi.fn(async () => ({ timezone: "Europe/Berlin" })),
    },
    insightNarrative: {
      findUnique: vi.fn(async () => (row ? { ...row } : null)),
      upsert: vi.fn(
        async (args: { create: FakeRow; update: Partial<FakeRow> }) => {
          if (row) {
            row = { ...row, ...args.update, updatedAt: new Date() };
          } else {
            row = { ...args.create, updatedAt: new Date() };
          }
          return { ...row };
        },
      ),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  aiCapabilityForRecord.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
});

function seededRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    userId: "u1",
    period: "week",
    locale: "en",
    dateKey: "2026-05-15",
    encryptedContent: new Uint8Array(Buffer.from("enc:old", "utf8")),
    provenanceJson: null,
    providerType: "openai",
    promptVersion: NARRATIVE_PROMPT_VERSION,
    updatedAt: new Date(),
    ...over,
  };
}

describe("buildNarrativeUserPrompt", () => {
  it("renders metrics, drivers, and the FDR footer with the prompt version", () => {
    const prompt = buildNarrativeUserPrompt(readyContext(), "en");
    expect(prompt).toContain("WEIGHT");
    expect(prompt).toContain("ACTIVITY_STEPS ~ SLEEP_DURATION");
    expect(prompt).toContain("12 pairs tested");
    expect(NARRATIVE_PROMPT_VERSION).toBe("1.14.0");
  });
});

describe("generatePeriodNarrative — descriptive generation", () => {
  it("generates a narrative from a seeded ready context and stores it encrypted", async () => {
    const prisma = makePrisma();
    const runCompletion = vi.fn(async () => ({
      kind: "ok" as const,
      content: "Your weight eased down slightly this week.",
      providerType: "openai",
      model: "gpt",
      tokensUsed: 50,
    }));
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion,
    });
    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(prisma.insightNarrative.upsert).toHaveBeenCalledOnce();
    const stored = prisma._get();
    expect(stored?.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
    // Stored ciphertext is the identity-encoded prose, not plaintext.
    expect(Buffer.from(stored!.encryptedContent).toString("utf8")).toBe(
      "enc:Your weight eased down slightly this week.",
    );
  });

  it("passes a descriptive-never-causal system prompt to the provider", async () => {
    const prisma = makePrisma();
    let systemPrompt = "";
    let capability = "";
    const runCompletion = vi.fn(
      async (args: { systemPrompt: string; capability: string }) => {
        systemPrompt = args.systemPrompt;
        capability = args.capability;
        return {
          kind: "ok" as const,
          content: "ok",
          providerType: "openai",
          model: "m",
          tokensUsed: 1,
        };
      },
    );
    await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });
    expect(systemPrompt).toMatch(/never CAUSAL|DESCRIPTIVE/);
    expect(systemPrompt).toMatch(/no markdown/i);
    // v1.21.0 (coach C1 MEDIUM-1) — the retrospective now carries the shared
    // warm tone contract verbatim, matching the briefing's house voice.
    expect(systemPrompt).toContain(toneContract.en);
    // The chokepoint re-checks this narrative's own capability at the wire.
    expect(capability).toBe("periodNarrative");
  });
});

describe("generatePeriodNarrative — background reasoning (v1.41)", () => {
  it.each([
    ["week", "period_narrative_week"],
    ["month", "period_narrative_month"],
  ] as const)(
    "names the %s narrative's own job on the first pass",
    async (period, job) => {
      const prisma = makePrisma();
      const runCompletion = vi.fn(async (_args: { reasoningJob?: string }) => ({
        kind: "ok" as const,
        content: "Your weight eased down slightly.",
        providerType: "openai",
        model: "m",
        tokensUsed: 1,
      }));
      await generatePeriodNarrative("u1", {
        period,
        locale: "en",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma: prisma as any,
        buildContext: async () =>
          readyContext({ period }) as PeriodNarrativeResult,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runCompletion: runCompletion as any,
      });
      expect(runCompletion.mock.calls[0][0].reasoningJob).toBe(job);
    },
  );

  it("does not reason on the grounding retry", async () => {
    const prisma = makePrisma();
    const runCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "ok",
        content: "Your weight fell by 9.9 kg because you slept more.",
        providerType: "openai",
        model: "m",
        tokensUsed: 1,
      })
      .mockResolvedValueOnce({
        kind: "ok",
        content: "Your weight eased down slightly.",
        providerType: "openai",
        model: "m",
        tokensUsed: 1,
      });
    await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion,
    });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1][0].reasoningJob).toBeUndefined();
  });
});

describe("generatePeriodNarrative — honesty floor", () => {
  it("writes no narrative when the context is insufficient", async () => {
    const prisma = makePrisma();
    const runCompletion = vi.fn();
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () =>
        ({
          status: "insufficient",
          period: "week",
          reason: "not_enough_history",
          coverage: { metricsWithData: 1, required: 2 },
        }) as PeriodNarrativeResult,
      runCompletion,
    });
    expect(outcome).toEqual({ status: "insufficient" });
    expect(runCompletion).not.toHaveBeenCalled();
    expect(prisma.insightNarrative.upsert).not.toHaveBeenCalled();
  });

  it("composes a deterministic, non-causal fallback when no provider is configured", async () => {
    const prisma = makePrisma();
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion: async () => ({
        kind: "none" as const,
        reason: "no_provider" as const,
      }),
    });
    expect(outcome).toEqual({
      status: "generated",
      providerType: "deterministic",
    });
    expect(prisma.insightNarrative.upsert).toHaveBeenCalledTimes(1);
    // The persisted row carries the deterministic marker + non-empty prose.
    const stored = prisma._get();
    expect(stored?.providerType).toBe("deterministic");
    const text = Buffer.from(stored!.encryptedContent)
      .toString("utf8")
      .replace(/^enc:/, "");
    expect(text).toContain("your weight");
    expect(text.toLowerCase()).toContain("not causal");
  });
});

describe("generatePeriodNarrative — cache + regenerate", () => {
  it("serves a recent row without regenerating", async () => {
    const prisma = makePrisma({
      userId: "u1",
      period: "week",
      locale: "en",
      dateKey: "2026-05-15",
      encryptedContent: new Uint8Array(Buffer.from("enc:old", "utf8")),
      provenanceJson: null,
      providerType: "openai",
      promptVersion: NARRATIVE_PROMPT_VERSION,
      updatedAt: new Date(),
    });
    const runCompletion = vi.fn();
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion,
    });
    expect(outcome).toEqual({ status: "cached" });
    expect(runCompletion).not.toHaveBeenCalled();
  });

  it("force regenerates and upserts the single row in place", async () => {
    const prisma = makePrisma({
      userId: "u1",
      period: "week",
      locale: "en",
      dateKey: "2026-05-15",
      encryptedContent: new Uint8Array(Buffer.from("enc:old", "utf8")),
      provenanceJson: null,
      providerType: "openai",
      promptVersion: "0.0.0",
      updatedAt: new Date(),
    });
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      force: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion: async () => ({
        kind: "ok" as const,
        content: "fresh",
        providerType: "anthropic",
        model: "m",
        tokensUsed: 2,
      }),
    });
    expect(outcome).toEqual({ status: "generated", providerType: "anthropic" });
    // Read back the decrypted prose via the public reader.
    const read = await readPeriodNarrative(
      "u1",
      "week",
      "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    );
    expect(read?.text).toBe("fresh");
    expect(read?.providerType).toBe("anthropic");
  });
});

describe("period narrative — the periodNarrative capability", () => {
  it("readPeriodNarrative hides a model-written row while the capability is unavailable", async () => {
    const prisma = makePrisma(seededRow({ providerType: "openai" }));
    aiCapabilityForRecord.mockResolvedValue(UNAVAILABLE);
    const read = await readPeriodNarrative(
      "u1",
      "week",
      "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    );
    expect(read).toBeNull();
    expect(aiCapabilityForRecord).toHaveBeenCalledWith("u1", "periodNarrative");
  });

  it("readPeriodNarrative still serves the deterministic narrative, which is data", async () => {
    const prisma = makePrisma(
      seededRow({
        providerType: "deterministic",
        encryptedContent: new Uint8Array(
          Buffer.from("enc:Your weight eased down.", "utf8"),
        ),
      }),
    );
    aiCapabilityForRecord.mockResolvedValue(UNAVAILABLE);
    const read = await readPeriodNarrative(
      "u1",
      "week",
      "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    );
    expect(read?.text).toBe("Your weight eased down.");
    expect(aiCapabilityForRecord).not.toHaveBeenCalled();
  });

  it("does not short-circuit on a fresh model-written row it may not serve", async () => {
    const prisma = makePrisma(seededRow({ providerType: "openai" }));
    aiCapabilityForRecord.mockResolvedValue(UNAVAILABLE);
    // The chokepoint refuses on the same capability, so the deterministic
    // narrative replaces the hidden prose in place.
    const runCompletion = vi.fn(async () => ({
      kind: "none" as const,
      reason: "user_disabled" as const,
    }));
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion,
    });
    expect(outcome).toEqual({
      status: "generated",
      providerType: "deterministic",
    });
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(prisma._get()?.providerType).toBe("deterministic");
  });

  it("still short-circuits on a fresh deterministic row whatever the capability says", async () => {
    const prisma = makePrisma(seededRow({ providerType: "deterministic" }));
    aiCapabilityForRecord.mockResolvedValue(UNAVAILABLE);
    const runCompletion = vi.fn();
    const outcome = await generatePeriodNarrative("u1", {
      period: "week",
      locale: "en",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      buildContext: async () => readyContext() as PeriodNarrativeResult,
      runCompletion,
    });
    expect(outcome).toEqual({ status: "cached" });
    expect(runCompletion).not.toHaveBeenCalled();
  });
});
