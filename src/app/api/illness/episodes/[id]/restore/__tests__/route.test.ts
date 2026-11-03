/**
 * v1.18.3 — POST /api/illness/episodes/{id}/restore.
 *
 * The delete-Undo affordance: clears `deletedAt` so the episode and its
 * preserved day-logs re-surface. Owner-scoped (a foreign id 404s, never a
 * write), born-gated, and idempotent (restoring a live episode is a no-op).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    illnessEpisode: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/illness/gate", () => ({ requireIllnessEnabled: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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
import { auditLog } from "@/lib/auth/audit";
import { requireIllnessEnabled } from "@/lib/illness/gate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const PARAMS = { params: Promise.resolve({ id: "ep-1" }) };

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ep-1",
    userId: "user-1",
    label: "Erkältung",
    type: "INFECTION",
    lifecycle: "ACUTE",
    onsetAt: new Date("2026-06-01T00:00:00.000Z"),
    resolvedAt: null,
    parentConditionId: null,
    noteEncrypted: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/illness/episodes/ep-1/restore", {
    method: "POST",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireIllnessEnabled).mockResolvedValue({ enabled: true });
});

describe("POST /api/illness/episodes/{id}/restore", () => {
  it("clears deletedAt on a tombstoned owned episode and returns it", async () => {
    vi.mocked(prisma.illnessEpisode.findUnique).mockResolvedValue({
      id: "ep-1",
      userId: "user-1",
      deletedAt: new Date("2026-06-16T00:00:00.000Z"),
    } as never);
    vi.mocked(prisma.illnessEpisode.update).mockResolvedValue(
      liveRow() as never,
    );
    vi.mocked(prisma.illnessEpisode.findUniqueOrThrow).mockResolvedValue(
      liveRow() as never,
    );

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("ep-1");

    // The flag flip clears deletedAt; the row (and its day-logs) come back.
    expect(vi.mocked(prisma.illnessEpisode.update)).toHaveBeenCalledWith({
      where: { id: "ep-1" },
      data: { deletedAt: null },
    });
    expect(vi.mocked(auditLog)).toHaveBeenCalledWith(
      "illness.episode.restore",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("is idempotent — restoring a live episode writes nothing", async () => {
    vi.mocked(prisma.illnessEpisode.findUnique).mockResolvedValue({
      id: "ep-1",
      userId: "user-1",
      deletedAt: null,
    } as never);
    vi.mocked(prisma.illnessEpisode.findUniqueOrThrow).mockResolvedValue(
      liveRow() as never,
    );

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.illnessEpisode.update)).not.toHaveBeenCalled();
    expect(vi.mocked(auditLog)).not.toHaveBeenCalled();
  });

  it("404s for a foreign episode without writing", async () => {
    vi.mocked(prisma.illnessEpisode.findUnique).mockResolvedValue({
      id: "ep-1",
      userId: "someone-else",
      deletedAt: new Date(),
    } as never);

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.illnessEpisode.update)).not.toHaveBeenCalled();
  });

  it("404s for an unknown episode", async () => {
    vi.mocked(prisma.illnessEpisode.findUnique).mockResolvedValue(
      null as never,
    );

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(404);
    expect(vi.mocked(prisma.illnessEpisode.update)).not.toHaveBeenCalled();
  });

  it("refuses when the illness module is disabled", async () => {
    vi.mocked(requireIllnessEnabled).mockResolvedValue({
      enabled: false,
      response: new Response("nope", { status: 403 }),
    } as never);

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(403);
    expect(vi.mocked(prisma.illnessEpisode.findUnique)).not.toHaveBeenCalled();
  });
});
