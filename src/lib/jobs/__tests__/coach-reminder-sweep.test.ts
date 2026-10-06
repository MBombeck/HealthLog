/**
 * v1.22 (M4) — daily Coach-reminder sweep.
 *
 * Covers: a passed CoachPlan reviewDate mints a one-off reminder from the
 * plan's own cue→action text and clears the reviewDate (activating the dangling
 * B1 column); an undecryptable plan is skipped (counted errored) without
 * sinking the tick; and — v1.37 — surfacing writes the reminder into a
 * conversation and flips its status in one transaction, so a badge can never
 * point at a message that was never written.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (buf: Uint8Array) => {
    const tag = Buffer.from(buf).toString("utf8");
    if (tag === "__bad__") throw new Error("unknown key id");
    return `dec:${tag}`;
  },
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(`enc:${s}`)),
}));

// Reminders are held while the Coach is unavailable; these cases are about
// surfacing, so the Coach answers. The hold is pinned against Postgres in
// `tests/integration/coach-reminder-surfacing.test.ts`.
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityToServe: vi.fn(async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  })),
}));

// The context-cue backstop delegates to the shared evaluator; its own
// behaviour is pinned in `ai/coach/__tests__/context-reminders.test.ts`.
const { contextEvaluateMock } = vi.hoisted(() => ({
  contextEvaluateMock: vi.fn(async (..._args: unknown[]) => ({
    surfaced: 0,
    errored: 0,
  })),
}));
vi.mock("@/lib/ai/coach/context-reminders", () => ({
  evaluateCoachContextReminders: contextEvaluateMock,
}));

import { runCoachReminderSweep } from "../coach-reminder-sweep";

const NOW = new Date("2026-06-27T05:20:00.000Z");

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

/**
 * A prisma double whose `$transaction` accepts BOTH shapes the sweep uses: an
 * array of pre-built operations (the plan-review mint) and an interactive
 * callback (the surfacing step).
 */
function makePrisma(options: {
  lapsedPlans?: number;
  lapsedFacts?: number;
  overdue?: {
    id: string;
    userId: string;
    noteEncrypted: Uint8Array;
  }[];
  plans?: {
    id: string;
    userId: string;
    metric: string;
    ifCueEncrypted: Uint8Array;
    thenActionEncrypted: Uint8Array;
  }[];
}) {
  const tx = {
    coachConversation: { create: vi.fn(async () => ({ id: "c1" })) },
    coachMessage: { create: vi.fn(async () => ({ id: "m1" })) },
    coachReminder: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    coachReminder: {
      findMany: vi.fn(async () => options.overdue ?? []),
      create: vi.fn(async () => ({ id: "r-new" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    coachPlan: {
      findMany: vi.fn(async () => options.plans ?? []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: options.lapsedPlans ?? 0 })),
    },
    coachFact: {
      updateMany: vi.fn(async () => ({ count: options.lapsedFacts ?? 0 })),
    },
    coachConversation: { create: vi.fn(async () => ({ id: "c1" })) },
    coachMessage: { create: vi.fn(async () => ({ id: "m1" })) },
    user: { findUnique: vi.fn(async () => ({ locale: "en" })) },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (t: typeof tx) => Promise<unknown>)(tx);
      }
      return Promise.all(arg as Promise<unknown>[]);
    }),
    tx,
  };
  return prisma;
}

describe("runCoachReminderSweep", () => {
  it("lets plan and fact proposals lapse after fourteen days", async () => {
    const prisma = makePrisma({ lapsedPlans: 2, lapsedFacts: 1 });
    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.planProposalsLapsed).toBe(2);
    expect(summary.factProposalsLapsed).toBe(1);
    const cutoff = new Date(NOW.getTime() - 14 * 86_400_000);
    expect(prisma.coachPlan.updateMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "proposed",
        createdAt: { lt: cutoff },
      },
      data: { status: "abandoned", reviewDate: null },
    });
    expect(prisma.coachFact.updateMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        source: "proposed",
        createdAt: { lt: cutoff },
      },
      data: { deletedAt: NOW },
    });
  });

  it("mints a plan-review reminder from the plan's own prose and clears the reviewDate", async () => {
    const prisma = makePrisma({
      plans: [
        {
          id: "p1",
          userId: "u1",
          metric: "WEIGHT",
          ifCueEncrypted: bytes("every morning"),
          thenActionEncrypted: bytes("weigh in"),
        },
      ],
    });

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.planReviewsMinted).toBe(1);
    expect(summary.errored).toBe(0);

    const createArgs = prisma.coachReminder.create.mock.calls[0] as unknown as [
      { data: { relatedPlanId: string; source: string; status: string } },
    ];
    const data = createArgs[0].data;
    expect(data.relatedPlanId).toBe("p1");
    expect(data.source).toBe("extractor");
    // Minted `active`, not `due`: the surfacing pass in this same tick is what
    // takes it to the conversation, and there is only one such path.
    expect(data.status).toBe("active");

    expect(prisma.coachPlan.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { reviewDate: null },
    });
  });

  it("writes the reminder into a conversation and flips its status in ONE transaction", async () => {
    const prisma = makePrisma({
      overdue: [
        { id: "r1", userId: "u1", noteEncrypted: bytes("ask about my sleep") },
      ],
    });

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.remindersDue).toBe(1);
    expect(summary.errored).toBe(0);

    // A conversation with the note as an ASSISTANT message — the row the
    // unread badge is derived from.
    expect(prisma.tx.coachConversation.create).toHaveBeenCalledTimes(1);
    const msgArgs = prisma.tx.coachMessage.create.mock.calls[0] as unknown as [
      { data: { role: string; encryptedContent: Uint8Array } },
    ];
    expect(msgArgs[0].data.role).toBe("assistant");
    const body = Buffer.from(msgArgs[0].data.encryptedContent).toString("utf8");
    expect(body).toContain("dec:ask about my sleep");

    // …and the status flip rides the SAME transaction, so neither half can
    // land without the other.
    const flip = prisma.tx.coachReminder.updateMany.mock
      .calls[0] as unknown as [
      { where: { id: { in: string[] } }; data: { status: string } },
    ];
    expect(flip[0].where.id.in).toEqual(["r1"]);
    expect(flip[0].data.status).toBe("surfaced");
  });

  it("picks up rows an older build left stuck on `due`", async () => {
    const prisma = makePrisma({
      overdue: [{ id: "r-old", userId: "u1", noteEncrypted: bytes("stuck") }],
    });

    await runCoachReminderSweep(prisma as never, NOW);

    const where = (
      prisma.coachReminder.findMany.mock.calls[0] as unknown as [
        { where: { status: { in: string[] } } },
      ]
    )[0].where;
    expect(where.status.in).toEqual(["active", "due"]);
  });

  it("leaves the reminder alone when the conversation write fails", async () => {
    const prisma = makePrisma({
      overdue: [{ id: "r1", userId: "u1", noteEncrypted: bytes("note") }],
    });
    prisma.$transaction = vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") throw new Error("db down");
      return Promise.all(arg as Promise<unknown>[]);
    }) as never;

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    // Not counted as surfaced — the next tick retries, and until it succeeds
    // nothing claims a message that does not exist.
    expect(summary.remindersDue).toBe(0);
    expect(summary.errored).toBe(1);
    expect(prisma.tx.coachReminder.updateMany).not.toHaveBeenCalled();
  });

  it("skips an undecryptable note without losing the ones beside it", async () => {
    const prisma = makePrisma({
      overdue: [
        { id: "r-bad", userId: "u1", noteEncrypted: bytes("__bad__") },
        { id: "r-ok", userId: "u1", noteEncrypted: bytes("fine") },
      ],
    });

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.remindersDue).toBe(1);
    expect(summary.errored).toBe(1);
    const flip = prisma.tx.coachReminder.updateMany.mock
      .calls[0] as unknown as [{ where: { id: { in: string[] } } }];
    expect(flip[0].where.id.in).toEqual(["r-ok"]);
  });

  // Watched red: with the context-backstop pass removed from the sweep this
  // fails on the evaluator assertion — the pre-fix sweep skipped context
  // reminders entirely ("follow-on (F4)").
  it("re-evaluates the measurement context cues as the daily backstop", async () => {
    const prisma = makePrisma({});
    contextEvaluateMock.mockClear();
    contextEvaluateMock.mockResolvedValue({ surfaced: 1, errored: 0 });
    prisma.coachReminder.findMany
      .mockResolvedValueOnce([]) // step 2: overdue date reminders
      .mockResolvedValueOnce([
        { userId: "u1" },
        { userId: "u1" },
        { userId: "u2" },
      ] as never); // step 3: pending context rows

    const summary = await runCoachReminderSweep(prisma as never, NOW);

    // One evaluation per distinct user, measurement trigger only.
    expect(contextEvaluateMock).toHaveBeenCalledTimes(2);
    expect(contextEvaluateMock).toHaveBeenCalledWith(
      prisma,
      "u1",
      "measurement",
      NOW,
    );
    expect(summary.contextSurfaced).toBe(2);

    // NEXT_APP_OPEN is deliberately outside the backstop: only a real
    // app-open signal may satisfy it.
    const where = (
      prisma.coachReminder.findMany.mock.calls[1] as unknown as [
        { where: { contextCue: { not: string } } },
      ]
    )[0].where;
    expect(where.contextCue).toEqual({ not: "NEXT_APP_OPEN" });
  });

  // Watched red: with the nag-cap pass removed from the sweep this fails on
  // the `nagDismissed` assertion and on the missing `dismissed` updateMany —
  // the pre-fix sweep never enforced the cap the surfaceCount schema comment
  // promised, so an ignored reminder nagged indefinitely.
  it("charges every ignored day and auto-dismisses at the nag cap", async () => {
    const prisma = makePrisma({});
    prisma.coachReminder.updateMany
      .mockResolvedValueOnce({ count: 2 }) // increment pass
      .mockResolvedValueOnce({ count: 1 }); // dismiss pass

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.nagDismissed).toBe(1);

    const [incrementCall, dismissCall] = prisma.coachReminder.updateMany.mock
      .calls as unknown as [
      [
        {
          where: { status: string; lastSurfacedAt: { lte: Date } };
          data: { surfaceCount: { increment: number } };
        },
      ],
      [
        {
          where: { status: string; surfaceCount: { gte: number } };
          data: { status: string };
        },
      ],
    ];
    // Only rows already stale for ~a day are charged — the tick that wrote
    // the surfacing message must not also count the first ignored day.
    expect(incrementCall[0].where.status).toBe("surfaced");
    expect(incrementCall[0].where.lastSurfacedAt.lte.getTime()).toBeLessThan(
      NOW.getTime(),
    );
    expect(incrementCall[0].data.surfaceCount).toEqual({ increment: 1 });
    // At the cap the row flips to `dismissed` — silence, not another nag.
    expect(dismissCall[0].where.surfaceCount).toEqual({ gte: 3 });
    expect(dismissCall[0].data.status).toBe("dismissed");
  });

  it("skips an undecryptable plan without sinking the tick", async () => {
    const prisma = makePrisma({
      plans: [
        {
          id: "p1",
          userId: "u1",
          metric: "SLEEP",
          ifCueEncrypted: bytes("__bad__"),
          thenActionEncrypted: bytes("lights out"),
        },
      ],
    });

    const summary = await runCoachReminderSweep(prisma as never, NOW);
    expect(summary.planReviewsMinted).toBe(0);
    expect(summary.errored).toBe(1);
    expect(prisma.coachReminder.create).not.toHaveBeenCalled();
    expect(prisma.coachPlan.update).not.toHaveBeenCalled();
  });
});
