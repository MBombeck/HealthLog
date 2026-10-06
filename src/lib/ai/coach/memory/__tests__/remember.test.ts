/**
 * v1.41 — remember_fact, the person's answer to a proposal, and the remember
 * button. The rules under test:
 * - a preference, goal or context fact is saved at once (`source: "coach"`);
 * - a health fact (by category or by wording) is only proposed;
 * - a fact must come from the person's current message;
 * - one note per answer;
 * - a decision reads the fact from the stored trail, never the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(s),
  decryptFromBytes: (b: Uint8Array) => new TextDecoder().decode(b),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

interface FactRow {
  id: string;
  factEncrypted: Uint8Array;
  category: string;
  confidence: number;
  source: string;
}

const db = vi.hoisted(() => ({
  facts: [] as FactRow[],
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  message: null as Record<string, unknown> | null,
  latestUser: { id: "um1" } as { id: string } | null,
  updateCount: 1,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    // The decision runs in one transaction under the message's lock.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const { prisma } = await import("@/lib/db");
      return fn(prisma);
    }),
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    coachFact: {
      findMany: vi.fn(async () => db.facts),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (arg: { data: Record<string, unknown> }) => {
        db.created.push(arg.data);
        return { id: `f${db.created.length}` };
      }),
      updateMany: vi.fn(
        async (arg: { where: unknown; data: Record<string, unknown> }) => {
          db.updated.push(arg);
          return { count: db.updateCount };
        },
      ),
    },
    coachMessage: {
      findFirst: vi.fn(async (arg: { where: { role?: string } }) =>
        arg.where.role === "user" && !("id" in arg.where)
          ? db.latestUser
          : db.message,
      ),
    },
  },
}));

import {
  decideFactProposal,
  factComesFromMessage,
  rememberFactFromTool,
  rememberMessageAsFact,
  resetTurnMarksForTests,
} from "../remember";
import {
  commitTurnWrites,
  resetStagedTurnWritesForTests,
} from "../turn-writes";
import type { Prisma } from "@/generated/prisma/client";
import type { CoachProvenance } from "../../types";

/** Stores an answer with `provenance`, the way `appendMessage` does. */
async function storeAnswer(
  provenance: Partial<CoachProvenance>,
  conversationId = "c1",
) {
  const { prisma } = await import("@/lib/db");
  const executed: unknown[] = [];
  const tx = {
    coachFact: prisma.coachFact,
    coachPlan: { create: vi.fn() },
    $executeRaw: vi.fn(async (...args: unknown[]) => {
      executed.push(args);
      return 1;
    }),
  } as unknown as Prisma.TransactionClient;
  await commitTurnWrites(tx, {
    conversationId,
    provenance: { windows: [], metrics: [], ...provenance },
  });
  return { executed };
}

const enc = (s: string) => new TextEncoder().encode(s);
const BASE = { userId: "u1", conversationId: "c1" };

beforeEach(() => {
  db.facts = [];
  db.created = [];
  db.updated = [];
  db.message = null;
  db.latestUser = { id: "um1" };
  db.updateCount = 1;
  resetTurnMarksForTests();
  resetStagedTurnWritesForTests();
});

describe("factComesFromMessage", () => {
  it("accepts the person's own words, paraphrased", () => {
    expect(
      factComesFromMessage(
        "Wants to reach 75 kg by December",
        "I really want to get down to 75 kg by December.",
      ),
    ).toBe(true);
    expect(
      factComesFromMessage(
        "Nimmt seit Mai Mounjaro",
        "ich nehme seit Mai Mounjaro, falls das wichtig ist",
      ),
    ).toBe(true);
  });

  it("refuses a fact the message does not carry", () => {
    expect(
      factComesFromMessage(
        "Wants to reach 70 kg by December",
        "I want to get down to 75 kg by December.",
      ),
    ).toBe(false);
    expect(
      factComesFromMessage(
        "Prefers swimming over running",
        "How was my sleep last week?",
      ),
    ).toBe(false);
  });
});

describe("rememberFactFromTool", () => {
  it("saves a goal with the answer that notes it", async () => {
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "I want to get down to 75 kg by December.",
      call: {
        category: "goal",
        fact: "Wants to reach 75 kg by December",
        why: "goal",
      },
    });
    expect(out).toEqual({
      kind: "saved",
      note: {
        proposal: false,
        factId: expect.stringMatching(/^c[0-9a-f]{24}$/),
        category: "goal",
        fact: "Wants to reach 75 kg by December",
      },
    });
    // Nothing is written in the tool round.
    expect(db.created).toHaveLength(0);
    if (out.kind !== "saved") throw new Error("unreachable");
    await storeAnswer({
      memoryNote: {
        proposal: false,
        factId: out.note.factId,
        category: "goal",
      },
    });
    expect(db.created[0]).toMatchObject({
      id: out.note.factId,
      userId: "u1",
      category: "goal",
      source: "coach",
      sourceConversationId: "c1",
      sourceMessageId: "um1",
    });
  });

  it("writes nothing when the stored answer does not carry the note", async () => {
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "I prefer to walk after dinner.",
      call: {
        category: "preference",
        fact: "Prefers to walk after dinner",
        why: "preference",
      },
    });
    expect(out.kind).toBe("saved");
    // A blocked answer is stored without its memoryNote; a failed or
    // abandoned turn stores only the empty marker.
    await storeAnswer({});
    expect(db.created).toHaveLength(0);
    // The staged fact went with that turn: nothing can claim it later.
    if (out.kind !== "saved") throw new Error("unreachable");
    await storeAnswer({
      memoryNote: {
        proposal: false,
        factId: out.note.factId,
        category: "preference",
      },
    });
    expect(db.created).toHaveLength(0);
  });

  it("stamps an offered background proposal only when the answer is stored", async () => {
    const offered = await storeAnswer({
      memoryNote: { proposal: true, proposalId: "row1", category: "condition" },
    });
    expect(offered.executed).toHaveLength(1);
    const turnProposal = await storeAnswer({
      memoryNote: { proposal: true, proposalId: "mp_1", category: "condition" },
    });
    expect(turnProposal.executed).toHaveLength(0);
  });

  it("files a medication fact under medication whatever the model filed it under", async () => {
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "I have taken metformin with breakfast for years.",
      call: {
        category: "condition",
        fact: "Takes metformin with breakfast",
        why: "health",
      },
    });
    expect(out).toMatchObject({
      kind: "proposed",
      note: { category: "medication" },
    });
  });

  it("only proposes a health fact, writing nothing", async () => {
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "ich nehme seit Mai Mounjaro",
      call: {
        category: "medication",
        fact: "Nimmt seit Mai Mounjaro",
        why: "",
      },
    });
    expect(out.kind).toBe("proposed");
    if (out.kind !== "proposed") return;
    expect(out.note.proposal).toBe(true);
    expect(out.note.proposalId).toMatch(/^mp_/);
    expect(out.note.category).toBe("medication");
    expect(db.created).toHaveLength(0);
  });

  it("proposes a fact filed as context when its wording is medical", async () => {
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "I started metformin last spring",
      call: {
        category: "context",
        fact: "Started metformin last spring",
        why: "",
      },
    });
    expect(out.kind).toBe("proposed");
    if (out.kind === "proposed") expect(out.note.category).toBe("medication");
    expect(db.created).toHaveLength(0);
  });

  it("refuses a fact the message does not carry", async () => {
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "How was my sleep?",
      call: { category: "preference", fact: "Prefers evening runs", why: "" },
    });
    expect(out).toEqual({ kind: "declined", reason: "not_from_message" });
    expect(db.created).toHaveLength(0);
  });

  it("keeps to one note per answer", async () => {
    const message = "I like evening runs and I want to reach 75 kg";
    const first = await rememberFactFromTool({
      ...BASE,
      userMessage: message,
      call: { category: "preference", fact: "Likes evening runs", why: "" },
    });
    const second = await rememberFactFromTool({
      ...BASE,
      userMessage: message,
      call: { category: "goal", fact: "Wants to reach 75 kg", why: "" },
    });
    expect(first.kind).toBe("saved");
    expect(second).toEqual({ kind: "declined", reason: "one_per_answer" });
  });

  it("declines a fact it already knows", async () => {
    db.facts = [
      {
        id: "old",
        factEncrypted: enc("Likes evening runs"),
        category: "preference",
        confidence: 80,
        source: "coach",
      },
    ];
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "I like evening runs",
      call: { category: "preference", fact: "Likes evening runs", why: "" },
    });
    expect(out).toEqual({ kind: "declined", reason: "duplicate" });
  });

  it("offers a waiting proposal instead of minting a second one", async () => {
    db.facts = [
      {
        id: "pending1",
        factEncrypted: enc("Allergy: peanut (self-reported)"),
        category: "condition",
        confidence: 95,
        source: "proposed",
      },
    ];
    const out = await rememberFactFromTool({
      ...BASE,
      userMessage: "I have a peanut allergy, self-reported to my doctor too",
      call: {
        category: "condition",
        fact: "Allergy: peanut (self-reported)",
        why: "",
      },
    });
    expect(out.kind).toBe("proposed");
    if (out.kind === "proposed") expect(out.note.proposalId).toBe("pending1");
  });

  it("refuses an unknown category or an over-long fact", async () => {
    await expect(
      rememberFactFromTool({
        ...BASE,
        userMessage: "x",
        // @ts-expect-error — an unknown category from the wire
        call: { category: "diagnosis", fact: "x x x", why: "" },
      }),
    ).resolves.toEqual({ kind: "declined", reason: "invalid" });
    await expect(
      rememberFactFromTool({
        ...BASE,
        userMessage: "y".repeat(400),
        call: { category: "context", fact: "y".repeat(200), why: "" },
      }),
    ).resolves.toEqual({ kind: "declined", reason: "invalid" });
  });
});

describe("decideFactProposal", () => {
  function trail(proposal: Record<string, unknown>) {
    db.message = {
      trailEncrypted: enc(JSON.stringify({ entries: [], proposal })),
    };
  }

  it("saves the fact read from the stored trail", async () => {
    trail({
      proposalId: "mp_1",
      category: "medication",
      fact: "Takes Mounjaro since May",
    });
    const out = await decideFactProposal({
      ...BASE,
      messageId: "am1",
      proposalId: "mp_1",
      accept: true,
    });
    expect(out).toEqual({ kind: "saved", factId: "f1" });
    // Under the message's lock, in one transaction.
    const { prisma } = await import("@/lib/db");
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(
      String(
        (prisma.$queryRaw as unknown as { mock: { calls: unknown[][] } }).mock
          .calls[0]?.[0],
      ),
    ).toContain("pg_advisory_xact_lock");
    expect(db.created[0]).toMatchObject({
      category: "medication",
      source: "user",
      sourceMessageId: "am1",
    });
    expect(
      new TextDecoder().decode(db.created[0].factEncrypted as Uint8Array),
    ).toBe("Takes Mounjaro since May");
  });

  it("is stale for a proposal the message never carried", async () => {
    trail({ proposalId: "mp_1", category: "goal", fact: "x" });
    await expect(
      decideFactProposal({
        ...BASE,
        messageId: "am1",
        proposalId: "mp_other",
        accept: true,
      }),
    ).resolves.toEqual({ kind: "stale" });
    db.message = null;
    await expect(
      decideFactProposal({
        ...BASE,
        messageId: "am1",
        proposalId: "mp_1",
        accept: true,
      }),
    ).resolves.toEqual({ kind: "stale" });
    expect(db.created).toHaveLength(0);
  });

  it("writes nothing on No", async () => {
    trail({ proposalId: "mp_1", category: "condition", fact: "Has asthma" });
    await expect(
      decideFactProposal({
        ...BASE,
        messageId: "am1",
        proposalId: "mp_1",
        accept: false,
      }),
    ).resolves.toEqual({ kind: "declined" });
    expect(db.created).toHaveLength(0);
  });

  it("confirms or drops a waiting background proposal in place", async () => {
    trail({ proposalId: "row1", category: "condition", fact: "Has asthma" });
    await expect(
      decideFactProposal({
        ...BASE,
        messageId: "am1",
        proposalId: "row1",
        accept: true,
      }),
    ).resolves.toEqual({ kind: "saved", factId: "row1" });
    expect(db.updated[0].data).toEqual({
      source: "user",
      sourceMessageId: "am1",
    });
    await decideFactProposal({
      ...BASE,
      messageId: "am1",
      proposalId: "row1",
      accept: false,
    });
    expect(db.updated[1].data).toHaveProperty("deletedAt");
  });
});

describe("rememberMessageAsFact", () => {
  it("saves the person's own message, filed by the lexicon", async () => {
    db.message = {
      id: "um9",
      conversationId: "c1",
      encryptedContent: enc("I take ramipril every morning"),
    };
    const out = await rememberMessageAsFact({ userId: "u1", messageId: "um9" });
    expect(out).toEqual({
      id: "f1",
      category: "medication",
      text: "I take ramipril every morning",
      source: "user",
      created: true,
    });
    expect(db.created[0]).toMatchObject({
      source: "user",
      sourceMessageId: "um9",
      sourceConversationId: "c1",
    });
  });

  it("files anything else as context", async () => {
    db.message = {
      id: "um9",
      conversationId: "c1",
      encryptedContent: enc("I work night shifts on weekends"),
    };
    const out = await rememberMessageAsFact({ userId: "u1", messageId: "um9" });
    expect(out?.category).toBe("context");
  });

  it("answers null for a message that is not the caller's", async () => {
    db.message = null;
    await expect(
      rememberMessageAsFact({ userId: "u1", messageId: "nope" }),
    ).resolves.toBeNull();
  });
});
