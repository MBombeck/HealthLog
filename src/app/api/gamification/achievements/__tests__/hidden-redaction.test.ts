import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    passkey: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    userAchievement: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "marc",
    role: "USER" as const,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    heightCm: null,
    locale: "en",
  },
};

const HIDDEN_TRIGGER_STRINGS = [
  "nightOwlCount",
  "earlyBirdCount",
  "leapDayCount",
  "doctorPdfCount",
  "localeFlipCount",
  "hiddenNightOwl",
  "hiddenEarlyBird",
  "hiddenLeapDay",
  "hiddenDoctorPdf",
  "hiddenLocaleFlip",
  "hiddenBugBuddy",
];

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.34 IW-G — reset achievement LRU between tests so each case
  // observes a cold cache.
  __resetAllCachesForTests();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.passkey.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userAchievement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userAchievement.createMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/gamification/achievements — hidden achievement redaction", () => {
  it("does NOT leak hidden trigger strings in the default JSON response when locked", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const probe of HIDDEN_TRIGGER_STRINGS) {
      expect(raw, `leak: ${probe}`).not.toContain(probe);
    }
  });

  it("does NOT leak hidden trigger strings in the iOS response when locked", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/gamification/achievements?format=ios",
      ),
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const probe of HIDDEN_TRIGGER_STRINGS) {
      expect(raw, `iOS leak: ${probe}`).not.toContain(probe);
    }
    // Also assert the resolved description text is not in the body for
    // a fresh user (the iOS branch resolves keys server-side).
    expect(raw).not.toContain("between 02:00 and 04:00");
    expect(raw).not.toContain("between 04:00 and 06:00");
    expect(raw).not.toContain("February 29");
    expect(raw).not.toContain("doctor report");
    expect(raw).not.toContain("Switched the app language");
  });

  it("preserves hidden achievement entries in the response (count not zero) so the user knows hidden ones exist", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        achievements: Array<{
          id: string;
          isHidden: boolean;
          unlocked: boolean;
          category: string;
        }>;
      };
    };
    const hiddenEntries = body.data.achievements.filter(
      (a) => a.category === "hidden" || a.isHidden,
    );
    expect(hiddenEntries.length).toBeGreaterThan(0);
    // every hidden+locked entry must be locked AND must have isHidden:true
    for (const entry of hiddenEntries) {
      expect(entry.isHidden).toBe(true);
      expect(entry.unlocked).toBe(false);
    }
  });

  it("hidden+locked entries do not include metric, titleKey, descriptionKey, or icon trigger names", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        achievements: Array<{
          id: string;
          isHidden: boolean;
          unlocked: boolean;
          metric?: string;
          titleKey?: string;
          descriptionKey?: string;
          icon?: string;
          target?: number;
          current?: number;
          progressPercent?: number;
          points?: number;
        }>;
      };
    };
    const hiddenLocked = body.data.achievements.filter(
      (a) => a.isHidden && !a.unlocked,
    );
    expect(hiddenLocked.length).toBeGreaterThan(0);
    for (const entry of hiddenLocked) {
      // Trigger semantics scrubbed
      expect(entry.metric ?? "").not.toMatch(
        /(nightOwl|earlyBird|leapDay|doctorPdf|localeFlip|bugReport)Count/,
      );
      // i18n keys scrubbed
      expect(entry.titleKey ?? "").not.toContain("hiddenNightOwl");
      expect(entry.titleKey ?? "").not.toContain("hiddenEarlyBird");
      expect(entry.titleKey ?? "").not.toContain("hiddenLeapDay");
      expect(entry.titleKey ?? "").not.toContain("hiddenDoctorPdf");
      expect(entry.titleKey ?? "").not.toContain("hiddenLocaleFlip");
      expect(entry.titleKey ?? "").not.toContain("hiddenBugBuddy");
      // Icon names that hint at the trigger scrubbed
      expect(entry.icon ?? "").not.toMatch(/^(Moon|Sun|Sparkles|Languages)$/);
    }
  });

  it("does not include hidden-only metric counters in the metrics block when hidden achievements are locked", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        metrics: Record<string, unknown>;
      };
    };
    expect(body.data.metrics).toBeDefined();
    // Hidden-only metric names must not appear as keys
    for (const probe of [
      "nightOwlCount",
      "earlyBirdCount",
      "leapDayCount",
      "doctorPdfCount",
      "localeFlipCount",
    ]) {
      expect(body.data.metrics).not.toHaveProperty(probe);
    }
  });
});
