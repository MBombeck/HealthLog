import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "../memory";

beforeEach(() => {
  vi.mocked(prisma.auditLog.findFirst).mockReset();
});

describe("getPreviousInsightContext", () => {
  it("returns null when no audit row exists", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce(null);
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx).toBeNull();
  });

  it("returns null when the audit row's details cannot be parsed", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      createdAt: new Date(),
      details: "",
    } as never);
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx).toBeNull();
  });

  it("extracts text from the JSON-shaped cache payload", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      createdAt: sevenDaysAgo,
      details: JSON.stringify({
        dateKey: "2026-05-01",
        text: "Your BP averaged 130/80 — high-normal.",
      }),
    } as never);
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx).not.toBeNull();
    expect(ctx!.ageDays).toBe(7);
    expect(ctx!.text).toContain("130/80");
  });

  it("falls back to raw audit details when not JSON", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 86_400_000),
      details: "Plain text from a legacy cache row.",
    } as never);
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx?.text).toBe("Plain text from a legacy cache row.");
  });

  it("caps the text length so a verbose snapshot cannot bloat the prompt", async () => {
    const big = "x".repeat(5000);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 86_400_000),
      details: JSON.stringify({ text: big }),
    } as never);
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx!.text.length).toBeLessThanOrEqual(1502); // 1500 + "…"
    expect(ctx!.text.endsWith("…")).toBe(true);
  });

  it("filters by minAgeHours so today's earlier run isn't treated as 'previous'", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce(null);
    await getPreviousInsightContext("u-1", "general-status", "en", 24);
    const call = vi.mocked(prisma.auditLog.findFirst).mock.calls[0]?.[0];
    expect(call?.where?.action).toBe("insights.general-status.en");
    // The lt filter exists with a date in the past. It can't be more
    // than 24h ago because we just constructed it; allow a 30s slack.
    const lt = (call?.where?.createdAt as { lt: Date }).lt;
    expect(Date.now() - lt.getTime()).toBeGreaterThan(
      24 * 60 * 60 * 1000 - 30_000,
    );
    expect(Date.now() - lt.getTime()).toBeLessThan(
      24 * 60 * 60 * 1000 + 30_000,
    );
  });
});

describe("formatPreviousContextForPrompt", () => {
  it("returns a 'no history' instruction when ctx is null (English)", () => {
    const out = formatPreviousContextForPrompt(null, "en");
    expect(out).toContain("PREVIOUS ANALYSIS: none on file");
    expect(out).toContain("no improvement/regression delta to surface");
  });

  it("returns a 'no history' instruction when ctx is null (German)", () => {
    const out = formatPreviousContextForPrompt(null, "de");
    expect(out).toContain("VORHERIGE ANALYSE: keine vorhanden");
  });

  it("formats a 7-days-ago context with date + text + comparison instruction (English)", () => {
    const out = formatPreviousContextForPrompt(
      {
        generatedAt: "2026-05-01T08:00:00.000Z",
        ageDays: 7,
        text: "Your BP averaged 130/80 last week.",
      },
      "en",
    );
    expect(out).toContain("PREVIOUS ANALYSIS (7 days ago, 2026-05-01)");
    expect(out).toContain("Your BP averaged 130/80 last week.");
    expect(out).toContain('"down 4 mmHg from your last check"');
  });

  it("formats a same-day context (German)", () => {
    const out = formatPreviousContextForPrompt(
      {
        generatedAt: "2026-05-08T06:00:00.000Z",
        ageDays: 0,
        text: "Frühanalyse: 130/80 grenzwertig.",
      },
      "de",
    );
    expect(out).toContain("VORHERIGE ANALYSE (heute früher, 2026-05-08)");
    expect(out).toContain("Frühanalyse: 130/80 grenzwertig.");
  });
});
