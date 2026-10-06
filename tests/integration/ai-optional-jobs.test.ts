/**
 * The AI background jobs, run directly against real Postgres under the states
 * that must stop them, with a spy in place of the provider.
 *
 * For every worker and every refusing state: the spy is never called, the
 * worker writes no model text, and a skip annotation is recorded. Under the
 * all-on baseline the spy IS called, which is what proves the test can see a
 * call at all (a spy that no path reaches would pass every refusing case).
 *
 * States (design "AI optional", 6.2):
 *   S0 all on: the person's own key, every switch on.
 *   S1 the operator's master switch off.
 *   S3 no provider configured anywhere.
 *   S4 only the operator's key, and no consent receipt.
 *   S5 the Coach hidden (`disableCoach`), which stops only the Coach.
 *   S6 AI analysis switched off (the `insights` module), which stops
 *      everything but the Coach.
 *
 * Only the provider chain is replaced; the capability resolution, the
 * presence probe, the budget ledger and the writes all run for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const providerSpy = vi.fn(async () => ({
  content: JSON.stringify({ summary: "A calm and steady stretch." }),
  model: "spy-model",
  tokensUsed: 12,
}));

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  const chain = () => [
    {
      providerType: "anthropic",
      instance: { type: "anthropic", generateCompletion: providerSpy },
    },
  ];
  return {
    ...actual,
    resolveProviderChain: vi.fn(async () => chain()),
    resolveProvider: vi.fn(async () => ({ type: "none" })),
  };
});

const annotations: string[] = [];
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn((event: { action?: { name?: string } }) => {
      if (event?.action?.name) annotations.push(event.action.name);
      return actual.annotate(event as never);
    }),
  };
});

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { runCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-refresh-worker";
import { generateStatusBatchForUser } from "@/lib/insights/status-batch";
import { runInsightStatusGenerate } from "@/lib/jobs/insight-status-generate";
import { runReactionLine } from "@/lib/jobs/reaction-line";
import { runWorkoutInsightGenerate } from "@/lib/jobs/workout-insight-generate";
import { userDayKey } from "@/lib/tz/resolver";

type State = "S0" | "S1" | "S3" | "S4" | "S5" | "S6";

let counter = 0;

/** One account in the given state, with the data every worker below reads. */
async function seedState(state: State) {
  const prisma = getPrismaClient();
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      assistantEnabled: state !== "S1",
      adminAiKeyEncrypted: state === "S4" ? "operator-key-present" : null,
    },
    update: {
      assistantEnabled: state !== "S1",
      adminAiKeyEncrypted: state === "S4" ? "operator-key-present" : null,
    },
  });
  const ownKey = state !== "S3" && state !== "S4";
  const suffix = `${state.toLowerCase()}-${counter++}`;
  const user = await prisma.user.create({
    data: {
      username: `jobs-${suffix}`,
      email: `jobs-${suffix}@example.test`,
      timezone: "UTC",
      locale: "en",
      heightCm: 180,
      disableCoach: state === "S5",
      modulePreferencesJson: state === "S6" ? { insights: false } : undefined,
      aiProviderChain: ownKey
        ? [{ providerType: "anthropic", enabled: true }]
        : undefined,
      aiAnthropicKeyEncrypted: ownKey ? "key-present" : null,
    },
  });

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  await prisma.measurement.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: 82 - i * 0.05,
      unit: "kg",
      source: "MANUAL" as const,
      measuredAt: new Date(now - i * DAY),
    })),
  });

  const workout = await prisma.workout.create({
    data: {
      userId: user.id,
      sportType: "cycling",
      startedAt: new Date(now - 2 * 60 * 60 * 1000),
      endedAt: new Date(now - 60 * 60 * 1000),
      durationSec: 3600,
      source: "APPLE_HEALTH",
      externalId: `workout-${suffix}`,
    },
  });

  const occurredAt = new Date(now - 5 * 60 * 1000);
  const localDate = userDayKey(new Date(now), "UTC");
  await prisma.arrivalReaction.create({
    data: { userId: user.id, kind: "weight", localDate, occurredAt },
  });

  // Long enough that the rolling summary has turns to fold, and over an hour
  // old so the memory refresh finds the conversation quiet and does its work
  // instead of deferring.
  const conversation = await prisma.coachConversation.create({
    data: { userId: user.id, title: "long conversation" },
  });
  await prisma.coachMessage.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({
      conversationId: conversation.id,
      role: i % 2 === 0 ? "user" : "assistant",
      encryptedContent: encryptToBytes(`turn ${i}: about sleep and walks`),
      createdAt: new Date(now - (100 - i) * 60_000),
    })),
  });

  return {
    userId: user.id,
    workoutId: workout.id,
    reaction: {
      userId: user.id,
      kind: "weight" as const,
      localDate,
      revision: occurredAt.toISOString(),
    },
    conversationId: conversation.id,
  };
}

type Seeded = Awaited<ReturnType<typeof seedState>>;

interface Worker {
  name: string;
  /** Which states must stop it. */
  refusedIn: readonly State[];
  run: (s: Seeded) => Promise<unknown>;
  /** Whether the worker wrote model text for this account. */
  wroteText: (s: Seeded) => Promise<boolean>;
  /** The skip annotation it records when refused. */
  skipAnnotation: string;
}

const ANALYSIS_REFUSED: readonly State[] = ["S1", "S3", "S4", "S6"];
const COACH_REFUSED: readonly State[] = ["S1", "S3", "S4", "S5"];

const WORKERS: Worker[] = [
  {
    name: "insight-status-generate (statusText)",
    refusedIn: ANALYSIS_REFUSED,
    run: (s) =>
      runInsightStatusGenerate({
        userId: s.userId,
        metric: "weight",
        locale: "en",
        authority: {
          origin: "owner",
          recordUserId: s.userId,
          actorUserId: s.userId,
          grantId: null,
        },
      }),
    wroteText: async (s) =>
      (await getPrismaClient().insightStatusCache.count({
        where: { userId: s.userId, textEncrypted: { not: null } },
      })) > 0,
    skipAnnotation: "insights.status.generate.skipped",
  },
  {
    name: "nightly status batch (statusText)",
    refusedIn: ANALYSIS_REFUSED,
    run: (s) => generateStatusBatchForUser(s.userId, { locale: "en" }),
    wroteText: async (s) =>
      (await getPrismaClient().insightStatusCache.count({
        where: { userId: s.userId, textEncrypted: { not: null } },
      })) > 0,
    skipAnnotation: "insights.status.batch.skipped",
  },
  {
    name: "workout-insight-generate (workoutInsights)",
    refusedIn: ANALYSIS_REFUSED,
    run: (s) =>
      runWorkoutInsightGenerate({ userId: s.userId, workoutId: s.workoutId }),
    wroteText: async (s) =>
      (await getPrismaClient().workoutInsight.count({
        where: { userId: s.userId },
      })) > 0,
    skipAnnotation: "workouts.insight.skipped",
  },
  {
    name: "reaction-line (reactionLines)",
    refusedIn: ANALYSIS_REFUSED,
    run: (s) => runReactionLine(s.reaction),
    wroteText: async (s) =>
      (await getPrismaClient().arrivalReaction.count({
        where: { userId: s.userId, lineEncrypted: { not: null } },
      })) > 0,
    skipAnnotation: "arrival.reaction.skipped",
  },
  {
    name: "coach-memory-refresh (coach)",
    refusedIn: COACH_REFUSED,
    run: (s) =>
      runCoachMemoryRefresh({
        conversationId: s.conversationId,
        userId: s.userId,
        locale: "en",
      }),
    wroteText: async (s) =>
      (await getPrismaClient().coachConversation.count({
        where: { id: s.conversationId, summaryEncrypted: { not: null } },
      })) > 0,
    skipAnnotation: "coach.memory.refresh.skipped",
  },
];

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  providerSpy.mockClear();
  annotations.length = 0;
});

describe.each(WORKERS)("$name", (worker) => {
  it("calls the provider under S0 (the spy can see a call)", async () => {
    const seeded = await seedState("S0");
    await worker.run(seeded);
    expect(providerSpy).toHaveBeenCalled();
    expect(annotations).not.toContain(worker.skipAnnotation);
  });

  it.each(worker.refusedIn)(
    "never reaches the provider and writes nothing under %s",
    async (state) => {
      const seeded = await seedState(state);
      await worker.run(seeded);
      expect(providerSpy).not.toHaveBeenCalled();
      expect(await worker.wroteText(seeded)).toBe(false);
      expect(annotations).toContain(worker.skipAnnotation);
    },
  );
});

describe("the Coach and the analysis are separate opt-outs", () => {
  it("hiding the Coach does not stop the status notes", async () => {
    const seeded = await seedState("S5");
    await WORKERS[0].run(seeded);
    expect(providerSpy).toHaveBeenCalled();
  });

  it("switching AI analysis off does not stop the Coach memory", async () => {
    const seeded = await seedState("S6");
    await WORKERS[4].run(seeded);
    expect(providerSpy).toHaveBeenCalled();
  });
});
