/**
 * v1.18.1 — eventful Vorsorge satisfaction.
 *
 *   1. `enqueueReminderSatisfy` — a thin wrapper around the global boss,
 *      a silent no-op when no worker is attached (mirrors enqueuePrDetection).
 *   2. `runReminderSatisfyForUser` — resolves a user's live reminders
 *      against their just-landed measurement / lab via the shared
 *      primitives, honouring the module toggle and the forward-only guard.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
let bossInstance: { send: typeof sendMock } | null = { send: sendMock };

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => bossInstance,
}));

// The Coach context-cue evaluation rides this hook; its behaviour is pinned
// in `src/lib/ai/coach/__tests__/context-reminders.test.ts`. Stubbed here so
// the Vorsorge assertions stay isolated; one test below pins that the hook
// actually fires (watched red: removing the call site in
// `runReminderSatisfyForUser` fails it).
const { evaluateContextMock } = vi.hoisted(() => ({
  evaluateContextMock: vi.fn(async (..._args: unknown[]) => ({
    surfaced: 0,
    errored: 0,
  })),
}));
vi.mock("@/lib/ai/coach/context-reminders", () => ({
  evaluateCoachContextReminders: evaluateContextMock,
}));

import {
  enqueueReminderSatisfy,
  REMINDER_SATISFY_QUEUE,
} from "../reminder-satisfy";
import { runReminderSatisfyForUser } from "../measurement-reminder";

describe("enqueueReminderSatisfy", () => {
  beforeEach(() => {
    sendMock.mockReset();
    bossInstance = { send: sendMock };
  });

  it("sends a job carrying the userId to the satisfy queue", async () => {
    await enqueueReminderSatisfy("u1");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![0]).toBe(REMINDER_SATISFY_QUEUE);
    expect(sendMock.mock.calls[0]![1]).toMatchObject({ userId: "u1" });
  });

  it("is a silent no-op when no boss is attached (tests / web process)", async () => {
    bossInstance = null;
    await expect(enqueueReminderSatisfy("u1")).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

const TZ = "Europe/Berlin";

function makePrisma(opts: {
  reminders: Array<Record<string, unknown>>;
  measurement?: { measuredAt: Date } | null;
  lab?: { takenAt: Date } | null;
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ timezone: TZ })) },
    measurementReminder: {
      findMany: vi.fn(async () => opts.reminders),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          updates.push({ id: where.id, data });
          return { id: where.id, ...data };
        },
      ),
      // v1.18.1 — `satisfyReminder` now writes via a conditional `updateMany`
      // (forward-only TOCTOU close). Record the write + report a hit.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          updates.push({ id: where.id, data });
          return { count: 1 };
        },
      ),
    },
    // v1.37.20 (#223 / iOS #68) — the primitive appends a ledger row per
    // applied satisfy; the harness records them so tests can assert one.
    measurementReminderEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "evt",
        ...data,
      })),
    },
    measurement: { findFirst: vi.fn(async () => opts.measurement ?? null) },
    labResult: { findFirst: vi.fn(async () => opts.lab ?? null) },
  };
  return { prisma, updates };
}

function reminderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    userId: "u1",
    measurementType: "WEIGHT",
    intervalDays: 7,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    nextDueAt: null,
    lastSatisfiedAt: null,
    lastSkippedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("runReminderSatisfyForUser", () => {
  it("satisfies a typed reminder eventfully when a matching reading landed", async () => {
    const measuredAt = new Date("2026-06-14T18:00:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [reminderRow()],
      measurement: { measuredAt },
    });

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date("2026-06-14T20:00:00Z"),
      { isModuleEnabled: vi.fn(async () => true) },
    );

    expect(summary.satisfied).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(measuredAt);
  });

  it("satisfies a free-text reminder from a LabResult (D2)", async () => {
    const takenAt = new Date("2026-06-15T09:00:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [reminderRow({ measurementType: null, intervalDays: 365 })],
      lab: { takenAt },
    });

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date("2026-06-15T12:00:00Z"),
    );

    expect(summary.satisfied).toBe(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(takenAt);
  });

  it("produces no engine activity for a disabled module", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [reminderRow({ measurementType: "BLOOD_GLUCOSE" })],
      measurement: { measuredAt: new Date("2026-06-14T18:00:00Z") },
    });
    const isModuleEnabled = vi.fn(async () => false);

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date(),
      { isModuleEnabled },
    );

    expect(summary.skippedModuleDisabled).toBe(1);
    expect(summary.satisfied).toBe(0);
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "glucose");
    expect(updates).toHaveLength(0);
    // The matcher never runs for a gated reminder.
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
  });

  it("leaves a ketone checkup alone while the Glucose module is off", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [reminderRow({ measurementType: "BLOOD_KETONES" })],
      measurement: { measuredAt: new Date("2026-06-14T18:00:00Z") },
    });
    const isModuleEnabled = vi.fn(async () => false);

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date(),
      { isModuleEnabled },
    );

    expect(summary.skippedModuleDisabled).toBe(1);
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "glucose");
    expect(updates).toHaveLength(0);
  });

  it("satisfies a screening reminder from the server-written score row (v1.27.6)", async () => {
    // A completed PHQ-9 check-in writes a COMPUTED PHQ9_SCORE measurement;
    // the screening reminder resolves from that row like any typed reminder.
    const measuredAt = new Date("2026-07-01T10:00:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [
        reminderRow({ measurementType: "PHQ9_SCORE", intervalDays: 28 }),
      ],
      measurement: { measuredAt },
    });
    const isModuleEnabled = vi.fn(async () => true);

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date("2026-07-01T12:00:00Z"),
      { isModuleEnabled },
    );

    expect(summary.satisfied).toBe(1);
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "mentalHealth");
    expect(updates[0].data.lastSatisfiedAt).toEqual(measuredAt);
  });

  it("satisfies the WHO-5 / SCI screening reminders on the identical contract (v1.27.9)", async () => {
    for (const measurementType of ["WHO5_SCORE", "SCI_SCORE"]) {
      const measuredAt = new Date("2026-07-01T10:00:00Z");
      const { prisma, updates } = makePrisma({
        reminders: [reminderRow({ measurementType, intervalDays: 28 })],
        measurement: { measuredAt },
      });
      const isModuleEnabled = vi.fn(async () => true);

      const summary = await runReminderSatisfyForUser(
        prisma as never,
        "u1",
        new Date("2026-07-01T12:00:00Z"),
        { isModuleEnabled },
      );

      expect(summary.satisfied, `${measurementType} should satisfy`).toBe(1);
      expect(isModuleEnabled).toHaveBeenCalledWith("u1", "mentalHealth");
      expect(updates[0].data.lastSatisfiedAt).toEqual(measuredAt);
    }
  });

  it("produces no engine activity for a screening reminder when the mental-health module is off", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [
        reminderRow({ measurementType: "GAD7_SCORE", intervalDays: 28 }),
      ],
      measurement: { measuredAt: new Date("2026-07-01T10:00:00Z") },
    });
    const isModuleEnabled = vi.fn(async () => false);

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date(),
      { isModuleEnabled },
    );

    expect(summary.skippedModuleDisabled).toBe(1);
    expect(summary.satisfied).toBe(0);
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "mentalHealth");
    expect(updates).toHaveLength(0);
  });

  it("evaluates the Coach context cues on the same ingest event", async () => {
    const now = new Date("2026-06-14T20:00:00Z");
    const { prisma } = makePrisma({ reminders: [] });
    evaluateContextMock.mockClear();
    evaluateContextMock.mockResolvedValueOnce({ surfaced: 2, errored: 0 });

    const summary = await runReminderSatisfyForUser(prisma as never, "u1", now);

    expect(evaluateContextMock).toHaveBeenCalledWith(
      prisma,
      "u1",
      "measurement",
      now,
    );
    expect(summary.coachContextSurfaced).toBe(2);
  });

  it("never fails the Vorsorge resolution over a Coach context error", async () => {
    const measuredAt = new Date("2026-06-14T18:00:00Z");
    const { prisma } = makePrisma({
      reminders: [reminderRow()],
      measurement: { measuredAt },
    });
    evaluateContextMock.mockClear();
    evaluateContextMock.mockRejectedValueOnce(new Error("coach down"));

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date("2026-06-14T20:00:00Z"),
      { isModuleEnabled: vi.fn(async () => true) },
    );

    expect(summary.satisfied).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("is forward-only: a stale event is a no-op (cron + hook converge)", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [
        reminderRow({ lastSatisfiedAt: new Date("2026-06-20T08:00:00Z") }),
      ],
      measurement: { measuredAt: new Date("2026-06-10T08:00:00Z") },
    });

    const summary = await runReminderSatisfyForUser(
      prisma as never,
      "u1",
      new Date(),
    );

    expect(summary.satisfied).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
