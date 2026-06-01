import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn() },
  },
}));

const hasUsableStatusProvider = vi.fn();
vi.mock("@/lib/insights/status-provider", () => ({
  hasUsableStatusProvider: (...a: unknown[]) => hasUsableStatusProvider(...a),
}));

const enqueueStatusGeneration = vi.fn();
vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: (...a: unknown[]) => enqueueStatusGeneration(...a),
}));

import { prisma } from "@/lib/db";
import {
  isTimeoutStub,
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
} from "../status-cache";

const TODAY = "2026-05-31";

function cacheRow(details: Record<string, unknown>, createdAt = new Date()) {
  return { createdAt, details: JSON.stringify(details) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isTimeoutStub", () => {
  it("flags the timeout-stub model marker", () => {
    expect(isTimeoutStub({ model: "timeout-stub" })).toBe(true);
  });

  it("flags the timeout:true marker", () => {
    expect(isTimeoutStub({ timeout: true })).toBe(true);
  });

  it("does not flag a real assessment", () => {
    expect(isTimeoutStub({ model: "gpt-4o-mini", timeout: false })).toBe(false);
    expect(isTimeoutStub({})).toBe(false);
  });
});

describe("readFreshStatusText", () => {
  it("returns today's real assessment text", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        text: "Your weight trend is stable.",
        model: "gpt-4o-mini",
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit?.text).toBe("Your weight trend is stable.");
  });

  it("skips a timeout-stub row keyed to today", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        text: "Generic fallback advice.",
        model: "timeout-stub",
        timeout: true,
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("skips a stale-day row", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({ dateKey: "2026-05-30", text: "Yesterday." }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("skips an empty-text row", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({ dateKey: TODAY, text: "   " }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("does not read the cache under force", async () => {
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: true,
    });
    expect(hit).toBeNull();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it("treats a malformed payload as a miss", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: new Date(),
      details: "{not json",
    } as never);
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });
});

describe("resolveReadOnlyStatusMiss", () => {
  it("returns no-provider without enqueuing when the user has no provider", async () => {
    hasUsableStatusProvider.mockResolvedValue(false);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(outcome).toBe("no-provider");
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("enqueues generation and returns preparing on a clean miss", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    // No negative stub present.
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
    expect(outcome).toBe("preparing");
    expect(enqueueStatusGeneration).toHaveBeenCalledWith({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
  });

  it("suppresses re-enqueue while a fresh timeout stub exists", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        timeout: true,
        model: "timeout-stub",
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "mood",
      locale: "en",
    });
    expect(outcome).toBe("preparing");
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("re-enqueues once the negative stub's retryAt has passed", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        timeout: true,
        model: "timeout-stub",
        retryAt: new Date(Date.now() - 60_000).toISOString(),
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "bmi",
      locale: "de",
    });
    expect(outcome).toBe("preparing");
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(1);
  });
});
