/**
 * Daily-briefing fallback cron: tz slot-gating + result accounting, plus
 * the dead-queue wiring guard read off the worker registry (declared,
 * scheduled, bound) and the morning push the finalised refresh fires.
 */
import { describe, it, expect, vi } from "vitest";

const { runMorningDigestRefresh, maybeDispatchPush } = vi.hoisted(() => ({
  runMorningDigestRefresh: vi.fn(),
  maybeDispatchPush: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/jobs/morning-digest-refresh", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/morning-digest-refresh")
  >()),
  runMorningDigestRefresh,
}));
vi.mock("@/lib/daily/daily-briefing-push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/daily/daily-briefing-push")>()),
  maybeDispatchDailyBriefing: maybeDispatchPush,
}));
vi.mock("@/lib/jobs/reminder/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/reminder/shared")>()),
  getWorkerPrisma: () => ({}),
}));
import type { PrismaClient } from "@/generated/prisma/client";

import { runDailyBriefingTick } from "@/lib/jobs/daily-briefing";
import {
  DAILY_BRIEFING_QUEUE,
  DAILY_BRIEFING_CRON,
} from "@/lib/jobs/daily-briefing-queue";
import type { maybeDispatchDailyBriefing } from "@/lib/daily/daily-briefing-push";
import type { MorningDigestRefreshPayload } from "@/lib/jobs/morning-digest-refresh-shared";
import {
  handleDailyBriefing,
  handleMorningDigestRefresh,
} from "@/lib/jobs/reminder/status-handlers";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import type { Job } from "pg-boss";

// 06:00Z → 08:00 Berlin (the fallback hour) but 02:00 in New York (not the
// slot), so a mixed-tz cohort exercises the per-user local-hour gate.
const NOW = new Date("2026-07-16T06:00:00Z");

function makePrisma(
  cohort: Array<{ userId: string; timezone: string }>,
): PrismaClient {
  return {
    notificationPreference: {
      findMany: vi.fn(async () =>
        cohort.map((c) => ({
          channel: { userId: c.userId, user: { timezone: c.timezone } },
        })),
      ),
    },
  } as unknown as PrismaClient;
}

describe("runDailyBriefingTick — slot gating", () => {
  it("only calls the dispatch seam for users at their local fallback hour", async () => {
    const prisma = makePrisma([
      { userId: "berlin", timezone: "Europe/Berlin" }, // 08:00 → in slot
      { userId: "ny", timezone: "America/New_York" }, // 02:00 → not slot
    ]);
    const maybeDispatch = vi.fn<typeof maybeDispatchDailyBriefing>(
      async () => "sent",
    );

    const summary = await runDailyBriefingTick(prisma, NOW, { maybeDispatch });

    expect(summary.candidatesScanned).toBe(2);
    expect(summary.inSlot).toBe(1);
    expect(summary.sent).toBe(1);
    expect(maybeDispatch).toHaveBeenCalledTimes(1);
    expect(maybeDispatch.mock.calls[0][1]).toBe("berlin");
  });

  it("routes each dispatch result into its summary bucket", async () => {
    const prisma = makePrisma([
      { userId: "berlin", timezone: "Europe/Berlin" },
    ]);
    const maybeDispatch = vi.fn<typeof maybeDispatchDailyBriefing>(
      async () => "suppressed-frequency",
    );

    const summary = await runDailyBriefingTick(prisma, NOW, { maybeDispatch });
    expect(summary.suppressedFrequency).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it("an empty opted-in cohort is a clean no-op", async () => {
    const prisma = makePrisma([]);
    const maybeDispatch = vi.fn<typeof maybeDispatchDailyBriefing>(
      async () => "sent",
    );
    const summary = await runDailyBriefingTick(prisma, NOW, { maybeDispatch });
    expect(summary.candidatesScanned).toBe(0);
    expect(maybeDispatch).not.toHaveBeenCalled();
  });
});

describe("daily-briefing registration", () => {
  function refreshJob(): Job<MorningDigestRefreshPayload> {
    return {
      id: "j1",
      name: "morning-digest-refresh",
      data: { userId: "u1", localDate: "2026-07-16" },
      expireInSeconds: 60,
      heartbeatSeconds: null,
      retryCount: 0,
      signal: new AbortController().signal,
    };
  }

  it("declares the queue in the status group and schedules the cron", () => {
    expect(groupOf(DAILY_BRIEFING_QUEUE).name).toBe("status");
    const job = jobOf(DAILY_BRIEFING_QUEUE);
    expect(job.cron).toBe(DAILY_BRIEFING_CRON);
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("binds the handler that runs the tick", async () => {
    expect(await loadedHandler(DAILY_BRIEFING_QUEUE)).toBe(handleDailyBriefing);
  });

  it("fires the finalisation-hook push after a finalised morning refresh", async () => {
    runMorningDigestRefresh.mockResolvedValueOnce({ status: "finalised" });
    await handleMorningDigestRefresh([refreshJob()]);
    expect(maybeDispatchPush).toHaveBeenCalledTimes(1);
    expect(maybeDispatchPush).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      expect.any(Date),
    );

    maybeDispatchPush.mockClear();
    runMorningDigestRefresh.mockResolvedValueOnce({ status: "already-final" });
    await handleMorningDigestRefresh([refreshJob()]);
    expect(maybeDispatchPush).not.toHaveBeenCalled();
  });

  it("uses an every-15-min cron for the fallback slot", () => {
    expect(DAILY_BRIEFING_QUEUE).toBe("daily-briefing");
    expect(DAILY_BRIEFING_CRON).toBe("*/15 * * * *");
  });
});
