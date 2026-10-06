import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusProviderResult } from "@/lib/insights/status-provider";

// Hermetic codec: round-trip through a UTF-8 buffer, no real crypto keys
// needed. Mirrors the bytes-codec contract (string ↔ Uint8Array).
vi.mock("../bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(s),
  decryptFromBytes: (b: Uint8Array) => new TextDecoder().decode(b),
}));

// Avoid importing the real Prisma client; opts injection supplies the fake.
vi.mock("@/lib/db", () => ({ prisma: {} }));

const annotateMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

// status-provider is replaced by the injected runCompletion in every test,
// but the module imports it at load time.
vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

import {
  extractAndStoreFacts,
  FACT_MAX_CHARS,
  MAX_FACTS_PER_USER,
  readJsonList,
} from "../facts";

// ---------------------------------------------------------------------------
// Fake prisma builder
// ---------------------------------------------------------------------------

interface FakeFactRow {
  id: string;
  factEncrypted: Uint8Array;
  category: string;
  confidence: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeFakePrisma(opts: {
  activeFacts?: Array<{
    id?: string;
    text: string;
    category?: string;
    confidence?: number;
  }>;
  turns?: Array<{ role: string; content: string }>;
  conversationExists?: boolean;
}) {
  const rows: FakeFactRow[] = (opts.activeFacts ?? []).map((f, i) => ({
    id: f.id ?? `fact-${i}`,
    factEncrypted: bytes(f.text),
    category: f.category ?? "preference",
    confidence: f.confidence ?? 50,
    updatedAt: new Date(2026, 0, 1 + i),
    deletedAt: null,
  }));

  const createCalls: Array<Record<string, unknown>> = [];

  const messages = (opts.turns ?? []).map((t) => ({
    role: t.role,
    encryptedContent: bytes(t.content),
    createdAt: new Date(),
  }));

  const prisma = {
    coachFact: {
      findMany: vi.fn(async () => rows),
      create: vi.fn(async (arg: { data: Record<string, unknown> }) => {
        createCalls.push(arg.data);
        return { id: `new-${createCalls.length}`, ...arg.data };
      }),
    },
    coachConversation: {
      findFirst: vi.fn(async () =>
        opts.conversationExists === false ? null : { messages },
      ),
    },
  };

  return { prisma, createCalls };
}

function ok(content: string): StatusProviderResult {
  return {
    kind: "ok",
    content,
    providerType: "mock",
    model: "m",
    tokensUsed: 1,
  };
}

beforeEach(() => {
  annotateMock.mockClear();
});

describe("extractAndStoreFacts", () => {
  it("(a) parses durable facts and persists them field-by-field", async () => {
    const { prisma, createCalls } = makeFakePrisma({
      turns: [
        {
          role: "user",
          content: "I prefer morning workouts and I'm vegetarian.",
        },
      ],
    });
    const runCompletion = vi.fn(async () =>
      ok(
        JSON.stringify([
          {
            category: "preference",
            fact: "Prefers morning workouts",
            confidence: 90,
          },
          { category: "preference", fact: "Is vegetarian", confidence: 80 },
        ]),
      ),
    );

    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });

    expect(res).toEqual({ status: "stored", count: 2 });
    expect(createCalls).toHaveLength(2);
    // Field-by-field — exact key set, no spread of the parsed object.
    for (const data of createCalls) {
      expect(Object.keys(data).sort()).toEqual(
        [
          "category",
          "confidence",
          "factEncrypted",
          "source",
          "sourceConversationId",
          "userId",
        ].sort(),
      );
      expect(data.userId).toBe("user-1");
      expect(data.sourceConversationId).toBe("conv-1");
      expect(data.factEncrypted).toBeInstanceOf(Uint8Array);
    }
    // Annotation carries counts/ids only.
    const extracted = annotateMock.mock.calls.find(
      (c) =>
        (c[0] as { action?: { name?: string } }).action?.name ===
        "coach.facts.extracted",
    );
    expect(extracted).toBeTruthy();
    expect((extracted![0] as { meta: Record<string, unknown> }).meta).toEqual({
      count: 2,
      proposed: 0,
      conversationId: "conv-1",
    });
    expect(createCalls.map((d) => d.source)).toEqual([
      "extracted",
      "extracted",
    ]);
  });

  it("(b) drops items the Zod gate rejects (bad category, over-length)", async () => {
    const { prisma, createCalls } = makeFakePrisma({
      turns: [{ role: "user", content: "talk" }],
    });
    const tooLong = "x".repeat(FACT_MAX_CHARS + 5);
    const runCompletion = vi.fn(async () =>
      ok(
        JSON.stringify([
          { category: "preference", fact: "Prefers tea", confidence: 70 }, // valid
          { category: "diagnosis", fact: "Has X", confidence: 90 }, // bad category
          { category: "goal", fact: tooLong, confidence: 60 }, // over length
          { category: "context", fact: "", confidence: 50 }, // empty
        ]),
      ),
    );

    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });

    expect(res).toEqual({ status: "stored", count: 1 });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].category).toBe("preference");
  });

  it("(c) malformed JSON → parse_failed annotation, 0 stored", async () => {
    const { prisma, createCalls } = makeFakePrisma({
      turns: [{ role: "user", content: "talk" }],
    });
    const runCompletion = vi.fn(async () => ok("not json at all {{{"));

    const res = await extractAndStoreFacts("conv-9", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });

    expect(res).toEqual({ status: "none", count: 0 });
    expect(createCalls).toHaveLength(0);
    const failed = annotateMock.mock.calls.find(
      (c) =>
        (c[0] as { action?: { name?: string } }).action?.name ===
        "coach.facts.parse_failed",
    );
    expect(failed).toBeTruthy();
    expect((failed![0] as { meta: Record<string, unknown> }).meta).toEqual({
      conversationId: "conv-9",
    });
  });

  it("(d) de-dup drops a near-duplicate of an existing fact", async () => {
    const { prisma, createCalls } = makeFakePrisma({
      activeFacts: [{ text: "Prefers morning workouts", confidence: 80 }],
      turns: [{ role: "user", content: "talk" }],
    });
    const runCompletion = vi.fn(async () =>
      ok(
        JSON.stringify([
          {
            category: "preference",
            fact: "prefers morning workouts",
            confidence: 90,
          }, // dup
          {
            category: "goal",
            fact: "Wants to run a 10k in autumn",
            confidence: 85,
          }, // new
        ]),
      ),
    );

    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });

    expect(res).toEqual({ status: "stored", count: 1 });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].category).toBe("goal");
  });

  it("(e) cap enforcement: at MAX, only strictly-higher-confidence is stored", async () => {
    // Fill to the cap; weakest active fact has confidence 30.
    const activeFacts = Array.from({ length: MAX_FACTS_PER_USER }, (_, i) => ({
      text: `active fact number ${i}`,
      confidence: i === 0 ? 30 : 70,
    }));
    const { prisma, createCalls } = makeFakePrisma({
      activeFacts,
      turns: [{ role: "user", content: "talk" }],
    });
    const runCompletion = vi.fn(async () =>
      ok(
        JSON.stringify([
          { category: "goal", fact: "low confidence newcomer", confidence: 20 }, // ≤30 → skip
          {
            category: "goal",
            fact: "high confidence newcomer",
            confidence: 95,
          }, // >30 → store
        ]),
      ),
    );

    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });

    expect(res).toEqual({ status: "stored", count: 1 });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].confidence).toBe(95);
  });

  it("(f) none/timeout/error provider result → skipped", async () => {
    for (const kind of ["none", "timeout", "error"] as const) {
      const { prisma, createCalls } = makeFakePrisma({
        turns: [{ role: "user", content: "talk" }],
      });
      const runCompletion = vi.fn(
        async () => ({ kind }) as StatusProviderResult,
      );
      const res = await extractAndStoreFacts("conv-1", "user-1", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma: prisma as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runCompletion: runCompletion as any,
      });
      expect(res).toEqual({ status: "skipped", count: 0 });
      expect(createCalls).toHaveLength(0);
    }
  });

  it("returns [] handling: empty array → none, 0 stored", async () => {
    const { prisma, createCalls } = makeFakePrisma({
      turns: [{ role: "user", content: "talk" }],
    });
    const runCompletion = vi.fn(async () => ok("[]"));
    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });
    expect(res).toEqual({ status: "none", count: 0 });
    expect(createCalls).toHaveLength(0);
  });

  it("skips when the conversation has no decryptable turns", async () => {
    const { prisma, createCalls } = makeFakePrisma({ turns: [] });
    const runCompletion = vi.fn(async () => ok("[]"));
    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });
    expect(res).toEqual({ status: "skipped", count: 0 });
    expect(runCompletion).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
  });

  it("parses the {facts:[…]} object the JSON-object mode returns", async () => {
    // Before v1.41 the prompt asked for a bare array while the status chain
    // ran in JSON-object mode: OpenAI could only return an object and every
    // such reply failed to parse.
    const { prisma, createCalls } = makeFakePrisma({
      turns: [{ role: "user", content: "I only run in the mornings." }],
    });
    const runCompletion = vi.fn(async () =>
      ok(
        JSON.stringify({
          facts: [
            {
              category: "preference",
              fact: "Runs only in the mornings",
              confidence: 85,
            },
          ],
        }),
      ),
    );
    const res = await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });
    expect(res).toEqual({ status: "stored", count: 1 });
    expect(createCalls).toHaveLength(1);
    const failed = annotateMock.mock.calls.find(
      (c) =>
        (c[0] as { action?: { name?: string } }).action?.name ===
        "coach.facts.parse_failed",
    );
    expect(failed).toBeUndefined();
  });

  it("asks for the object shape in both languages", async () => {
    const { prisma } = makeFakePrisma({
      turns: [{ role: "user", content: "hi" }],
    });
    for (const locale of ["en", "de"]) {
      const runCompletion = vi.fn(async () => ok('{"facts":[]}'));
      await extractAndStoreFacts("conv-1", "user-1", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma: prisma as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runCompletion: runCompletion as any,
        locale,
      });
      const args = (
        runCompletion.mock.calls[0] as unknown as [{ systemPrompt: string }]
      )[0];
      expect(args.systemPrompt).toContain('"facts"');
      expect(args.systemPrompt).toContain("medication");
    }
  });

  it("stores a health fact as a proposal, never as a known fact", async () => {
    const { prisma, createCalls } = makeFakePrisma({
      turns: [{ role: "user", content: "I take Ozempic since May." }],
    });
    const runCompletion = vi.fn(async () =>
      ok(
        JSON.stringify({
          facts: [
            {
              category: "medication",
              fact: "Takes Ozempic since May",
              confidence: 90,
            },
            // Filed as context, but worded as a medication.
            {
              category: "context",
              fact: "Started metformin last year",
              confidence: 80,
            },
            { category: "goal", fact: "Wants to run a 10k", confidence: 80 },
          ],
        }),
      ),
    );
    await extractAndStoreFacts("conv-1", "user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runCompletion: runCompletion as any,
    });
    const bySource = Object.fromEntries(
      createCalls.map((d) => [
        new TextDecoder().decode(d.factEncrypted as Uint8Array),
        d.source,
      ]),
    );
    expect(bySource).toEqual({
      "Takes Ozempic since May": "proposed",
      "Started metformin last year": "proposed",
      "Wants to run a 10k": "extracted",
    });
  });
});

describe("readJsonList", () => {
  it("reads a bare array, a wrapped list and a fenced object", () => {
    expect(readJsonList("[1,2]", "facts")).toEqual([1, 2]);
    expect(readJsonList('{"facts":[1]}', "facts")).toEqual([1]);
    expect(readJsonList('```json\n{"facts":[3]}\n```', "facts")).toEqual([3]);
    expect(readJsonList('Here you go: {"facts":[4]}', "facts")).toEqual([4]);
  });

  it("returns null for anything else", () => {
    expect(readJsonList("nope", "facts")).toBeNull();
    expect(readJsonList('{"other":[1]}', "facts")).toBeNull();
    expect(readJsonList('{"facts":"x"}', "facts")).toBeNull();
  });
});
