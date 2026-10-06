/**
 * v1.41 — the Coach's memory, end to end against Postgres and the real codec.
 *
 * The unit suites prove each memory function calls the right Prisma methods.
 * They cannot prove that what one end writes is what the other end reads:
 * that a fact the Coach saved in a turn comes back in the next turn's block,
 * that a health proposal is stored nowhere until the person taps and is then
 * read back from the encrypted trail, that a plan taken on carries its
 * progress into both the block and the briefing, and that `last_used_at`
 * moves without moving `updated_at`. Those are the claims here, through the
 * same functions the turn, the chat request and the briefing call.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  buildMemoryContextBlock,
  buildPlanProgressLines,
  decideFactProposal,
  decidePlanProposal,
  proposePlanFromTool,
  rememberFactFromTool,
} from "@/lib/ai/coach/memory/contract";
import { resetTurnMarksForTests } from "@/lib/ai/coach/memory/remember";
import { storeDeterministicFacts } from "@/lib/ai/coach/facts";
import { runCoachReminderSweep } from "@/lib/jobs/coach-reminder-sweep";

const DAY = 86_400_000;

/** A user whose Coach and briefing may reach a model. */
async function seedUser(username: string) {
  return getPrismaClient().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      timezone: "UTC",
      locale: "en",
      aiProvider: "ANTHROPIC",
      aiAnthropicKeyEncrypted: "v1:presence-only",
      consentReceipts: {
        create: { kind: "ai_full", artefact: "test", signedAt: new Date() },
      },
    },
  });
}

async function seedTurn(userId: string, message: string) {
  const prisma = getPrismaClient();
  const conversation = await prisma.coachConversation.create({
    data: { userId, titleEncrypted: encryptToBytes("t") },
  });
  const userMessage = await prisma.coachMessage.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      encryptedContent: encryptToBytes(message),
    },
  });
  return { conversationId: conversation.id, userMessageId: userMessage.id };
}

async function assistantMessage(
  conversationId: string,
  opts: { trail?: unknown; metricSource?: unknown },
) {
  return getPrismaClient().coachMessage.create({
    data: {
      conversationId,
      role: "assistant",
      encryptedContent: encryptToBytes("answer"),
      trailEncrypted: opts.trail
        ? encryptToBytes(JSON.stringify(opts.trail))
        : null,
      metricSourceJson: opts.metricSource
        ? JSON.stringify(opts.metricSource)
        : null,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  resetTurnMarksForTests();
});

describe("a fact the Coach keeps reaches the next turn", () => {
  it("saves a goal from the message, then carries it in the block and stamps its use", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("memory-goal");
    const turn = await seedTurn(
      user.id,
      "I want to get down to 75 kg by December.",
    );

    const saved = await rememberFactFromTool({
      userId: user.id,
      conversationId: turn.conversationId,
      userMessage: "I want to get down to 75 kg by December.",
      call: {
        category: "goal",
        fact: "Wants to reach 75 kg by December",
        why: "a goal",
      },
    });
    expect(saved.kind).toBe("saved");
    const row = await prisma.coachFact.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.source).toBe("coach");
    expect(row.sourceMessageId).toBe(turn.userMessageId);
    expect(decryptFromBytes(row.factEncrypted)).toBe(
      "Wants to reach 75 kg by December",
    );
    expect(row.lastUsedAt).toBeNull();

    const block = await buildMemoryContextBlock({
      userId: user.id,
      conversationId: turn.conversationId,
      locale: "en",
    });
    expect(block?.factIds).toEqual([row.id]);
    expect(block?.text).toContain("- [goal] Wants to reach 75 kg by December");

    const after = await prisma.coachFact.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.lastUsedAt).not.toBeNull();
    // A use is not an edit: the ranking's recency stays where it was.
    expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
  });
});

describe("a health fact waits for the person's tap", () => {
  it("writes nothing on the proposal, and the tap saves the text read from the trail", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("memory-health");
    const turn = await seedTurn(user.id, "ich nehme seit Mai Mounjaro");

    const proposed = await rememberFactFromTool({
      userId: user.id,
      conversationId: turn.conversationId,
      userMessage: "ich nehme seit Mai Mounjaro",
      call: {
        category: "medication",
        fact: "Nimmt seit Mai Mounjaro",
        why: "",
      },
    });
    expect(proposed.kind).toBe("proposed");
    if (proposed.kind !== "proposed") return;
    expect(await prisma.coachFact.count()).toBe(0);

    const answer = await assistantMessage(turn.conversationId, {
      trail: {
        entries: [],
        proposal: {
          proposalId: proposed.note.proposalId,
          category: proposed.note.category,
          fact: proposed.note.fact,
        },
      },
    });

    const decided = await decideFactProposal({
      userId: user.id,
      conversationId: turn.conversationId,
      messageId: answer.id,
      proposalId: proposed.note.proposalId!,
      accept: true,
    });
    expect(decided.kind).toBe("saved");
    const row = await prisma.coachFact.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row).toMatchObject({
      category: "medication",
      source: "user",
      sourceMessageId: answer.id,
    });
    expect(decryptFromBytes(row.factEncrypted)).toBe("Nimmt seit Mai Mounjaro");

    // Another person cannot answer it.
    const other = await seedUser("memory-other");
    await expect(
      decideFactProposal({
        userId: other.id,
        conversationId: turn.conversationId,
        messageId: answer.id,
        proposalId: proposed.note.proposalId!,
        accept: true,
      }),
    ).resolves.toEqual({ kind: "stale" });
  });

  it("offers a background proposal once, and lets it lapse after fourteen days", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("memory-pending");
    const turn = await seedTurn(user.id, "I'm allergic to peanuts.");

    await storeDeterministicFacts({
      conversationId: turn.conversationId,
      userId: user.id,
      message: "I'm allergic to peanuts.",
      locale: "en",
    });
    const pending = await prisma.coachFact.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(pending.source).toBe("proposed");

    const first = await buildMemoryContextBlock({
      userId: user.id,
      conversationId: turn.conversationId,
      locale: "en",
    });
    expect(first?.pendingProposal).toMatchObject({
      proposal: true,
      proposalId: pending.id,
      category: "condition",
    });
    // Not a known fact: never in the block itself.
    expect(first?.text).toBe("");
    const second = await buildMemoryContextBlock({
      userId: user.id,
      conversationId: turn.conversationId,
      locale: "en",
    });
    expect(second).toBeNull();

    await prisma.coachFact.update({
      where: { id: pending.id },
      data: { createdAt: new Date(Date.now() - 15 * DAY) },
    });
    const summary = await runCoachReminderSweep(prisma, new Date());
    expect(summary.factProposalsLapsed).toBe(1);
    const lapsed = await prisma.coachFact.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(lapsed.deletedAt).not.toBeNull();
  });
});

describe("a plan the person takes on", () => {
  it("is proposed, activated by the tap, and carries its progress into the block and the briefing", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("memory-plan");
    const turn = await seedTurn(
      user.id,
      "I want to lose weight, I could walk after dinner.",
    );

    const outcome = await proposePlanFromTool({
      userId: user.id,
      conversationId: turn.conversationId,
      call: {
        metric: "WEIGHT",
        target: "75 kg by December",
        ifCue: "after dinner",
        thenAction: "a 20-minute walk",
        reviewInDays: 21,
      },
    });
    expect(outcome.kind).toBe("proposed");
    if (outcome.kind !== "proposed") return;
    const proposedRow = await prisma.coachPlan.findUniqueOrThrow({
      where: { id: outcome.proposal.planId },
    });
    expect(proposedRow.status).toBe("proposed");
    expect(decryptFromBytes(proposedRow.ifCueEncrypted)).toBe("after dinner");

    const answer = await assistantMessage(turn.conversationId, {
      metricSource: {
        windows: [],
        metrics: [],
        planProposal: {
          planId: outcome.proposal.planId,
          metric: "WEIGHT",
          reviewInDays: 21,
        },
      },
    });
    const decided = await decidePlanProposal({
      userId: user.id,
      conversationId: turn.conversationId,
      messageId: answer.id,
      planId: outcome.proposal.planId,
      accept: true,
    });
    expect(decided).toEqual({ kind: "activated", reviewInDays: 21 });
    const active = await prisma.coachPlan.findUniqueOrThrow({
      where: { id: outcome.proposal.planId },
    });
    expect(active.status).toBe("active");
    expect(active.reviewDate!.getTime() - Date.now()).toBeGreaterThan(20 * DAY);

    // Readings before and after the start, so the line has numbers.
    await prisma.coachPlan.update({
      where: { id: active.id },
      data: { createdAt: new Date(Date.now() - 12 * DAY) },
    });
    await prisma.measurement.createMany({
      data: [20, 17, 14, 10, 7, 4, 2, 1].map((daysAgo, i) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: 80 - i * 0.2,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date(Date.now() - daysAgo * DAY),
      })),
    });

    const block = await buildMemoryContextBlock({
      userId: user.id,
      conversationId: turn.conversationId,
      locale: "en",
    });
    expect(block?.planIds).toEqual([active.id]);
    expect(block?.text).toContain(
      "- WEIGHT: if after dinner, then a 20-minute walk (target: 75 kg by December). Progress: weight plan since",
    );
    expect(block?.text).toMatch(/latest 7-day mean \d+(\.\d)? kg/);

    const lines = await buildPlanProgressLines(user.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^weight plan since \d{4}-\d{2}-\d{2}; target "75 kg by December"/,
    );

    // A second tap on the same answer changes nothing.
    await expect(
      decidePlanProposal({
        userId: user.id,
        conversationId: turn.conversationId,
        messageId: answer.id,
        planId: outcome.proposal.planId,
        accept: false,
      }),
    ).resolves.toEqual({ kind: "stale" });
  });
});
