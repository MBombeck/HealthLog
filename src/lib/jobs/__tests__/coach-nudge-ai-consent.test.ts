/**
 * Consent contract for the AI-composed proactive Coach nudge.
 *
 * The nudge sends less PHI than the Coach chat (an abstract trigger topic plus
 * the deterministic template body — never the user's own words or figures), but
 * it is still the user's health situation leaving the server, it runs
 * unattended on the 05:15 tick, and the chain can end at the operator's
 * server-managed credential. So it carries the same receipt requirement.
 *
 * The gate is skip-shaped: no receipt → `null` → the caller ships the
 * deterministic template, so the nudge itself is never lost.
 *
 * `@/lib/consent/receipts` is mocked rather than the consent guard, so the real
 * `chainRequiresServerManagedConsent` + `hasActiveConsentForSurface` logic runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

const latestActiveReceipt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/consent/receipts", () => ({ latestActiveReceipt }));
vi.mock("@/lib/documents/document-settings", () => ({
  documentAutoReadEnabled: vi.fn(async () => false),
}));

const resolveProviderChain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/provider", () => ({ resolveProviderChain }));

const budgetMocks = vi.hoisted(() => ({
  buildDateKey: vi.fn(() => "2026-07-18"),
  reserveBudget: vi.fn(async () => ({
    allowed: true,
    reserved: 160,
    totalAfter: 160,
  })),
  reconcileSpend: vi.fn(async () => {}),
  resolveDailyCap: vi.fn(() => 200_000),
  resolveDailyCapFor: vi.fn(() => 200_000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/coach/budget", () => budgetMocks);

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import {
  composeNudgeWithAI,
  createNudgeAiTickBudget,
  type ComposeNudgeParams,
} from "../coach-nudge-ai";

function makeProvider() {
  return {
    type: "openai",
    generateCompletion: vi.fn(async () => ({
      content: "Your rhythm has shifted a little this week — worth a look?",
      model: "gpt-4o",
      tokensUsed: 90,
      cachedInputTokens: 0,
    })),
  };
}

let provider: ReturnType<typeof makeProvider>;

function params(): ComposeNudgeParams {
  return {
    userId: "user-1",
    trigger: "compliance",
    locale: "en",
    name: "A",
    hasCoachFocus: false,
    template: { title: "Morning", body: "A gentle deterministic body." },
    tickBudget: createNudgeAiTickBudget(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  provider = makeProvider();
  latestActiveReceipt.mockResolvedValue(null);
  budgetMocks.reserveBudget.mockResolvedValue({
    allowed: true,
    reserved: 160,
    totalAfter: 160,
  });
});

describe("composeNudgeWithAI — server-managed consent gate", () => {
  it("skips AI composition on an operator-managed chain with no receipt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);

    const out = await composeNudgeWithAI(params());

    // null = the caller keeps the deterministic template.
    expect(out).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("burns neither a budget reservation nor a per-tick slot when refused", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    const p = params();

    await composeNudgeWithAI(p);

    expect(budgetMocks.reserveBudget).not.toHaveBeenCalled();
    expect(p.tickBudget.remainingCount).toBe(
      createNudgeAiTickBudget().remainingCount,
    );
  });

  it("skips on the operator-shared central Codex with no receipt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-codex", instance: provider },
    ]);

    expect(await composeNudgeWithAI(params())).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("composes once an ai_coach receipt is active", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    latestActiveReceipt.mockImplementation(async (_userId, kind) =>
      kind === "ai_coach" ? { id: "receipt-1" } : null,
    );

    const out = await composeNudgeWithAI(params());

    expect(out).not.toBeNull();
    expect(out?.body).toBe(
      "Your rhythm has shifted a little this week — worth a look?",
    );
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("accepts the master ai_full grant", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    latestActiveReceipt.mockImplementation(async (_userId, kind) =>
      kind === "ai_full" ? { id: "receipt-2" } : null,
    );

    expect(await composeNudgeWithAI(params())).not.toBeNull();
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("leaves a BYOK chain ungated — the user's own egress needs no receipt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
    ]);

    expect(await composeNudgeWithAI(params())).not.toBeNull();
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
    expect(latestActiveReceipt).not.toHaveBeenCalled();
  });

  it("fails closed when a server-managed entry sits BEHIND a BYOK primary", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
      { providerType: "admin-openai", instance: provider },
    ]);

    expect(await composeNudgeWithAI(params())).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });
});
