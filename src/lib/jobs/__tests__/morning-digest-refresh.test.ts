import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { runMorningDigestRefresh } from "../morning-digest-refresh";
import { MORNING_DIGEST_REFRESH_EXPIRE_SECONDS } from "../morning-digest-refresh-shared";
import {
  COMPREHENSIVE_WARM_CEILING_MS,
  comprehensiveWarmBudgetMs,
} from "../model-time";
import { QUEUE_RUNTIME } from "../queue-runtime";
import { COMPREHENSIVE_MODEL_CALLS } from "@/lib/ai/ai-budgets";
import { AI_RESPONSE_TIMEOUT_MAX_SECONDS } from "@/lib/ai/effective-timeout";
import type { GenerateOutcome } from "@/lib/insights/comprehensive-generate";

const LOCAL_DATE = "2026-07-16";

function makePrisma(
  user: {
    locale: string | null;
    morningDigestRefreshedOn: string | null;
    aiResponseTimeoutSeconds?: number | null;
  } | null,
) {
  const updateMock = vi.fn(async () => ({}));
  const prisma = {
    user: {
      findUnique: vi.fn(async () => user),
      update: updateMock,
    },
  };
  return { prisma, updateMock };
}

/** The handler over the stand-in client. */
function refresh(
  prisma: ReturnType<typeof makePrisma>["prisma"],
  ...rest: Parameters<typeof runMorningDigestRefresh> extends [
    unknown,
    ...infer R,
  ]
    ? R
    : never
) {
  return runMorningDigestRefresh(prisma as never, ...rest);
}

describe("runMorningDigestRefresh", () => {
  const retryMock = vi.fn(async () => {});

  beforeEach(() => {
    retryMock.mockReset();
  });

  it("regenerates and stamps the marker → finalises the day", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(async (): Promise<GenerateOutcome> => ({
      status: "generated",
      providerType: "mock",
    }));

    const result = await refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { morningDigestRefreshedOn: LOCAL_DATE },
    });
    expect(result.status).toBe("finalised");
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("finalises on an `unchanged` regen (content-hash no-op is still fresh)", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "de",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(async (): Promise<GenerateOutcome> => ({
      status: "unchanged",
    }));

    const result = await refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "de",
      force: true,
      signal: expect.any(AbortSignal),
    });
    expect(updateMock).toHaveBeenCalled();
    expect(result).toEqual({ status: "finalised", comprehensive: "unchanged" });
  });

  it("finalises a keyless user (`skipped` no-provider) — nothing to wait for", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(async (): Promise<GenerateOutcome> => ({
      status: "skipped",
      reason: "no-provider",
    }));

    const result = await refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(updateMock).toHaveBeenCalled();
    expect(result.status).toBe("finalised");
  });

  it("is idempotent: a second run for the same morning no-ops via the marker", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: LOCAL_DATE,
    });
    const generate = vi.fn(async (): Promise<GenerateOutcome> => ({
      status: "generated",
      providerType: "mock",
    }));

    const result = await refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.status).toBe("already-final");
  });

  it("leaves the day provisional on a hard generation failure and hands off to the retry machinery", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(async (): Promise<GenerateOutcome> => ({
      status: "failed",
      reason: "provider-timeout",
    }));

    const result = await refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(updateMock).not.toHaveBeenCalled();
    expect(retryMock).toHaveBeenCalledWith({ userId: "u1", locale: "en" });
    expect(result.status).toBe("failed");
  });

  it("reports missing-user when the row is gone", async () => {
    const { prisma, updateMock } = makePrisma(null);
    const generate = vi.fn(async (): Promise<GenerateOutcome> => ({
      status: "unchanged",
    }));

    const result = await refresh(
      prisma,
      { userId: "ghost", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.status).toBe("missing-user");
  });
});

describe("runMorningDigestRefresh — a slow model under a large setting (#1274)", () => {
  const retryMock = vi.fn(async () => {});

  beforeEach(() => {
    vi.useFakeTimers();
    retryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for every call of the generation, not one", async () => {
    // Five calls in a row at 290 s each under a 300 s setting.
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
      aiResponseTimeoutSeconds: 300,
    });
    const generate = vi.fn(
      () =>
        new Promise<GenerateOutcome>((resolve) =>
          setTimeout(
            () => resolve({ status: "generated", providerType: "local" }),
            COMPREHENSIVE_MODEL_CALLS * 290_000,
          ),
        ),
    );
    const pending = refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );
    await vi.advanceTimersByTimeAsync(COMPREHENSIVE_MODEL_CALLS * 290_000);
    await expect(pending).resolves.toEqual({
      status: "finalised",
      comprehensive: "generated",
    });
    expect(updateMock).toHaveBeenCalled();
  });

  it("aborts a wedged generation at the bound and leaves the day provisional", async () => {
    const { prisma, updateMock } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
      aiResponseTimeoutSeconds: 600,
    });
    let signal: AbortSignal | undefined;
    const generate = vi.fn(
      (_userId: string, options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise<GenerateOutcome>(() => {});
      },
    );
    const pending = refresh(
      prisma,
      { userId: "u1", localDate: LOCAL_DATE },
      { generate, enqueueRetry: retryMock },
    );
    await vi.advanceTimersByTimeAsync(comprehensiveWarmBudgetMs(600));
    await expect(pending).resolves.toEqual({
      status: "failed",
      comprehensive: "failed",
    });
    expect(signal?.aborted).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
    expect(retryMock).toHaveBeenCalledWith({ userId: "u1", locale: "en" });
  });

  it("rethrows a generator fault so the queue retries it", async () => {
    const { prisma } = makePrisma({
      locale: "en",
      morningDigestRefreshedOn: null,
    });
    const generate = vi.fn(async (): Promise<GenerateOutcome> => {
      throw new Error("pool exhausted");
    });
    await expect(
      refresh(
        prisma,
        { userId: "u1", localDate: LOCAL_DATE },
        { generate, enqueueRetry: retryMock },
      ),
    ).rejects.toThrow("pool exhausted");
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("the job's expiry sits above the longest generation the largest setting allows", () => {
    // pg-boss fails and retries a job past its expiry while the handler keeps
    // going; the default fifteen minutes is below five ten-minute calls.
    expect(COMPREHENSIVE_WARM_CEILING_MS).toBeGreaterThanOrEqual(
      AI_RESPONSE_TIMEOUT_MAX_SECONDS * 1000 * COMPREHENSIVE_MODEL_CALLS,
    );
    expect(comprehensiveWarmBudgetMs(AI_RESPONSE_TIMEOUT_MAX_SECONDS)).toBe(
      COMPREHENSIVE_WARM_CEILING_MS,
    );
    expect(MORNING_DIGEST_REFRESH_EXPIRE_SECONDS * 1000).toBeGreaterThan(
      COMPREHENSIVE_WARM_CEILING_MS,
    );
    expect(QUEUE_RUNTIME["morning-digest-refresh"]).toMatchObject({
      runtime: "bounded",
      expireInSeconds: MORNING_DIGEST_REFRESH_EXPIRE_SECONDS,
    });
  });
});
