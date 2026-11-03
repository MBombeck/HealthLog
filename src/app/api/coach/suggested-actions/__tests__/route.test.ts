/**
 * v1.22 — `POST /api/coach/suggested-actions`.
 *
 * Covers the closed allowlist confirm endpoint:
 *   - checkup.create builds a Vorsorge MeasurementReminder field-by-field
 *     (origin COACH, server-resolved RRULE from the closed interval id).
 *   - reminder.note builds a CoachReminder field-by-field (source action).
 *   - an off-allowlist actionType (e.g. medication.create) 422s — the moat
 *     never auto-applies or mints an arbitrary entity.
 *   - the owner is always the session user (no IDOR, no body userId).
 *   - the coach module gate runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurementReminder: { create: vi.fn() },
    coachReminder: { count: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    resetAt: Date.now() + 1000,
  })),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(`enc:${s}`)),
}));
vi.mock("@/lib/measurement-reminders/scheduling", () => ({
  // Now-anchored: the fixed 2027 date was a fuse — on that day the mocked
  // next-due flipped from future to past and every due/overdue assertion
  // downstream inverted.
  computeReminderNextDueAt: vi.fn(
    () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  ),
}));
vi.mock("@/lib/measurement-reminders/dto", () => ({
  toMeasurementReminderDto: vi.fn((r: { id: string }) => ({ id: r.id })),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "t",
    role: "USER" as const,
    displayName: null,
  },
};

const call = (body: unknown) =>
  (POST as unknown as (req: Request) => Promise<Response>)(
    new NextRequest("http://localhost/api/coach/suggested-actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
});

describe("POST /api/coach/suggested-actions", () => {
  it("checkup.create builds a Vorsorge reminder field-by-field (origin COACH, server RRULE)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Europe/Berlin",
    } as never);
    vi.mocked(prisma.measurementReminder.create).mockResolvedValue({
      id: "mr1",
    } as never);

    const res = await call({
      actionType: "checkup.create",
      label: "Annual blood panel",
      interval: "yearly",
    });
    expect(res.status).toBe(201);
    const data = vi.mocked(prisma.measurementReminder.create).mock.calls[0]?.[0]
      ?.data as {
      userId: string;
      origin: string;
      rrule: string;
      measurementType: null;
      label: string;
    };
    expect(data.userId).toBe("user-1"); // owner from session, never the body
    expect(data.origin).toBe("COACH");
    expect(data.rrule).toBe("FREQ=YEARLY;INTERVAL=1");
    expect(data.measurementType).toBeNull();
    expect(data.label).toBe("Annual blood panel");
    expect(requireModuleEnabled).toHaveBeenCalledWith("user-1", "coach");
  });

  it("reminder.note builds a CoachReminder field-by-field (source action)", async () => {
    vi.mocked(prisma.coachReminder.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.coachReminder.create).mockResolvedValue({
      id: "cr1",
    } as never);

    const res = await call({
      actionType: "reminder.note",
      note: "revisit evening walk",
      when: "+14d",
      metric: "SLEEP",
    });
    expect(res.status).toBe(201);
    const data = vi.mocked(prisma.coachReminder.create).mock.calls[0]?.[0]
      ?.data as {
      userId: string;
      source: string;
      status: string;
    };
    expect(data.userId).toBe("user-1");
    expect(data.source).toBe("action");
    expect(data.status).toBe("active");
  });

  it("422s an off-allowlist actionType — never auto-applies a clinical/med change", async () => {
    const res = await call({
      actionType: "medication.create",
      label: "start a drug",
      interval: "monthly",
    });
    expect(res.status).toBe(422);
    expect(prisma.measurementReminder.create).not.toHaveBeenCalled();
    expect(prisma.coachReminder.create).not.toHaveBeenCalled();
  });

  it("403s when the coach module is disabled", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await call({
      actionType: "reminder.note",
      note: "x",
    });
    expect(res.status).toBe(403);
  });
});
