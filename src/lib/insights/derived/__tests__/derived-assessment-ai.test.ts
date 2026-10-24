/**
 * v1.30.3 — the derived-score AI warm layer must roll its cache over
 * at the USER's own midnight (not Berlin's) and label the prompt's date line
 * with the user's actual tz (not a hardcoded "(Europe/Berlin)").
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock("@/lib/insights/status-cache", () => ({
  readFreshStatusText: vi.fn(),
  resolveReadOnlyStatusMiss: vi.fn(),
  statusCacheAction: (scope: string, locale: string) =>
    `insights.${scope}-status.${locale}`,
  computeStatusInputFingerprint: vi.fn().mockResolvedValue("hash"),
  gateUnchangedStatusInput: vi.fn().mockResolvedValue(null),
}));

const persistTimeoutNegativeStub = vi.fn();
vi.mock("@/lib/insights/timeout-fallback", () => ({
  persistTimeoutNegativeStub: (...a: unknown[]) =>
    persistTimeoutNegativeStub(...a),
}));

const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (a: unknown) => findUnique(a) } },
}));

import {
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
} from "@/lib/insights/status-cache";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  resolveDerivedAssessment,
  generateDerivedScoreAssessment,
} from "../derived-assessment-ai";
import type { Derived } from "../types";

const RECOVERY_VALUE = {
  score: 70,
  band: "green" as const,
  trendDelta: null,
  daysInWindow: 10,
  asOf: "2026-06-20T12:00:00.000Z",
  series: [],
};

function okDerived(): Derived<unknown> {
  return {
    status: "ok",
    value: RECOVERY_VALUE,
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
    },
    confidence: { score: 90, band: "high" },
    provenance: {
      inputs: ["RECOVERY_SCORE"],
      source: "DAY",
      windowDays: 30,
      computedAt: "x",
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  findUnique.mockResolvedValue({ timezone: "America/New_York" });
});

describe("resolveDerivedAssessment — per-user tz (QA F5)", () => {
  it("resolves the user's own tz before reading the cache", async () => {
    vi.mocked(readFreshStatusText).mockResolvedValue(null);

    await resolveDerivedAssessment({
      metric: "RECOVERY_SCORE",
      userId: "u-ny",
      derived: okDerived(),
      locale: "en",
      aiAvailable: true,
      now: new Date("2026-06-20T23:30:00.000Z"), // Berlin: 06-21 already
    });

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-ny" } }),
    );
    // The cache read must have run with the NY calendar day (06-20), not the
    // Berlin one (06-21) — the fixed pre-fix behaviour.
    const call = vi.mocked(readFreshStatusText).mock.calls[0][0] as {
      todayKey: string;
    };
    expect(call.todayKey).toBe("2026-06-20");
  });
});

describe("resolveDerivedAssessment — AI unavailable", () => {
  it("serves the deterministic text and neither reads stored model text nor warms", async () => {
    // A fresh cached AI assessment exists: it must still not be served.
    vi.mocked(readFreshStatusText).mockResolvedValue({
      text: "model prose",
      updatedAt: "2026-06-20T08:00:00.000Z",
    } as never);

    const result = await resolveDerivedAssessment({
      metric: "RECOVERY_SCORE",
      userId: "u-ny",
      derived: okDerived(),
      locale: "en",
      aiAvailable: false,
      now: new Date("2026-06-20T12:00:00.000Z"),
    });

    expect(result).not.toBeNull();
    expect(result?.source).not.toBe("ai");
    expect(result?.text).not.toBe("model prose");
    expect(readFreshStatusText).not.toHaveBeenCalled();
    expect(resolveReadOnlyStatusMiss).not.toHaveBeenCalled();
  });

  it("serves the stored model text while AI is available", async () => {
    vi.mocked(readFreshStatusText).mockResolvedValue({
      text: "model prose",
      updatedAt: "2026-06-20T08:00:00.000Z",
    } as never);

    const result = await resolveDerivedAssessment({
      metric: "RECOVERY_SCORE",
      userId: "u-ny",
      derived: okDerived(),
      locale: "en",
      aiAvailable: true,
      now: new Date("2026-06-20T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ text: "model prose", source: "ai" });
  });
});

describe("generateDerivedScoreAssessment — per-user tz label (QA F5)", () => {
  it("labels the prompt's date line with the user's actual tz, not a hardcoded Berlin", async () => {
    let capturedPrompt = "";
    vi.mocked(runStatusCompletion).mockImplementation(async (args) => {
      capturedPrompt = (args as { userPrompt: string }).userPrompt;
      return { kind: "none" } as never;
    });

    await generateDerivedScoreAssessment({
      metric: "RECOVERY_SCORE",
      userId: "u-ny",
      derived: okDerived(),
      locale: "en",
      now: new Date("2026-06-20T23:30:00.000Z"),
    });

    expect(capturedPrompt).toContain("(America/New_York)");
    expect(capturedPrompt).not.toContain("(Europe/Berlin)");
  });
});

describe("generateDerivedScoreAssessment — a failed generation (#1279)", () => {
  it("opens the note's negative window, so the next sync does not ask again", async () => {
    vi.mocked(runStatusCompletion).mockResolvedValue({ kind: "error" });

    const result = await generateDerivedScoreAssessment({
      metric: "RECOVERY_SCORE",
      userId: "u-ny",
      derived: okDerived(),
      locale: "en",
      now: new Date("2026-06-20T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ kind: "error", retryable: true });
    expect(persistTimeoutNegativeStub).toHaveBeenCalledWith({
      userId: "u-ny",
      cacheAction: "insights.derived-score:RECOVERY_SCORE-status.en",
      todayKey: "2026-06-20",
      reason: "error",
    });
  });
});
