/**
 * v1.21.3 (B1) — extractAndStorePlanProposals tests.
 *
 * Covers:
 *  - extraction parses the model JSON, drops malformed items via the Zod gate,
 *    de-dups against the existing set, enforces the per-user cap, and persists
 *    survivors field-by-field as `status: "proposed"` (never active).
 *  - a no-provider / timeout result skips; an unparseable JSON annotates
 *    parse_failed and returns none; an empty array returns none.
 *  - v1.41: the `{"plans":[…]}` object the JSON-object mode returns parses,
 *    and no more than three proposals are ever open at once.
 * The active plans reach a turn through `memory/context-block.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Codec mock: a tagged Uint8Array round-trips through the string; a sentinel
// triggers a throw to exercise the fail-closed skip.
vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn((s: string) => new Uint8Array(Buffer.from(s, "utf8"))),
  decryptFromBytes: vi.fn((buf: Uint8Array) => {
    const tag = Buffer.from(buf).toString("utf8");
    if (tag === "__undecryptable__") throw new Error("unknown key id");
    return tag;
  }),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { extractAndStorePlanProposals, MAX_PLANS_PER_USER } from "../plans";
import { annotate } from "@/lib/logging/context";

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

function makePrisma(overrides?: {
  existing?: Array<Record<string, unknown>>;
  turns?: Array<{ role: string; encryptedContent: Uint8Array }>;
  active?: Array<Record<string, unknown>>;
}) {
  const create = vi.fn().mockResolvedValue({});
  const findMany = vi.fn(async (args: { where: { status?: unknown } }) => {
    // The injection block filters status: "active"; the extractor filters
    // status: { in: [...] }. Route the right fixture to each.
    const status = args.where.status;
    if (status === "active") return overrides?.active ?? [];
    return overrides?.existing ?? [];
  });
  const findFirst = vi.fn(async () => ({
    messages: overrides?.turns ?? [],
  }));
  return {
    coachPlan: { findMany, create },
    coachConversation: { findFirst },
    _create: create,
    _findMany: findMany,
  } as never;
}

const okResult = (content: string) => ({ kind: "ok", content }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractAndStorePlanProposals", () => {
  it("persists a clean plan field-by-field as proposed", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("I'll weigh daily") }],
    });
    const runCompletion = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify([
          {
            metric: "WEIGHT",
            ifCue: "every morning",
            thenAction: "step on the scale",
            target: "70 kg by August",
          },
        ]),
      ),
    );

    const out = await extractAndStorePlanProposals("conv-1", "user-1", {
      prisma: db,
      runCompletion,
    });

    expect(out).toEqual({ status: "stored", count: 1 });
    const createArg = (db as never as { _create: ReturnType<typeof vi.fn> })
      ._create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data.userId).toBe("user-1");
    expect(createArg.data.metric).toBe("WEIGHT");
    expect(createArg.data.status).toBe("proposed");
    expect(createArg.data.sourceConversationId).toBe("conv-1");
    // Field-by-field — no stray keys spread in.
    expect(Object.keys(createArg.data).sort()).toEqual(
      [
        "ifCueEncrypted",
        "metric",
        "sourceConversationId",
        "status",
        "targetEncrypted",
        "thenActionEncrypted",
        "userId",
      ].sort(),
    );
  });

  it("never writes status active (only the PATCH activates)", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi
      .fn()
      .mockResolvedValue(
        okResult(
          JSON.stringify([
            { metric: "SLEEP", ifCue: "after 22:30", thenAction: "lights out" },
          ]),
        ),
      );
    await extractAndStorePlanProposals("c", "u", { prisma: db, runCompletion });
    const createArg = (db as never as { _create: ReturnType<typeof vi.fn> })
      ._create.mock.calls[0][0] as { data: { status: string } };
    expect(createArg.data.status).toBe("proposed");
  });

  it("drops a malformed item but keeps the valid one", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify([
          { metric: "WEIGHT" }, // missing ifCue/thenAction → dropped
          { metric: "STEPS", ifCue: "after lunch", thenAction: "walk 10 min" },
        ]),
      ),
    );
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "stored", count: 1 });
  });

  it("de-dups against an existing active/proposed plan", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
      existing: [
        {
          id: "p1",
          ifCueEncrypted: bytes("every morning"),
          thenActionEncrypted: bytes("step on the scale"),
          status: "active",
        },
      ],
    });
    const runCompletion = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify([
          {
            metric: "WEIGHT",
            ifCue: "every morning",
            thenAction: "step on the scale",
          },
        ]),
      ),
    );
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "skipped", count: 0 });
    expect(
      (db as never as { _create: ReturnType<typeof vi.fn> })._create,
    ).not.toHaveBeenCalled();
  });

  it("skips when the user is already at the plan cap", async () => {
    const existing = Array.from({ length: MAX_PLANS_PER_USER }, (_, i) => ({
      id: `p${i}`,
      ifCueEncrypted: bytes(`cue ${i}`),
      thenActionEncrypted: bytes(`act ${i}`),
      status: "active",
    }));
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
      existing,
    });
    const runCompletion = vi
      .fn()
      .mockResolvedValue(
        okResult(
          JSON.stringify([
            { metric: "MOOD", ifCue: "fresh cue", thenAction: "fresh act" },
          ]),
        ),
      );
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "skipped", count: 0 });
  });

  it("skips when no turns exist", async () => {
    const db = makePrisma({ turns: [] });
    const runCompletion = vi.fn();
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "skipped", count: 0 });
    expect(runCompletion).not.toHaveBeenCalled();
  });

  it("skips on a no-provider / timeout completion", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi.fn().mockResolvedValue({ kind: "none" } as never);
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "skipped", count: 0 });
  });

  it("annotates parse_failed and returns none on unparseable JSON", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi.fn().mockResolvedValue(okResult("not json"));
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "none", count: 0 });
    const call = vi
      .mocked(annotate)
      .mock.calls.find(
        (c) =>
          (c[0] as { action?: { name?: string } })?.action?.name ===
          "coach.plans.parse_failed",
      );
    expect(call).toBeTruthy();
  });

  it("returns none on an empty array", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi.fn().mockResolvedValue(okResult("[]"));
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "none", count: 0 });
  });

  it("parses the {plans:[…]} object the JSON-object mode returns", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify({
          plans: [
            {
              metric: "STEPS",
              ifCue: "after lunch",
              thenAction: "walk 10 min",
            },
          ],
        }),
      ),
    );
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "stored", count: 1 });
    expect(annotate).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: { name: "coach.plans.parse_failed" } }),
    );
  });

  it("parses a fenced object too", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
    });
    const runCompletion = vi
      .fn()
      .mockResolvedValue(
        okResult(
          '```json\n{"plans":[{"metric":"SLEEP","ifCue":"at 22:30","thenAction":"lights out"}]}\n```',
        ),
      );
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "stored", count: 1 });
  });

  it("never holds more than three open proposals", async () => {
    const db = makePrisma({
      turns: [{ role: "user", encryptedContent: bytes("plan") }],
      existing: [
        {
          id: "p1",
          ifCueEncrypted: bytes("a"),
          thenActionEncrypted: bytes("b"),
          status: "proposed",
        },
        {
          id: "p2",
          ifCueEncrypted: bytes("c"),
          thenActionEncrypted: bytes("d"),
          status: "proposed",
        },
      ],
    });
    const runCompletion = vi.fn().mockResolvedValue(
      okResult(
        JSON.stringify({
          plans: [
            {
              metric: "STEPS",
              ifCue: "after lunch",
              thenAction: "walk 10 min",
            },
            {
              metric: "SLEEP",
              ifCue: "on weeknights",
              thenAction: "screens off at 22",
            },
          ],
        }),
      ),
    );
    const out = await extractAndStorePlanProposals("c", "u", {
      prisma: db,
      runCompletion,
    });
    expect(out).toEqual({ status: "stored", count: 1 });
  });
});
