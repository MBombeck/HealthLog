/**
 * GET /api/notifications/status route tests.
 *
 * Pins the SB-6 v1.4.40 contract — the response carries BOTH the
 * existing `channels` array (channel reliability state for the Settings
 * page) AND a new `events` map keyed by event-type whose values shape
 * `{ lastDeliveredAt: ISO8601 | null }`. The iOS NotificationsScreen
 * reads `events` to render "last delivered Xh ago" per category.
 *
 * Stability rules pinned here so a future refactor can't silently
 * regress them:
 *   1. 401 when unauthenticated (no DB lookup).
 *   2. Every known EventType is present in the map, even for an
 *      empty-state user — value defaults to `{ lastDeliveredAt: null }`.
 *   3. `MOOD_REMINDER.lastDeliveredAt` reads the latest
 *      `MoodReminderDispatch.dispatchedAt` and serialises it as ISO8601.
 *   4. The existing `channels` array shape is untouched (backwards-
 *      compatible — the Settings card still works against this route).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(),
    },
    moodReminderDispatch: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

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
import { EVENT_TYPES } from "@/lib/notifications/types";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([]);
  vi.mocked(prisma.moodReminderDispatch.findFirst).mockResolvedValue(null);
});

describe("GET /api/notifications/status — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(401);
    // DB must not be touched before auth succeeds.
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(prisma.moodReminderDispatch.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/notifications/status — events map", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  });

  it("empty-state user gets every known category with null", async () => {
    const res = await (GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        channels: unknown[];
        events: Record<string, { lastDeliveredAt: string | null }>;
      };
    };
    expect(body.data.channels).toEqual([]);
    // Every known event-type must be present so iOS doesn't have to
    // special-case missing keys.
    for (const ev of EVENT_TYPES) {
      expect(body.data.events).toHaveProperty(ev);
      expect(body.data.events[ev]).toEqual({ lastDeliveredAt: null });
    }
  });

  it("populates MOOD_REMINDER.lastDeliveredAt from the latest dispatch row", async () => {
    const dispatchedAt = new Date("2026-05-17T22:00:00.000Z");
    vi.mocked(prisma.moodReminderDispatch.findFirst).mockResolvedValueOnce({
      dispatchedAt,
    } as never);

    const res = await (GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        events: Record<string, { lastDeliveredAt: string | null }>;
      };
    };

    expect(body.data.events.MOOD_REMINDER.lastDeliveredAt).toBe(
      dispatchedAt.toISOString(),
    );
    // Other categories still null — no cross-contamination.
    expect(body.data.events.MEDICATION_REMINDER.lastDeliveredAt).toBeNull();
    expect(body.data.events.MEASUREMENT_ANOMALY.lastDeliveredAt).toBeNull();
    // Scoped to the calling user.
    expect(prisma.moodReminderDispatch.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { dispatchedAt: "desc" },
      select: { dispatchedAt: true },
    });
  });
});

describe("GET /api/notifications/status — channels shape (backwards compat)", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  });

  it("keeps the existing channel-array shape so the Settings card keeps working", async () => {
    // Fixture mirrors the Prisma `NotificationChannel` row shape the
    // route reads. The Settings card destructures `data.channels`, so
    // adding `events` must NOT shift the channels payload.
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      {
        id: "ch-1",
        userId: "user-1",
        type: "APNS",
        enabled: true,
        disabledReason: null,
        consecutiveFailures: 0,
        lastSuccessAt: new Date("2026-05-17T20:00:00.000Z"),
        lastFailureAt: null,
        lastFailureReason: null,
        nextRetryAt: null,
      },
    ] as never);

    const res = await (GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        channels: Array<{
          id: string;
          type: string;
          state: string;
          lastSuccessAt: string | null;
        }>;
        events: Record<string, { lastDeliveredAt: string | null }>;
      };
    };
    expect(body.data.channels).toHaveLength(1);
    expect(body.data.channels[0]).toMatchObject({
      id: "ch-1",
      type: "APNS",
      state: "active",
      lastSuccessAt: "2026-05-17T20:00:00.000Z",
    });
    // `events` lives alongside `channels` so old consumers ignore the
    // new key automatically.
    expect(body.data.events).toBeDefined();
  });
});
