import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusProviderResult } from "@/lib/insights/status-provider";

// Mock the crypto codec so the unit test needs no encryption key in env.
// `decryptFromBytes` echoes the bytes back as a marker string so the merge
// path can be asserted; `encryptToBytes` is a spy that returns a sentinel.
vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn((plaintext: string) => ({
    __enc: plaintext,
  })),
  decryptFromBytes: vi.fn((buf: { __plain?: string }) => buf.__plain ?? ""),
}));

import { encryptToBytes } from "../bytes-codec";
import {
  buildSummaryUserPrompt,
  refreshConversationSummary,
  SUMMARY_REFRESH_TURN_DELTA,
} from "../conversation-summary";

const TURN_CAP = 20;
const RECENT_HISTORY = 18;

/** A persisted message row as the module's select shape returns it. */
function msg(role: "user" | "assistant", content: string) {
  return { role, encryptedContent: { __plain: content } };
}

/** Build a conversation row of `n` turns alternating user/assistant. */
function makeConversation(
  n: number,
  overrides: {
    summaryEncrypted?: unknown;
    summaryTurnCount?: number;
  } = {},
) {
  const messages = Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `turn-${i}`),
  );
  return {
    id: "conv-1",
    summaryEncrypted: overrides.summaryEncrypted ?? null,
    summaryTurnCount: overrides.summaryTurnCount ?? 0,
    messages,
  };
}

function makePrisma(conversation: unknown) {
  const update = vi.fn().mockResolvedValue({});
  const findFirst = vi.fn().mockResolvedValue(conversation);
  return {
    update,
    findFirst,
    client: {
      coachConversation: { findFirst },
      $executeRaw: update,
    } as never,
  };
}

const okCompletion: StatusProviderResult = {
  kind: "ok",
  content: "The user is training for a 10k and prefers morning runs.",
  providerType: "admin-openai",
  model: "gpt-test",
  tokensUsed: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshConversationSummary", () => {
  it("(a) returns insufficient with no provider call at or below TURN_CAP", async () => {
    const { client, update } = makePrisma(makeConversation(TURN_CAP));
    const runCompletion = vi.fn();

    const result = await refreshConversationSummary("conv-1", "user-1", {
      prisma: client,
      runCompletion,
    });

    expect(result.status).toBe("insufficient");
    expect(runCompletion).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns insufficient when the conversation does not exist / is not owned", async () => {
    const { client, update } = makePrisma(null);
    const runCompletion = vi.fn();

    const result = await refreshConversationSummary("conv-1", "user-1", {
      prisma: client,
      runCompletion,
    });

    expect(result.status).toBe("insufficient");
    expect(runCompletion).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("(b) returns fresh with no provider call when fewer than DELTA new turns accumulated", async () => {
    // 28 turns → foldHighWater = 28 - 18 = 10. summaryTurnCount = 10 - (DELTA-1)
    // is > 0, and delta = DELTA-1 < DELTA ⇒ fresh.
    const foldHighWater = 28 - RECENT_HISTORY;
    const { client, update } = makePrisma(
      makeConversation(28, {
        summaryTurnCount: foldHighWater - (SUMMARY_REFRESH_TURN_DELTA - 1),
      }),
    );
    const runCompletion = vi.fn();

    const result = await refreshConversationSummary("conv-1", "user-1", {
      prisma: client,
      runCompletion,
    });

    expect(result.status).toBe("fresh");
    expect(runCompletion).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("(c) merge path passes the decrypted prior summary into the user prompt", async () => {
    const prior =
      "Earlier: user wants better sleep and dislikes evening caffeine.";
    // 30 turns, no prior summaryTurnCount → forces a generation.
    const { client } = makePrisma(
      makeConversation(30, {
        summaryEncrypted: { __plain: prior },
        summaryTurnCount: 0,
      }),
    );
    const runCompletion = vi
      .fn<(args: { userPrompt: string }) => Promise<StatusProviderResult>>()
      .mockResolvedValue(okCompletion);

    await refreshConversationSummary("conv-1", "user-1", {
      prisma: client,
      runCompletion: runCompletion as never,
    });

    expect(runCompletion).toHaveBeenCalledTimes(1);
    const arg = runCompletion.mock.calls[0]![0];
    expect(arg.userPrompt).toContain(prior);
    expect(arg.userPrompt).toContain("PRIOR SUMMARY");
  });

  it("(d) timeout / none leaves the existing summary untouched (skipped, no update)", async () => {
    for (const kind of ["timeout", "none", "error"] as const) {
      vi.clearAllMocks();
      const { client, update } = makePrisma(makeConversation(30));
      const runCompletion = vi.fn().mockResolvedValue({ kind });

      const result = await refreshConversationSummary("conv-1", "user-1", {
        prisma: client,
        runCompletion,
      });

      expect(result.status).toBe("skipped");
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("(e) success path persists the summary and turn count, and leaves updatedAt alone", async () => {
    const now = new Date("2026-06-04T08:00:00.000Z");
    const { client, update } = makePrisma(
      makeConversation(30, { summaryTurnCount: 0 }),
    );
    const runCompletion = vi.fn().mockResolvedValue(okCompletion);

    const result = await refreshConversationSummary("conv-1", "user-1", {
      prisma: client,
      runCompletion,
      now,
    });

    expect(result.status).toBe("generated");
    expect(encryptToBytes).toHaveBeenCalledWith(okCompletion.content);
    expect(update).toHaveBeenCalledTimes(1);
    const [strings, ...values] = update.mock.calls[0]! as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain('UPDATE "coach_conversations"');
    expect(sql).toContain('"summary_encrypted"');
    // A memory rewrite is not activity: the panel orders by updated_at.
    expect(sql).not.toMatch(/"updated_at"/);
    expect(values[1]).toBe(now);
    // foldHighWater = 30 - 18 = 12.
    expect(values[2]).toBe(12);
    expect(values[3]).toBe("conv-1");
  });
});

describe("buildSummaryUserPrompt", () => {
  it("uses (none) when no prior summary is supplied", () => {
    const out = buildSummaryUserPrompt(null, [{ role: "user", content: "hi" }]);
    expect(out).toContain("PRIOR SUMMARY\n(none)");
    expect(out).toContain("user: hi");
  });

  it("includes the prior summary and role-prefixes each folded turn", () => {
    const out = buildSummaryUserPrompt("prior text", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(out).toContain("PRIOR SUMMARY\nprior text");
    expect(out).toContain("user: a");
    expect(out).toContain("assistant: b");
  });

  it("renders German labels when locale is de", () => {
    const out = buildSummaryUserPrompt(null, [], "de");
    expect(out).toContain("FRÜHERE ZUSAMMENFASSUNG");
    expect(out).toContain("(keine)");
  });
});
