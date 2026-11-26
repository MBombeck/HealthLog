/**
 * #1404 — the `ai.job.failed` line names how long the job ran. It used to
 * read duration_ms=0 on a job that had been running for ten minutes, because
 * the line's own builder was the only thing timed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    aiJobFailure: {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: vi.fn(),
  logCaught: vi.fn(),
}));

import { emitSignal } from "@/lib/logging/signal";
import { trackAiJob } from "../report";
import { noteAiJobFailure } from "../witness";

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(emitSignal).mockReset();
});

describe("trackAiJob", () => {
  it("writes the job's own running time on its failure line", async () => {
    vi.useFakeTimers();
    const run = trackAiJob(
      { userId: "u1", job: "documentSummary", documentId: "d1" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 600_000));
        noteAiJobFailure("budget_exhausted");
      },
    );
    await vi.advanceTimersByTimeAsync(600_000);
    await run;
    const line = vi
      .mocked(emitSignal)
      .mock.calls.map(([input]) => input)
      .find((input) => input.action === "ai.job.failed");
    expect(line?.durationMs).toBeGreaterThanOrEqual(600_000);
  });
});
