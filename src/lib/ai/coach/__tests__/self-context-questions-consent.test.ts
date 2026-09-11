/**
 * Consent + budget contract for the self-context clarifying questions.
 *
 * The questions prompt ships the COMPLETE Coach snapshot, so it is a real PHI
 * egress and carries the same receipt requirement as the Coach chat. These
 * tests pin the two halves of that contract:
 *
 *   - a chain that could reach the operator's server-managed credential
 *     (`admin-openai` / `admin-codex`) refuses without an active receipt and
 *     lands on the deterministic hints — the provider is never called, and the
 *     snapshot is never even built;
 *   - the same chain proceeds once a receipt is on file;
 *   - a BYOK / local chain stays ungated (the user's own egress);
 *   - the budget runs through the ATOMIC reserve/reconcile pair, not a
 *     read-then-write check.
 *
 * `@/lib/consent/receipts` is mocked rather than the consent guard itself, so
 * the real `chainRequiresServerManagedConsent` + `hasActiveConsentForSurface`
 * logic is what these tests exercise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

const latestActiveReceipt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/consent/receipts", () => ({ latestActiveReceipt }));
vi.mock("@/lib/documents/document-settings", () => ({
  documentAutoReadEnabled: vi.fn(async () => false),
}));

const providerMocks = vi.hoisted(() => ({
  hasAnyConfiguredProvider: vi.fn(async () => true),
  resolveProvider: vi.fn(async () => ({ type: "none" })),
  resolveProviderChain: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/ai/provider", () => providerMocks);

const budgetMocks = vi.hoisted(() => ({
  buildDateKey: vi.fn(() => "2026-07-18"),
  reserveBudget: vi.fn(async () => ({
    allowed: true,
    reserved: 300,
    totalAfter: 300,
    owner: "operator" as const,
    operatorAfter: 300,
  })),
  reconcileSpend: vi.fn(async () => {}),
  resolveDailyCap: vi.fn(() => 200_000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/coach/budget", () => budgetMocks);

const buildCoachSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/coach/snapshot", () => ({ buildCoachSnapshot }));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { deriveClarifyingQuestions } from "../self-context-questions";
import type { SelfContext } from "../about-me";

const ctx: SelfContext = {
  aboutMe: "Shift work, half-marathon training.",
  conditions: "Hypertension",
  allergies: null,
  coachFocus: null,
};

/** A provider whose completion returns three usable questions. */
function makeProvider() {
  return {
    type: "openai",
    generateCompletion: vi.fn(async () => ({
      content: '["Question one?","Question two?"]',
      model: "gpt-4o",
      tokensUsed: 120,
      cachedInputTokens: 0,
    })),
  };
}

let provider: ReturnType<typeof makeProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  provider = makeProvider();
  latestActiveReceipt.mockResolvedValue(null);
  providerMocks.hasAnyConfiguredProvider.mockResolvedValue(true);
  providerMocks.resolveProvider.mockResolvedValue({ type: "none" });
  budgetMocks.reserveBudget.mockResolvedValue({
    allowed: true,
    reserved: 300,
    totalAfter: 300,
    owner: "operator" as const,
    operatorAfter: 300,
  });
  buildCoachSnapshot.mockResolvedValue({ snapshotJson: '{"weight":[]}' });
});

describe("deriveClarifyingQuestions — included sections", () => {
  it("falls back only to unanswered fields the user included", async () => {
    const out = await deriveClarifyingQuestions(
      "user-1",
      { ...ctx, aboutMe: null },
      "en",
      ["ABOUT_ME"],
    );

    expect(out.questions).toEqual([
      "Want to tell the Coach a bit about yourself — routines, goals, context?",
    ]);
    expect(providerMocks.hasAnyConfiguredProvider).not.toHaveBeenCalled();
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });

  it("does no question work when no question-bearing field is included", async () => {
    const out = await deriveClarifyingQuestions("user-1", ctx, "en", [
      "FAMILY_HISTORY",
    ]);

    expect(out.questions).toEqual([]);
    expect(providerMocks.hasAnyConfiguredProvider).not.toHaveBeenCalled();
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });
});

describe("deriveClarifyingQuestions — server-managed consent gate", () => {
  it("refuses the AI path on an operator-managed chain with no receipt", async () => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("fallback");
    // The snapshot is the PHI: it must never even be built, let alone sent.
    expect(provider.generateCompletion).not.toHaveBeenCalled();
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
    // And no budget is consumed by a refused request.
    expect(budgetMocks.reserveBudget).not.toHaveBeenCalled();
  });

  it("refuses on the operator-shared central Codex with no receipt", async () => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "admin-codex", instance: provider },
    ]);

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("fallback");
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("refuses when the legacy single-provider fallback serves the request", async () => {
    // Empty chain → `resolveProvider` fallback, which is tagged `admin-openai`
    // because an admin-key `OpenAIClient` is indistinguishable from a BYOK one.
    providerMocks.resolveProviderChain.mockResolvedValue([]);
    providerMocks.resolveProvider.mockResolvedValue(provider);

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("fallback");
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("proceeds on an operator-managed chain once an ai_coach receipt is active", async () => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    latestActiveReceipt.mockImplementation(async (_userId, kind) =>
      kind === "ai_coach" ? { id: "receipt-1" } : null,
    );

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("ai");
    expect(out.questions).toEqual(["Question one?", "Question two?"]);
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("accepts the master ai_full grant for the coach surface", async () => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    latestActiveReceipt.mockImplementation(async (_userId, kind) =>
      kind === "ai_full" ? { id: "receipt-2" } : null,
    );

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("ai");
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("leaves a BYOK chain ungated — the user's own egress needs no receipt", async () => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
    ]);

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("ai");
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
    expect(latestActiveReceipt).not.toHaveBeenCalled();
  });

  it("leaves a local chain ungated", async () => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "local", instance: provider },
    ]);

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("ai");
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a server-managed entry sits BEHIND a BYOK primary", async () => {
    // The runner may cascade to the admin key on a primary failure, so the
    // whole chain is what the gate judges — not just its head.
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
      { providerType: "admin-openai", instance: provider },
    ]);

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("fallback");
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });
});

describe("deriveClarifyingQuestions — atomic budget", () => {
  beforeEach(() => {
    providerMocks.resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
    ]);
  });

  it("reserves before the call and reconciles the actual spend after", async () => {
    await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(budgetMocks.reserveBudget).toHaveBeenCalledWith(
      "user-1",
      300,
      "2026-07-18",
      200_000,
      "operator",
    );
    expect(budgetMocks.reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      300,
      120,
      "2026-07-18",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("falls back without calling the provider when the reservation is refused", async () => {
    budgetMocks.reserveBudget.mockResolvedValue({
      allowed: false,
      reserved: 300,
      totalAfter: 200_000,
      owner: "operator" as const,
      operatorAfter: 200_000,
    });

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("fallback");
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("reconciles the reservation to zero when the provider throws", async () => {
    provider.generateCompletion.mockRejectedValue(new Error("upstream down"));

    const out = await deriveClarifyingQuestions("user-1", ctx, "en");

    expect(out.source).toBe("fallback");
    expect(budgetMocks.reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      300,
      0,
      "2026-07-18",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });
});
