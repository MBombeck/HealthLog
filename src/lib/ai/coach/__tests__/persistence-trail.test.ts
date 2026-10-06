import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.41 — the trail is sealed into its own column, held under its ceiling,
 * read back only by the owner, and its plaintext structure (the activity
 * metadata, the stop, the assumptions, the note and plan metadata) survives
 * a reload with malformed entries dropped.
 */
const txCreate = {
  coachConversation: { update: vi.fn() },
  coachMessage: { create: vi.fn() },
};
const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: typeof txCreate) => Promise<unknown>) =>
      cb(txCreate),
    ),
    coachMessage: { findFirst: (...args: unknown[]) => findFirst(...args) },
  },
}));
vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn((text: string) =>
    new TextEncoder().encode(`enc:${text}`),
  ),
  decryptFromBytes: vi.fn((bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
    return text.slice(4);
  }),
}));

import { TRAIL_MAX_BYTES } from "../activity/contract";
import { appendMessage, readMessageTrail } from "../persistence";
import type { CoachProvenance, CoachTrail } from "../types";

const TRAIL: CoachTrail = {
  entries: [{ id: "a1", title: "Weighing two weeks", text: "Sleep first." }],
  proposal: {
    proposalId: "p1",
    category: "medication",
    fact: "Takes a weekly injection",
  },
};

const PROVENANCE: CoachProvenance = {
  windows: [],
  metrics: [],
  activity: [
    {
      id: "a1",
      phase: "thinking",
      status: "done",
      round: 1,
      labelKey: "insights.coach.activity.thinking",
      label: "Thinking…",
      durationMs: 1200,
    },
    // Malformed: dropped on read, the rest kept.
    { id: "zz", phase: "fly" } as never,
  ],
  stop: { reason: "time", rounds: 4 },
  assumptions: [
    {
      kind: "window",
      value: {
        labelKey: "coach.clarify.window.last30days",
        label: "Last 30 days",
        value: { window: "last30days" },
      },
      alternatives: [],
    },
  ],
  memoryNote: { proposal: true, proposalId: "p1", category: "medication" },
  planProposal: { planId: "plan-1", metric: "WEIGHT", reviewInDays: 14 },
};

function decoded(bytes: Uint8Array | null): string | null {
  return bytes ? new TextDecoder().decode(bytes) : null;
}

beforeEach(() => {
  txCreate.coachMessage.create.mockReset();
  txCreate.coachMessage.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "m1",
      role: "assistant",
      createdAt: new Date("2026-10-06T10:00:00Z"),
      providerType: "codex",
      promptVersion: "v",
      tokensUsed: 10,
      model: "gpt",
      metricSourceJson: args.data.metricSourceJson,
    }),
  );
  findFirst.mockReset();
});

describe("appendMessage with a trail", () => {
  it("seals the trail's text into its own column, never into the provenance", async () => {
    const out = await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "Answer.",
      metricSource: PROVENANCE,
      trail: TRAIL,
    });
    const data = txCreate.coachMessage.create.mock.calls[0][0].data;
    expect(decoded(data.trailEncrypted)).toBe(`enc:${JSON.stringify(TRAIL)}`);
    expect(data.metricSourceJson).not.toContain("Weighing");
    expect(data.metricSourceJson).not.toContain("weekly injection");
    // The structure reads back, the malformed entry dropped.
    expect(out.metricSource?.activity?.map((a) => a.id)).toEqual(["a1"]);
    expect(out.metricSource?.stop).toEqual({ reason: "time", rounds: 4 });
    expect(out.metricSource?.assumptions).toHaveLength(1);
    expect(out.metricSource?.memoryNote).toEqual({
      proposal: true,
      proposalId: "p1",
      category: "medication",
    });
    expect(out.metricSource?.planProposal?.planId).toBe("plan-1");
  });

  it("writes no trail column on a turn without one", async () => {
    await appendMessage({ conversationId: "c1", role: "user", content: "hi" });
    expect(
      txCreate.coachMessage.create.mock.calls[0][0].data.trailEncrypted,
    ).toBeNull();
  });

  it("keeps a stored trail under its ceiling, dropping texts before titles", async () => {
    const big: CoachTrail = {
      entries: Array.from({ length: 60 }, (_, i) => ({
        id: `a${i + 1}`,
        title: `Round ${i}`,
        text: "y".repeat(390),
      })),
    };
    await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "Answer.",
      trail: big,
    });
    const text = decoded(
      txCreate.coachMessage.create.mock.calls[0][0].data.trailEncrypted,
    )!.slice(4);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      TRAIL_MAX_BYTES,
    );
    const stored = JSON.parse(text) as CoachTrail;
    expect(stored.entries[0].text).toBeUndefined();
    expect(stored.entries[0].title).toBe("Round 0");
    expect(stored.entries.at(-1)?.text).toBeDefined();
  });

  it("refuses a trail that does not match its schema", async () => {
    await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "Answer.",
      trail: { entries: [{ id: "not-an-id", title: "x" }] },
    });
    expect(
      txCreate.coachMessage.create.mock.calls[0][0].data.trailEncrypted,
    ).toBeNull();
  });
});

describe("readMessageTrail", () => {
  it("reads only a message in a conversation the caller owns", async () => {
    findFirst.mockResolvedValue({
      trailEncrypted: new TextEncoder().encode(`enc:${JSON.stringify(TRAIL)}`),
    });
    await expect(readMessageTrail("u1", "c1", "m1")).resolves.toEqual({
      trail: TRAIL,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "m1", conversationId: "c1", conversation: { userId: "u1" } },
      select: { trailEncrypted: true },
    });
  });

  it("is null for a foreign or missing message", async () => {
    findFirst.mockResolvedValue(null);
    await expect(readMessageTrail("u1", "c1", "m9")).resolves.toBeNull();
  });

  it("fails closed on a trail that does not decrypt", async () => {
    findFirst.mockResolvedValue({
      trailEncrypted: new TextEncoder().encode("tampered"),
    });
    await expect(readMessageTrail("u1", "c1", "m1")).resolves.toEqual({
      trail: null,
    });
  });

  it("reads a message without a trail as null", async () => {
    findFirst.mockResolvedValue({ trailEncrypted: null });
    await expect(readMessageTrail("u1", "c1", "m1")).resolves.toEqual({
      trail: null,
    });
  });
});
